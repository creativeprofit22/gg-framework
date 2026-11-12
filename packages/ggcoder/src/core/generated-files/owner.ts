import { lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  assertNoCaseCollisions,
  canonicalJson,
  canonicalRepositoryRoot,
  compareText,
  containedPath,
  normalizeRepositoryPath,
  rejectLinks,
  sha256,
} from "../tauri-package/paths.js";

export interface GeneratedFile {
  path: string;
  bytes: Buffer;
  template_sha256: string;
  content_sha256: string;
}

export interface EmbeddedMarker {
  templateVersion: number;
  templateSha256: string;
  contentSha256: string;
}

/** Ownership proven by a marker inside the file (comment syntax chosen by the generator). */
export interface EmbeddedMarkerOwnership {
  kind: "embedded-marker";
  parse: (content: string) => EmbeddedMarker | null;
  templateVersion: number;
  /** Digest of the content normalised around its embedded digest field. */
  digest: (content: string) => string;
}

/** Ownership proven by `.gg/programmatic/generated/<ownerId>.json`; works for any format. */
export interface SideRecordOwnership {
  kind: "side-record";
  /** Files stamped by an older embedded-marker generator stay recognised and are adopted. */
  legacyMarker?: EmbeddedMarkerOwnership;
}

export interface GeneratedSetSpec {
  ownerId: string;
  /** Every path this owner may write, repository-relative POSIX. */
  paths: readonly string[];
  /** All paths are present together or none are. */
  completeSet: boolean;
  /**
   * Paths whose bytes legitimately change after generation. They are not compared against a
   * fresh render: embedded-marker commits do not refuse them for differing bytes, and
   * `verifyGeneratedSet` does not list them as stale. Side-record commits replace owned,
   * unedited files regardless of this list.
   */
  byteCompareExempt: readonly string[];
  /** Lock file stem; the lock is `<tmpdir>/<lockName>-<sha256(lowercased root)>.lock`. */
  lockName: string;
  /** Temporary-file infix used by atomic writes, e.g. `.gg-tauri-`. */
  tempPrefix: string;
  /** Human label used in refusal messages, e.g. `Tauri support`. */
  label: string;
  ownership: SideRecordOwnership | EmbeddedMarkerOwnership;
  messages?: {
    busy?: string;
    incomplete?: string;
  };
}

export type GeneratedSetState = "absent" | "owned" | "conflict";

export interface GeneratedSetInspection {
  state: GeneratedSetState;
  conflicts: string[];
  files: GeneratedFile[];
}

export interface CommitOptions {
  revalidate?: () => Promise<void>;
  onPreMutation?: (repositoryPath: string) => Promise<void> | void;
  onCommitted?: (repositoryPath: string) => Promise<void> | void;
  afterWrite?: (repositoryPath: string, index: number) => Promise<void> | void;
  /**
   * Runs inside the lock after every file and the record are written (for example a
   * project check). Throwing rolls the whole set back exactly like a failed write.
   */
  afterAllWrites?: () => Promise<void>;
}

/**
 * `busy`: another action holds the lock. `refused`: conflicts, nothing written.
 * `write-failed`: a write or `afterAllWrites` failed and the set was rolled back;
 * `rollbackIncomplete` is true when some paths could not be restored.
 */
export class GeneratedSetCommitError extends Error {
  constructor(
    message: string,
    readonly code: "busy" | "refused" | "write-failed",
    readonly rollbackIncomplete = false,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "GeneratedSetCommitError";
  }
}

export type GeneratedFilePreviewAction = "create" | "change" | "unchanged" | "skip" | "conflict";

export interface GeneratedFilePreview {
  path: string;
  action: GeneratedFilePreviewAction;
  reason?: string;
  /** SHA-256 of the bytes currently on disk, when a file exists. */
  priorSha256?: string;
}

export interface GeneratedSetVerification {
  ok: boolean;
  stale: string[];
  conflicts: string[];
}

export const GENERATED_RECORD_DIRECTORY = ".gg/programmatic/generated";
export const GENERATED_RECORD_SCHEMA_VERSION = 1;

const OWNER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DIGEST = /^[a-f0-9]{64}$/;

