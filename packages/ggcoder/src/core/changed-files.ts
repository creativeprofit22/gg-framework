import fs from "node:fs/promises";
import path from "node:path";
import { BackgroundGitError } from "../utils/git.js";
import { compileCovers, toRepoRelative, type PathApi } from "./check-coverage.js";
import {
  boundedGit,
  hashWorkspaceFile,
  resolveWorkspaceRoot,
  statSignature,
  type HashBudget,
  type WorkspaceGit,
} from "./verification-snapshot.js";

export const CHANGED_FILES_MAX_MS = 1500;
export const CHANGED_FILES_MAX_ENTRIES = 5000;
export const CHANGED_FILES_MAX_BYTES = 64 * 1024 * 1024;
export const CHANGED_FILES_NOTE_MAX_PATHS = 8;
const STATUS_MAX_BUFFER = 4 * 1024 * 1024;
const NOTE_PATH_MAX_CHARS = 160;
const HASH_CACHE_MAX = 10_000;
const HASH_CONCURRENCY = 8;
const TOOL_WRITE_LOG_MAX = 1000;

/** One `git status --porcelain=v1 -z` record. `from` is the original path of a rename/copy. */
export interface PorcelainEntry {
  x: string;
  y: string;
  path: string;
  from?: string;
}

/**
 * Parse NUL-separated porcelain v1 output. Never trims: a leading space is the
 * index column (` M`), and paths may start or end with spaces. Rename and copy
 * records carry the original path as the next field. Throws on malformed input.
 */
export function parsePorcelainZ(stdout: string): PorcelainEntry[] {
  const fields = stdout.split("\0");
  const entries: PorcelainEntry[] = [];
  for (let index = 0; index < fields.length; index++) {
    const record = fields[index] ?? "";
    if (record === "" && index === fields.length - 1) break;
    if (record.length < 4 || record[2] !== " ") {
      throw new Error(`malformed porcelain record at field ${index}`);
    }
    const x = record.charAt(0);
    const y = record.charAt(1);
    const entryPath = record.slice(3);
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      index++;
      const from = fields[index];
      if (from === undefined || from === "") {
        throw new Error(`porcelain rename/copy record without an original path at field ${index}`);
      }
      entries.push({ x, y, path: entryPath, from });
    } else {
      entries.push({ x, y, path: entryPath });
    }
  }
  return entries;
}

type FileState =
  { kind: "missing" } | { kind: "file"; digest: string } | { kind: "other"; signature: string };

/** Caller-owned digest cache keyed by root and path, reused while lstat identity is unchanged. */
export type ChangedFilesHashCache = Map<string, { signature: string; state: FileState }>;

export interface ChangedFilesSkip {
  status: "skipped";
  reason: string;
  /** True for caps and time limits, which the model is told about. */
  limit: boolean;
}

export interface ChangedFilesState {
  status: "captured";
  root: string;
  head: string;
  /** Status records by path; a rename's original path gets a synthetic deletion. */
  entries: ReadonlyMap<string, readonly PorcelainEntry[]>;
  files: ReadonlyMap<string, FileState>;
  /** `git diff --name-status` letters between the previous and current HEAD. */
  headDiff: ReadonlyMap<string, string> | null;
  headDiffComplete: boolean;
}

/** Caller-owned workspace root for a fixed cwd; saves one git spawn per command. */
export interface ChangedFilesRootCache {
  /** `between`: canonical folders strictly between cwd and root, re-checked for a new `.git`. */
  value?: { root: string; cwdHasGit: boolean; between: readonly string[] };
}