const RecordEntrySchema = z.strictObject({
  path: z.string().min(1),
  template_sha256: z.string().regex(DIGEST),
  content_sha256: z.string().regex(DIGEST),
});

const RecordSchema = z.strictObject({
  schema_version: z.literal(GENERATED_RECORD_SCHEMA_VERSION),
  owner: z.string().regex(OWNER_ID),
  files: z.array(RecordEntrySchema),
});

type RecordEntry = z.infer<typeof RecordEntrySchema>;

interface InspectionDetail extends GeneratedSetInspection {
  /** Parsed side-record entries keyed by path (side-record ownership only). */
  record: Map<string, RecordEntry> | null;
}

export function generatedRecordPath(ownerId: string): string {
  if (!OWNER_ID.test(ownerId)) throw new Error(`Invalid generated-file owner id: ${ownerId}`);
  return `${GENERATED_RECORD_DIRECTORY}/${ownerId}.json`;
}

export function renderGeneratedRecord(ownerId: string, files: readonly RecordEntry[]): Buffer {
  const sorted = [...files].sort((left, right) => compareText(left.path, right.path));
  return Buffer.from(
    canonicalJson({
      schema_version: GENERATED_RECORD_SCHEMA_VERSION,
      owner: ownerId,
      files: sorted.map((file) => ({
        path: file.path,
        template_sha256: file.template_sha256,
        content_sha256: file.content_sha256,
      })),
    }),
    "utf8",
  );
}

export async function inspectGeneratedSet(
  repositoryRoot: string,
  spec: GeneratedSetSpec,
  expected?: readonly GeneratedFile[],
): Promise<GeneratedSetInspection> {
  const { state, conflicts, files } = await inspectDetail(repositoryRoot, spec, expected);
  return { state, conflicts, files };
}

export async function commitGeneratedSet(
  repositoryRoot: string,
  spec: GeneratedSetSpec,
  rendered: readonly GeneratedFile[],
  options: CommitOptions = {},
): Promise<{ changed: boolean; paths: string[] }> {
  assertRender(spec, rendered);
  const root = await canonicalRepositoryRoot(repositoryRoot);
  return withRepositoryLock(root, spec, async () => {
    const inspection = await inspectDetail(root, spec, rendered);
    if (inspection.state === "conflict") {
      throw new GeneratedSetCommitError(
        `Refusing to overwrite ${spec.label} files:\n${inspection.conflicts.join("\n")}`,
        "refused",
      );
    }
    const recordPath =
      spec.ownership.kind === "side-record" ? generatedRecordPath(spec.ownerId) : null;
    const nextRecord = recordPath ? nextRecordBytes(spec, inspection, rendered) : null;
    const currentRecord = recordPath ? await readOptional(containedPath(root, recordPath)) : null;
    if (
      inspection.state === "owned" &&
      rendered.every((file) =>
        inspection.files.find((current) => current.path === file.path)?.bytes.equals(file.bytes),
      ) &&
      sameBytes(currentRecord, nextRecord)
    ) {
      return { changed: false, paths: [] };
    }

    const planned = rendered.map((file) => ({ path: file.path, bytes: file.bytes }));
    if (recordPath && nextRecord && !sameBytes(currentRecord, nextRecord)) {
      planned.push({ path: recordPath, bytes: nextRecord });
    }
    const snapshots = new Map<string, Buffer | null>();
    for (const repositoryPath of [...spec.paths, ...(recordPath ? [recordPath] : [])]) {
      snapshots.set(repositoryPath, await readOptional(containedPath(root, repositoryPath)));
    }
    await options.revalidate?.();
    const written: string[] = [];
    try {
      for (const [index, file] of planned.entries()) {
        const current = await readOptional(containedPath(root, file.path));
        const snapshot = snapshots.get(file.path) ?? null;
        if (!sameBytes(current, snapshot))
          throw new Error(`Concurrent mutation detected: ${file.path}`);
        await options.onPreMutation?.(file.path);
        await atomicWrite(root, spec, file.path, file.bytes);
        written.push(file.path);
        await options.afterWrite?.(file.path, index);
      }
      await options.afterAllWrites?.();
    } catch (error) {
      const rollbackErrors = await rollback(root, spec, planned, snapshots, written);
      const suffix = rollbackErrors.length
        ? `\nRollback conflicts:\n${rollbackErrors.join("\n")}`
        : "";
      throw new GeneratedSetCommitError(
        `${errorMessage(error)}${suffix}`,
        "write-failed",
        rollbackErrors.length > 0,
        { cause: error },
      );
    }
    for (const repositoryPath of written) await options.onCommitted?.(repositoryPath);
    return { changed: true, paths: written };
  });
}

/** Check-only mode: render again, compare bytes, list stale outputs; writes nothing. */
export async function verifyGeneratedSet(
  repositoryRoot: string,
  spec: GeneratedSetSpec,
  expected: readonly GeneratedFile[],
): Promise<GeneratedSetVerification> {
  assertRender(spec, expected);
  const root = await canonicalRepositoryRoot(repositoryRoot);
  const inspection = await inspectDetail(root, spec);
  if (inspection.state === "conflict") {
    return { ok: false, stale: [], conflicts: inspection.conflicts };
  }
  const exempt = new Set(spec.byteCompareExempt);
  const onDisk = new Map(inspection.files.map((file) => [file.path, file.bytes]));
  const stale = expected
    .filter((file) => {
      const current = onDisk.get(file.path);
      if (!current) return true;
      return !exempt.has(file.path) && !current.equals(file.bytes);
    })
    .map((file) => file.path);
  if (spec.ownership.kind === "side-record") {
    const recordPath = generatedRecordPath(spec.ownerId);
    const currentRecord = await readOptional(containedPath(root, recordPath));
    const entries = inspection.files.map((file) => ({
      path: file.path,
      template_sha256: file.template_sha256,
      content_sha256: sha256(file.bytes),
    }));
    if (!sameBytes(currentRecord, renderGeneratedRecord(spec.ownerId, entries))) {
      stale.push(recordPath);
    }
  }
  stale.sort(compareText);
  return { ok: stale.length === 0, stale, conflicts: [] };
}

/**
 * Per-file check mode for a side-record set; reads only, never locks or writes.
 * `create`: absent. `change`: listed in this owner's record, unedited, new bytes.
 * `unchanged`: owned and identical. `skip`: unowned but byte-identical, left alone
 * and not adopted. `conflict`: unowned and different, hand-edited, linked, not a
 * regular file, or the record itself is invalid.
 */
export async function previewGeneratedSet(
  repositoryRoot: string,
  spec: GeneratedSetSpec,
  rendered: readonly GeneratedFile[],
): Promise<GeneratedFilePreview[]> {
  assertRender(spec, rendered);
  if (spec.ownership.kind !== "side-record") {
    throw new Error("Per-file preview supports side-record ownership only");
  }
  const root = await canonicalRepositoryRoot(repositoryRoot);
  const recordConflicts: string[] = [];
  const record = await readRecord(root, spec, recordConflicts);
  const results: GeneratedFilePreview[] = [];
  for (const file of [...rendered].sort((left, right) => compareText(left.path, right.path))) {
    const conflicts: string[] = [];
    const current = await readOwnedCandidate(root, file.path, conflicts);
    const prior = current ? { priorSha256: sha256(current) } : {};
    const conflict = (reason: string): GeneratedFilePreview => ({
      path: file.path,
      action: "conflict",
      reason,
      ...prior,
    });
    if (conflicts.length) {
      results.push(conflict(conflicts.join("; ")));
      continue;
    }
    if (recordConflicts.length) {
      results.push(conflict(recordConflicts.join("; ")));
      continue;
    }
    if (!current) {
      results.push({ path: file.path, action: "create" });
      continue;
    }
    const entry = record.get(file.path);
    if (entry) {
      if (sha256(current) !== entry.content_sha256) {
        results.push(conflict("owned file was edited outside the generator"));
      } else {
        results.push({
          path: file.path,
          action: current.equals(file.bytes) ? "unchanged" : "change",
          ...prior,
        });
      }
      continue;
    }
    const legacy = spec.ownership.legacyMarker;
    if (legacy && legacy.parse(current.toString("utf8"))) {
      const markerConflicts: string[] = [];
      // Adopted legacy files stay strict until recorded, exactly as in commit.
      const owned = ownedByMarker({ path: file.path, bytes: current }, legacy, markerConflicts);
      if (!owned) {
        results.push(conflict(markerConflicts.join("; ")));
      } else if (owned.template_sha256 !== file.template_sha256) {
        results.push(conflict("template digest mismatch"));
      } else if (current.equals(file.bytes)) {
        results.push({ path: file.path, action: "unchanged", ...prior });
      } else if (spec.byteCompareExempt.includes(file.path)) {
        results.push({ path: file.path, action: "change", ...prior });
      } else {
        results.push(conflict("owned file differs from the deterministic template"));
      }
      continue;
    }
    results.push(
      current.equals(file.bytes)
        ? {
            path: file.path,
            action: "skip",
            reason: "unowned file already has these exact bytes; left alone",
            ...prior,
          }
        : conflict(`not owned by ${spec.ownerId}; refusing to overwrite`),
    );
  }
  return results;
}