async function gitMarkerExists(dir: string): Promise<boolean> {
  try {
    await fs.lstat(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function foldersBetween(cwd: string, root: string): Promise<string[] | null> {
  const relative = path.relative(root, await fs.realpath(cwd));
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const folders: string[] = [];
  let dir = path.dirname(path.join(root, relative));
  while (relative !== "" && dir !== root) {
    folders.push(dir);
    dir = path.dirname(dir);
  }
  return folders;
}

async function cachedRoot(
  cwd: string,
  git: WorkspaceGit,
  cache: ChangedFilesRootCache | undefined,
): Promise<string> {
  const cwdHasGit = await gitMarkerExists(cwd);
  const cached = cache?.value;
  // A repository created in cwd or any folder up to the root, or a removed one, invalidates it.
  if (cached && cached.cwdHasGit === cwdHasGit) {
    const [rootHasGit, ...between] = await Promise.all(
      [cached.root, ...cached.between].map(gitMarkerExists),
    );
    if (rootHasGit && !between.includes(true)) return cached.root;
  }
  const root = await resolveWorkspaceRoot(git);
  if (cache) {
    const between = await foldersBetween(cwd, root);
    cache.value = between ? { root, cwdHasGit, between } : undefined;
  }
  return root;
}

export interface ChangedFilesOptions {
  rootCache?: ChangedFilesRootCache;
  maxMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  cache?: ChangedFilesHashCache;
  signal?: AbortSignal;
  /** Before-state of the same command; the capture then also hashes its paths and HEAD diff. */
  previous?: ChangedFilesState;
}

export type ChangedKind = "created" | "modified" | "deleted" | "renamed";

export interface ChangedPath {
  path: string;
  kind: ChangedKind;
  from?: string;
}

export type ChangedFilesResult =
  | {
      status: "compared";
      root: string;
      paths: ChangedPath[];
      /** False when part of a HEAD move could not be listed. */
      complete: boolean;
      headMoved: boolean;
    }
  | ChangedFilesSkip;

class ChangedFilesLimit extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

function skipped(reason: string, limit = false): ChangedFilesSkip {
  return { status: "skipped", reason, limit };
}

function skipFor(error: unknown, maxMs: number): ChangedFilesSkip {
  if (error instanceof ChangedFilesLimit) return skipped(error.reason, true);
  if (error instanceof BackgroundGitError) {
    if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      return skipped("git status output over 4 MiB", true);
    }
    if (error.killed) return skipped(`timed out after ${maxMs} ms`, true);
    if (error.code === "ENOENT") return skipped("git unavailable");
    if (/not a git repository/i.test(error.stderr)) return skipped("not a git repository");
    return skipped("git status failed");
  }
  if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return skipped("git unavailable");
  return skipped("capture failed");
}

interface HashContext {
  root: string;
  deadline: number;
  maxMs: number;
  budget: HashBudget;
  cache: ChangedFilesHashCache | undefined;
}

async function readState(file: string, ctx: HashContext): Promise<FileState> {
  if (Date.now() > ctx.deadline) throw new ChangedFilesLimit(`timed out after ${ctx.maxMs} ms`);
  let stat;
  try {
    stat = await fs.lstat(path.join(ctx.root, file));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    throw error;
  }
  const signature = statSignature(stat);
  // Symlinks and submodule directories are compared by identity, not followed.
  if (!stat.isFile()) return { kind: "other", signature };
  const key = `${ctx.root}\0${file}`;
  const cached = ctx.cache?.get(key);
  if (cached !== undefined && cached.signature === signature) return cached.state;
  if (ctx.budget.bytes + stat.size > ctx.budget.maxBytes) {
    throw new ChangedFilesLimit(
      `dirty files over ${Math.round(ctx.budget.maxBytes / 1048576)} MiB`,
    );
  }
  const hashed = await hashWorkspaceFile(ctx.root, file, ctx.deadline, ctx.budget);
  if (Date.now() > ctx.deadline) throw new ChangedFilesLimit(`timed out after ${ctx.maxMs} ms`);
  if (hashed === null) return { kind: "other", signature };
  if (hashed.kind === "missing") return { kind: "missing" };
  const state: FileState = {
    kind: "file",
    digest: `${hashed.mode}:${hashed.digest.toString("hex")}`,
  };
  if (ctx.cache !== undefined && hashed.signature === signature) {
    if (ctx.cache.size >= HASH_CACHE_MAX) ctx.cache.clear();
    ctx.cache.set(key, { signature, state });
  }
  return state;
}

async function readStates(
  files: readonly string[],
  ctx: HashContext,
): Promise<Map<string, FileState>> {
  const states = new Map<string, FileState>();
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async (): Promise<void> => {
    while (failure === null && next < files.length) {
      const file = files[next++];
      if (file === undefined) return;
      try {
        states.set(file, await readState(file, ctx));
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(HASH_CONCURRENCY, files.length) }, () => worker()),
  );
  if (failure !== null) throw (failure as { error: unknown }).error;
  return new Map([...states].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)));
}

async function readHead(git: WorkspaceGit): Promise<string> {
  try {
    return (await git(["rev-parse", "--verify", "-q", "HEAD"])).trim();
  } catch (error) {
    // `--verify -q` exits 1 without output when the branch has no commit yet.
    if (error instanceof BackgroundGitError && error.code === 1 && !error.killed) return "unborn";
    throw error;
  }
}

async function readHeadDiff(
  git: WorkspaceGit,
  from: string,
  to: string,
  maxEntries: number,
): Promise<{ paths: Map<string, string>; complete: boolean }> {
  const paths = new Map<string, string>();
  // An unborn start had every file untracked, so the before-state already lists them.
  if (from === "unborn") return { paths, complete: true };
  if (to === "unborn") return { paths, complete: false };
  let stdout: string;
  try {
    stdout = await git(["diff", "--name-status", "-z", "--no-renames", from, to]);
  } catch {
    return { paths, complete: false };
  }
  const fields = stdout.split("\0");
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const letter = fields[index] ?? "";
    const file = fields[index + 1] ?? "";
    if (letter === "" || file === "") return { paths, complete: false };
    if (paths.size >= maxEntries) return { paths, complete: false };
    paths.set(file, letter.charAt(0));
  }
  return { paths, complete: true };
}

/**
 * Bounded capture of the repository's dirty paths and their content hashes.
 * Over a cap, outside Git, or on any failure it returns a skip with a fixed
 * reason instead of throwing.
 */
export async function captureChangedFilesState(
  cwd: string,
  options: ChangedFilesOptions = {},
): Promise<ChangedFilesState | ChangedFilesSkip> {
  const maxMs = options.maxMs ?? CHANGED_FILES_MAX_MS;
  const maxEntries = options.maxEntries ?? CHANGED_FILES_MAX_ENTRIES;
  const deadline = Date.now() + maxMs;
  try {
    const previous = options.previous;
    const root =
      previous?.root ??
      (await cachedRoot(cwd, boundedGit(cwd, deadline, options.signal), options.rootCache));
    const git = boundedGit(root, deadline, options.signal, STATUS_MAX_BUFFER);
    const [head, status] = await Promise.all([
      readHead(git),
      git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=dirty"]),
    ]);
    const parsed = parsePorcelainZ(status);
    if (parsed.length > maxEntries) {
      throw new ChangedFilesLimit(`more than ${maxEntries} changed paths`);
    }
    const entries = new Map<string, PorcelainEntry[]>();
    const add = (entry: PorcelainEntry): void => {
      const list = entries.get(entry.path);
      if (list) list.push(entry);
      else entries.set(entry.path, [entry]);
    };
    for (const entry of parsed) {
      add(entry);
      if (entry.from !== undefined && (entry.x === "R" || entry.y === "R")) {
        add({ x: "D", y: " ", path: entry.from });
      }
    }
    let headDiff: Map<string, string> | null = null;
    let headDiffComplete = true;
    if (previous !== undefined && previous.head !== head) {
      const diff = await readHeadDiff(git, previous.head, head, maxEntries);
      headDiff = diff.paths;
      headDiffComplete = diff.complete;
    }
    const toHash = new Set(entries.keys());
    for (const file of previous?.entries.keys() ?? []) toHash.add(file);
    for (const file of headDiff?.keys() ?? []) toHash.add(file);
    if (toHash.size > maxEntries * 2) {
      throw new ChangedFilesLimit(`more than ${maxEntries} changed paths`);
    }
    const files = await readStates([...toHash].sort(), {
      root,
      deadline,
      maxMs,
      budget: { bytes: 0, maxBytes: options.maxBytes ?? CHANGED_FILES_MAX_BYTES },
      cache: options.cache,
    });
    return { status: "captured", root, head, entries, files, headDiff, headDiffComplete };
  } catch (error) {
    return skipFor(error, maxMs);
  }
}