async function inspectDetail(
  repositoryRoot: string,
  spec: GeneratedSetSpec,
  expected?: readonly GeneratedFile[],
): Promise<InspectionDetail> {
  assertSpec(spec);
  const root = await canonicalRepositoryRoot(repositoryRoot);
  const present: Array<{ path: string; bytes: Buffer }> = [];
  const conflicts: string[] = [];
  for (const repositoryPath of spec.paths) {
    const bytes = await readOwnedCandidate(root, repositoryPath, conflicts);
    if (bytes) present.push({ path: repositoryPath, bytes });
  }

  let record: Map<string, RecordEntry> | null = null;
  if (spec.ownership.kind === "side-record") {
    record = await readRecord(root, spec, conflicts);
  }

  if (present.length === 0 && conflicts.length === 0) {
    return { state: "absent", conflicts: [], files: [], record };
  }
  if (spec.completeSet && (present.length !== spec.paths.length || conflicts.length)) {
    const presentPaths = new Set(present.map((file) => file.path));
    for (const repositoryPath of spec.paths) {
      if (
        !presentPaths.has(repositoryPath) &&
        !conflicts.some((entry) => entry.startsWith(`${repositoryPath}:`))
      ) {
        conflicts.push(`${repositoryPath}: missing from partial support set`);
      }
    }
    return { state: "conflict", conflicts: conflicts.sort(), files: [], record };
  }

  const expectedByPath = new Map(expected?.map((file) => [file.path, file]));
  const exempt = new Set(spec.byteCompareExempt);
  const files: GeneratedFile[] = [];
  for (const current of present) {
    const owned =
      spec.ownership.kind === "embedded-marker"
        ? ownedByMarker(current, spec.ownership, conflicts)
        : ownedBySideRecord(current, spec, record, conflicts);
    if (!owned) continue;
    // A side-record entry proves the bytes are unedited (ownedBySideRecord checked the digest),
    // so a new render may replace them. Embedded-marker sets have fixed templates per version
    // and the marker cannot prove the file was left alone, so they stay strict. Files adopted
    // through a legacy marker have no record yet, so they also stay strict until recorded.
    const strict = spec.ownership.kind === "embedded-marker" || !record?.has(current.path);
    if (!strict) {
      files.push(owned);
      continue;
    }
    const wanted = expectedByPath.get(current.path);
    if (wanted && !exempt.has(current.path) && !current.bytes.equals(wanted.bytes)) {
      conflicts.push(`${current.path}: owned file differs from the deterministic template`);
      continue;
    }
    if (wanted && owned.template_sha256 !== wanted.template_sha256) {
      conflicts.push(`${current.path}: template digest mismatch`);
      continue;
    }
    files.push(owned);
  }
  return conflicts.length
    ? { state: "conflict", conflicts: conflicts.sort(), files: [], record }
    : { state: files.length ? "owned" : "absent", conflicts: [], files, record };
}

async function readOwnedCandidate(
  root: string,
  repositoryPath: string,
  conflicts: string[],
): Promise<Buffer | null> {
  const absolute = containedPath(root, repositoryPath);
  try {
    const info = await stat(absolute);
    if (!info.isFile()) {
      conflicts.push(`${repositoryPath}: not a regular file`);
      return null;
    }
    await rejectLinks(root, repositoryPath);
    return await readFile(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      conflicts.push(`${repositoryPath}: ${errorMessage(error)}`);
    }
    return null;
  }
}