function sameState(left: FileState, right: FileState): boolean {
  if (left.kind === "missing" || right.kind === "missing") return left.kind === right.kind;
  if (left.kind === "file" && right.kind === "file") return left.digest === right.digest;
  if (left.kind === "other" && right.kind === "other") return left.signature === right.signature;
  return false;
}

export interface DiffChangedFilesOptions {
  /** Absolute or session-relative paths written by edit/write tools during the command. */
  excludePaths?: readonly string[];
  sessionCwd?: string;
  pathApi?: PathApi;
}

/**
 * Paths whose existence or content differs between two captures of the same
 * repository. Index-only operations (`git add`, `git commit`, `git rm --cached`)
 * change nothing on disk and are not reported.
 */
export function diffChangedFiles(
  before: ChangedFilesState,
  after: ChangedFilesState,
  options: DiffChangedFilesOptions = {},
): ChangedFilesResult {
  if (before.root !== after.root) return skipped("repository changed during the command");
  const headMoved = before.head !== after.head;
  const candidates = new Set([...before.entries.keys(), ...after.entries.keys()]);
  for (const file of after.headDiff?.keys() ?? []) candidates.add(file);
  const changes = new Map<string, ChangedPath>();
  for (const file of [...candidates].sort()) {
    const afterState = after.files.get(file);
    if (afterState === undefined) continue;
    const afterExists = afterState.kind !== "missing";
    const afterEntries = after.entries.get(file) ?? [];
    const beforeState = before.files.get(file);
    let beforeExists: boolean;
    let changed: boolean;
    if (beforeState !== undefined) {
      beforeExists = beforeState.kind !== "missing";
      changed = !sameState(beforeState, afterState);
    } else {
      // Clean before: the disk matched the old HEAD.
      const letter = headMoved ? after.headDiff?.get(file) : undefined;
      if (letter !== undefined) {
        beforeExists = letter !== "A";
        changed = true;
      } else {
        beforeExists =
          afterEntries.length === 0 ||
          !afterEntries.every((entry) => ["?", "A", "R", "C"].includes(entry.x));
        const indexOnly =
          afterExists && afterEntries.some((entry) => entry.x === "D" && entry.y === " ");
        changed = afterEntries.length > 0 && !indexOnly;
      }
    }
    if (!changed || (!beforeExists && !afterExists)) continue;
    const kind: ChangedKind = !beforeExists ? "created" : !afterExists ? "deleted" : "modified";
    changes.set(file, { path: file, kind });
  }
  for (const entries of after.entries.values()) {
    for (const entry of entries) {
      if (entry.from === undefined || (entry.x !== "R" && entry.y !== "R")) continue;
      const created = changes.get(entry.path);
      const deleted = changes.get(entry.from);
      if (created?.kind !== "created" || deleted?.kind !== "deleted") continue;
      changes.delete(entry.from);
      changes.set(entry.path, { path: entry.path, kind: "renamed", from: entry.from });
    }
  }
  const excluded = excludedSet(before.root, options);
  const paths = [...changes.values()]
    .filter(
      (change) =>
        !excluded.has(excluded.key(change.path)) ||
        (change.from !== undefined && !excluded.has(excluded.key(change.from))),
    )
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return {
    status: "compared",
    root: after.root,
    paths,
    complete: after.headDiffComplete,
    headMoved,
  };
}