async function readRecord(
  root: string,
  spec: GeneratedSetSpec,
  conflicts: string[],
): Promise<Map<string, RecordEntry>> {
  const recordPath = generatedRecordPath(spec.ownerId);
  const bytes = await readOwnedCandidate(root, recordPath, conflicts);
  const entries = new Map<string, RecordEntry>();
  if (!bytes) return entries;
  let parsed: z.infer<typeof RecordSchema>;
  try {
    parsed = RecordSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch {
    conflicts.push(`${recordPath}: invalid ownership record`);
    return entries;
  }
  const allowed = new Set(spec.paths);
  if (
    parsed.owner !== spec.ownerId ||
    !bytes.equals(renderGeneratedRecord(spec.ownerId, parsed.files)) ||
    new Set(parsed.files.map((file) => file.path)).size !== parsed.files.length
  ) {
    conflicts.push(`${recordPath}: invalid ownership record`);
    return entries;
  }
  for (const entry of parsed.files) {
    if (!allowed.has(entry.path)) {
      conflicts.push(`${recordPath}: stale ownership record lists ${entry.path}`);
      continue;
    }
    entries.set(entry.path, entry);
  }
  return entries;
}

function ownedByMarker(
  current: { path: string; bytes: Buffer },
  ownership: EmbeddedMarkerOwnership,
  conflicts: string[],
): GeneratedFile | null {
  const content = current.bytes.toString("utf8");
  const marker = ownership.parse(content);
  if (!marker) {
    conflicts.push(`${current.path}: unknown or legacy generated marker`);
    return null;
  }
  if (marker.templateVersion !== ownership.templateVersion) {
    conflicts.push(`${current.path}: template version ${marker.templateVersion} is not current`);
    return null;
  }
  let calculated: string;
  try {
    calculated = ownership.digest(content);
  } catch (error) {
    conflicts.push(`${current.path}: ${errorMessage(error)}`);
    return null;
  }
  if (calculated !== marker.contentSha256) {
    conflicts.push(`${current.path}: content digest mismatch`);
    return null;
  }
  return {
    path: current.path,
    bytes: current.bytes,
    template_sha256: marker.templateSha256,
    content_sha256: marker.contentSha256,
  };
}

function ownedBySideRecord(
  current: { path: string; bytes: Buffer },
  spec: GeneratedSetSpec,
  record: Map<string, RecordEntry> | null,
  conflicts: string[],
): GeneratedFile | null {
  const entry = record?.get(current.path);
  if (entry) {
    if (sha256(current.bytes) !== entry.content_sha256) {
      conflicts.push(`${current.path}: owned file was edited outside the generator`);
      return null;
    }
    return {
      path: current.path,
      bytes: current.bytes,
      template_sha256: entry.template_sha256,
      content_sha256: entry.content_sha256,
    };
  }
  const legacy = spec.ownership.kind === "side-record" ? spec.ownership.legacyMarker : undefined;
  if (legacy && legacy.parse(current.bytes.toString("utf8"))) {
    const owned = ownedByMarker(current, legacy, conflicts);
    return owned && { ...owned, content_sha256: sha256(current.bytes) };
  }
  conflicts.push(`${current.path}: not owned by ${spec.ownerId}; refusing to overwrite`);
  return null;
}

function nextRecordBytes(
  spec: GeneratedSetSpec,
  inspection: InspectionDetail,
  rendered: readonly GeneratedFile[],
): Buffer {
  const entries = new Map<string, RecordEntry>();
  for (const file of inspection.files) {
    entries.set(file.path, {
      path: file.path,
      template_sha256: file.template_sha256,
      content_sha256: sha256(file.bytes),
    });
  }
  for (const file of rendered) {
    entries.set(file.path, {
      path: file.path,
      template_sha256: file.template_sha256,
      content_sha256: sha256(file.bytes),
    });
  }
  return renderGeneratedRecord(spec.ownerId, [...entries.values()]);
}

function assertSpec(spec: GeneratedSetSpec): void {
  if (!OWNER_ID.test(spec.ownerId)) {
    throw new Error(`Invalid generated-file owner id: ${spec.ownerId}`);
  }
  if (spec.paths.length === 0) throw new Error("Generated set must declare at least one path");
  for (const repositoryPath of spec.paths) normalizeRepositoryPath(repositoryPath);
  if (new Set(spec.paths).size !== spec.paths.length) {
    throw new Error("Generated set declares duplicate paths");
  }
  assertNoCaseCollisions(spec.paths);
  if (spec.ownership.kind === "side-record") {
    const recordPath = generatedRecordPath(spec.ownerId);
    assertNoCaseCollisions([...spec.paths, recordPath]);
    if (spec.paths.includes(recordPath)) {
      throw new Error("Generated set must not declare its own ownership record");
    }
  }
}

function assertRender(spec: GeneratedSetSpec, rendered: readonly GeneratedFile[]): void {
  assertSpec(spec);
  const paths = rendered.map((file) => file.path);
  if (
    spec.completeSet &&
    (paths.length !== spec.paths.length || spec.paths.some((item) => !paths.includes(item)))
  ) {
    throw new Error(
      spec.messages?.incomplete ?? `Renderer must provide the exact ${spec.label} set`,
    );
  }
  const allowed = new Set(spec.paths);
  const outside = paths.find((item) => !allowed.has(item));
  if (outside !== undefined) {
    throw new Error(`Renderer returned a path outside the ${spec.label} set: ${outside}`);
  }
  if (new Set(paths).size !== paths.length)
    throw new Error("Renderer returned duplicate support paths");
}

async function rollback(
  root: string,
  spec: GeneratedSetSpec,
  planned: ReadonlyArray<{ path: string; bytes: Buffer }>,
  snapshots: Map<string, Buffer | null>,
  written: string[],
): Promise<string[]> {
  const errors: string[] = [];
  const plannedByPath = new Map(planned.map((file) => [file.path, file.bytes]));
  for (const repositoryPath of [...written].reverse()) {
    try {
      const absolute = containedPath(root, repositoryPath);
      const current = await readOptional(absolute);
      if (!sameBytes(current, plannedByPath.get(repositoryPath) ?? null)) {
        errors.push(`${repositoryPath}: changed concurrently; left untouched`);
        continue;
      }
      const snapshot = snapshots.get(repositoryPath) ?? null;
      if (snapshot === null) await rm(absolute, { force: true });
      else await atomicWrite(root, spec, repositoryPath, snapshot);
    } catch (error) {
      errors.push(`${repositoryPath}: ${errorMessage(error)}`);
    }
  }
  return errors;
}

async function atomicWrite(
  root: string,
  spec: GeneratedSetSpec,
  repositoryPath: string,
  bytes: Buffer,
): Promise<void> {
  const absolute = containedPath(root, repositoryPath);
  await ensureSafeParent(root, repositoryPath);
  const temporary = `${absolute}${spec.tempPrefix}${process.pid}-${sha256(`${repositoryPath}:${Math.random()}`).slice(0, 12)}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, absolute);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function withRepositoryLock<T>(
  root: string,
  spec: GeneratedSetSpec,
  action: () => Promise<T>,
): Promise<T> {
  const lockPath = path.join(
    os.tmpdir(),
    `${spec.lockName}-${sha256(root.toLocaleLowerCase("en-US"))}.lock`,
  );
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
    await handle.writeFile(`${process.pid}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new GeneratedSetCommitError(
        spec.messages?.busy ?? `Another ${spec.label} action is active for this repository`,
        "busy",
        false,
        { cause: error },
      );
    }
    throw error;
  }
  try {
    return await action();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

async function readOptional(absolute: string): Promise<Buffer | null> {
  try {
    return await readFile(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function ensureSafeParent(root: string, repositoryPath: string): Promise<void> {
  const segments = repositoryPath.split("/").slice(0, -1);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const info = await stat(current);
      const linkInfo = await lstat(current);
      if (linkInfo.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`Unsafe generated-file parent: ${repositoryPath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current);
      const linkInfo = await lstat(current);
      if (linkInfo.isSymbolicLink() || !linkInfo.isDirectory()) {
        throw new Error(`Unsafe generated-file parent: ${repositoryPath}`, { cause: error });
      }
    }
  }
}

function sameBytes(left: Buffer | null, right: Buffer | null): boolean {
  return left === null ? right === null : right !== null && left.equals(right);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