function excludedSet(
  root: string,
  options: DiffChangedFilesOptions,
): { has: (key: string) => boolean; key: (repoPath: string) => string } {
  const pathApi = options.pathApi ?? path;
  // Windows paths compare case-insensitively.
  const fold = pathApi.sep === "\\";
  const key = (repoPath: string): string => (fold ? repoPath.toLowerCase() : repoPath);
  const set = new Set<string>();
  for (const file of options.excludePaths ?? []) {
    const relative = toRepoRelative(root, options.sessionCwd ?? root, file, pathApi);
    if (relative !== null) set.add(key(relative));
  }
  return { has: (value) => set.has(value), key };
}

/** Ordered record of paths written by the agent's own edit/write tools. */
export class ToolWriteLog {
  private readonly entries: { seq: number; path: string }[] = [];
  private seq = 0;

  record(absolutePath: string): void {
    this.seq++;
    this.entries.push({ seq: this.seq, path: absolutePath });
    if (this.entries.length > TOOL_WRITE_LOG_MAX) this.entries.shift();
  }

  mark(): number {
    return this.seq;
  }

  writtenSince(mark: number): string[] {
    return this.entries.filter((entry) => entry.seq > mark).map((entry) => entry.path);
  }
}

function flattenPath(value: string): string {
  let flat = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    flat += char;
  }
  return flat.length > NOTE_PATH_MAX_CHARS ? `${flat.slice(0, NOTE_PATH_MAX_CHARS - 1)}…` : flat;
}

/**
 * One short model-facing line, or null when nothing changed or the skip is
 * routine (non-Git, read-only, remote). Protected paths come first.
 */
export function formatChangedFilesNote(
  result: ChangedFilesResult,
  protectedPatterns: readonly string[] = [],
): string | null {
  if (result.status === "skipped") {
    return result.limit ? `[Changed-files check skipped: ${result.reason}.]` : null;
  }
  if (result.paths.length === 0) return null;
  const isProtected = protectedPatterns.length > 0 ? compileCovers(protectedPatterns) : () => false;
  const items = result.paths.map((change) => ({
    change,
    protected: isProtected(change.path) || (change.from !== undefined && isProtected(change.from)),
  }));
  const ordered = [
    ...items.filter((item) => item.protected),
    ...items.filter((item) => !item.protected),
  ];
  const shown = ordered
    .slice(0, CHANGED_FILES_NOTE_MAX_PATHS)
    .map(({ change, protected: guarded }) => {
      const label =
        change.from !== undefined
          ? `${flattenPath(change.from)} → ${flattenPath(change.path)}`
          : flattenPath(change.path);
      return `${label} (${change.kind}${guarded ? ", protected" : ""})`;
    });
  const more = ordered.length - shown.length;
  if (more > 0) shown.push(`+${more} more`);
  const count = `${ordered.length} file${ordered.length === 1 ? "" : "s"}`;
  const incomplete = result.complete ? "" : ", list may be incomplete";
  return `[This command changed ${count} (not via edit/write${incomplete}): ${shown.join(", ")}. Check these changes were intended.]`;
}

/**
 * Absolute paths for the ledger from a recorded `changedFiles` diagnostic, or
 * null when it is missing, skipped, incomplete or malformed.
 */
export function changedAbsolutePaths(value: unknown): string[] | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as { status?: unknown; complete?: unknown; root?: unknown; paths?: unknown };
  if (record.status !== "compared" || record.complete !== true) return null;
  const root = record.root;
  if (typeof root !== "string" || !path.isAbsolute(root) || !Array.isArray(record.paths))
    return null;
  const paths: string[] = [];
  for (const change of record.paths as unknown[]) {
    if (typeof change !== "object" || change === null) return null;
    const { path: file, from } = change as { path?: unknown; from?: unknown };
    if (typeof file !== "string" || file === "") return null;
    paths.push(path.join(root, file));
    if (from !== undefined) {
      if (typeof from !== "string" || from === "") return null;
      paths.push(path.join(root, from));
    }
  }
  return paths;
}
