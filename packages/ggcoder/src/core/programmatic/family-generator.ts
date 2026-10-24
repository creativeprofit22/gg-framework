import { execFile } from "node:child_process";
import type { Dirent, Stats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import {
  PLACEHOLDER_KEY_PATTERN,
  placeholderKeysIn,
  renderPlaceholders,
} from "../generated-files/render.js";
import { compareText, containedPath, sha256 } from "../tauri-package/paths.js";
import { FAMILY_GENERATOR_MEMBER_BOUNDS } from "./contracts.js";

/**
 * Generators that must rebuild their reference. The model drafts a logic-free
 * template plus one input record per family member; the host supplies a fixed
 * Node helper. Inspection checks structure only. Only the reference check
 * (running the helper in a fixture copy and comparing bytes) accepts a template.
 * Nothing here writes into the repository or generates another family member.
 */
export const FAMILY_GENERATOR_LIMITS = Object.freeze({
  placeholders: 16,
  valueChars: 500,
  pathChars: 400,
  templateFiles: 28,
  referenceFiles: 28,
  referenceDepth: 8,
  outputFiles: 64,
  outputBytes: 1_000_000,
  diffBytesPerFile: 8_000,
  diffBytesTotal: 32_000,
  stderrChars: 2_000,
  evidenceChars: 3_800,
  timeoutMs: 30_000,
  stdioBytes: 64_000,
});
const L = FAMILY_GENERATOR_LIMITS;
export const FAMILY_GENERATOR_HELPERS = Object.freeze({
  script: "generate.mjs",
  template: "template.json",
  inputs: "inputs.json",
});

/** Same segment rules as reviewed prerequisite paths: plain, portable, no device names. */
export function isSafeRepositoryPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= L.pathChars &&
    !value.startsWith("/") &&
    value
      .split("/")
      .every(
        (segment) =>
          /^[a-z0-9._@+-]+$/i.test(segment) &&
          segment !== "." &&
          segment !== ".." &&
          !/[. ]$/.test(segment) &&
          !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment),
      )
  );
}

const keySchema = z.string().regex(PLACEHOLDER_KEY_PATTERN);
const valueSchema = z
  .string()
  .min(1)
  .max(L.valueChars)
  .refine(
    (value) =>
      !value.includes("{{") &&
      !value.includes("}}") &&
      [...value].every((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && code !== 127;
      }),
    "values must be single-line text without control characters or {{ }}",
  );
const memberPathSchema = z.string().refine(isSafeRepositoryPath, "unsafe member path");

export const familyGeneratorInputSchema = z.strictObject({
  /** Detected item family id from the approved recommendation. */
  familyId: z.string().regex(/^[a-f0-9]{16}$/),
  /** `directory`: each member is a folder; `file`: each member is one file. */
  kind: z.enum(["directory", "file"]),
  /** The existing (or hand-built) member the generator must reproduce exactly. */
  reference: memberPathSchema,
  placeholders: z.array(keySchema).min(1).max(L.placeholders),
  members: z
    .array(
      z.strictObject({
        path: memberPathSchema,
        /** One `{ key, value }` per placeholder (a list, so strict tool schemas can express it). */
        values: z.array(z.strictObject({ key: keySchema, value: valueSchema })).max(L.placeholders),
      }),
    )
    .min(FAMILY_GENERATOR_MEMBER_BOUNDS.min)
    .max(FAMILY_GENERATOR_MEMBER_BOUNDS.max),
  /** Repository-relative paths and contents with `{{key}}` placeholders. */
  files: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(L.pathChars),
        content: z.string().max(128_000),
      }),
    )
    .min(1)
    .max(L.templateFiles),
});
export type FamilyGeneratorInput = z.infer<typeof familyGeneratorInputSchema>;

/** Link-safe local reads owned by reviewed command creation (injected to avoid a cycle). */
export interface FamilyFileAccess {
  stat: (absolute: string) => Promise<Stats | null>;
  readText: (absolute: string, signal: AbortSignal) => Promise<string>;
}

export interface FamilyGeneratorMetadata {
  familyId: string;
  kind: "directory" | "file";
  reference: string;
  members: string[];
  placeholders: string[];
  referenceFiles: string[];
  helperDirectory: string;
}

export type FamilyGeneratorPreparation =
  | {
      status: "ready";
      helpers: { name: string; content: string; reason: string }[];
      referencePrerequisites: { path: string; sha256: string }[];
      metadata: FamilyGeneratorMetadata;
    }
  | { status: "invalid"; reason: string };

/** Fixed host-owned helper source. Mirrors `renderPlaceholders` exactly. */
export const FAMILY_GENERATOR_HELPER_SOURCE = String.raw`// Host-owned family generator (ggcoder). Fixed source: logic-free {{key}} rendering,
// no dependencies, no network. Writes only into a new --out directory.
// Usage: node generate.mjs --member <repository-relative member path> --out <new directory>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOKEN = /\{\{([a-z][a-z0-9_]{0,39})\}\}/g;
const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const here = path.dirname(fileURLToPath(import.meta.url));

function fail(message) {
  process.stderr.write("generate.mjs: " + message + "\n");
  process.exit(2);
}
function render(text, values) {
  return text.replace(TOKEN, (token, key) => (Object.hasOwn(values, key) ? values[key] : token));
}
function safePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 400 &&
    !value.startsWith("/") &&
    value
      .split("/")
      .every(
        (part) =>
          /^[a-z0-9._@+-]+$/i.test(part) &&
          part !== "." &&
          part !== ".." &&
          !/[. ]$/.test(part) &&
          !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
      )
  );
}
function load(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(here, name), "utf8"));
  } catch {
    fail("cannot read " + name);
  }
}

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--member" || args[2] !== "--out")
  fail("usage: --member <path> --out <new directory>");
const member = args[1];
const out = path.resolve(args[3]);
const template = load("template.json");
const inputs = load("inputs.json");
if (
  template?.version !== 1 ||
  inputs?.version !== 1 ||
  (template.kind !== "directory" && template.kind !== "file") ||
  !Array.isArray(template.placeholders) ||
  !Array.isArray(template.files) ||
  !Array.isArray(inputs.members)
)
  fail("unsupported template.json or inputs.json");
const record = inputs.members.find((item) => item && item.path === member);
if (!record || typeof record.values !== "object" || record.values === null)
  fail("unknown member: " + member);
const keys = template.placeholders;
const values = record.values;
if (
  Object.keys(values).length !== keys.length ||
  keys.some((key) => !KEY.test(key) || !Object.hasOwn(values, key) || typeof values[key] !== "string")
)
  fail("member values do not match the template placeholders");
const files = template.files.map((file) => ({
  path: render(String(file.path), values),
  content: render(String(file.content), values),
}));
const seen = new Set();
for (const file of files) {
  const inside = template.kind === "file" ? file.path === member : file.path.startsWith(member + "/");
  if (!safePath(file.path) || !inside || seen.has(file.path.toLowerCase()))
    fail("unsafe or duplicate output path: " + file.path);
  seen.add(file.path.toLowerCase());
}
try {
  fs.mkdirSync(out);
} catch {
  fail("--out must be a new directory whose parent exists");
}
for (const file of files) {
  const target = path.join(out, ...file.path.split("/"));
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content, { encoding: "utf8", flag: "wx" });
  } catch {
    fail("cannot write " + file.path);
  }
}
process.stdout.write(JSON.stringify({ member, files: files.map((file) => file.path).sort() }) + "\n");
`;

const byPath = <T extends { path: string }>(left: T, right: T) =>
  compareText(left.path, right.path);

/** Sorted repository-relative files of a reference member. No links, bounded count. */
export async function enumerateReference(
  root: string,
  reference: string,
  kind: "directory" | "file",
  io: FamilyFileAccess,
  signal: AbortSignal,
): Promise<string[]> {
  const top = await io.stat(containedPath(root, reference));
  if (!top) throw new Error("reference-missing");
  if (kind === "file") {
    if (!top.isFile()) throw new Error("reference-kind-mismatch");
    return [reference];
  }
  if (!top.isDirectory()) throw new Error("reference-kind-mismatch");
  const files: string[] = [];
  const walk = async (relative: string, depth: number): Promise<void> => {
    signal.throwIfAborted();
    if (depth > L.referenceDepth) throw new Error("reference-too-deep");
    const entries = await fs.readdir(containedPath(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => compareText(a.name, b.name))) {
      const child = `${relative}/${entry.name}`;
      if (!isSafeRepositoryPath(child)) throw new Error("reference-unsafe-path");
      if (entry.isDirectory()) await walk(child, depth + 1);
      else if (entry.isFile()) {
        files.push(child);
        if (files.length > L.referenceFiles) throw new Error("reference-file-limit");
      } else throw new Error("reference-link-or-special-file");
    }
  };
  await walk(reference, 0);
  if (!files.length) throw new Error("reference-empty");
  return files.sort(compareText);
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function withinMember(kind: "directory" | "file", member: string, file: string): boolean {
  return kind === "file" ? file === member : file.startsWith(`${member}/`);
}

/**
 * Deterministic structural review of a drafted generator. Never executes the
 * helper and never accepts the template: only `checkReferenceReproduction` can.
 */
export async function prepareFamilyGenerator(
  root: string,
  input: FamilyGeneratorInput,
  helperDirectory: string,
  io: FamilyFileAccess,
  signal: AbortSignal,
): Promise<FamilyGeneratorPreparation> {
  const invalid = (reason: string) => ({ status: "invalid", reason }) as const;
  const keys = input.placeholders;
  if (
    input.members.some(
      (member) => new Set(member.values.map((v) => v.key)).size !== member.values.length,
    )
  )
    return invalid("duplicate-member-value-key");
  const members = input.members
    .map((member) => ({
      path: member.path,
      values: Object.fromEntries(member.values.map((v) => [v.key, v.value])) as Record<
        string,
        string
      >,
    }))
    .sort(byPath);
  if (new Set(keys).size !== keys.length) return invalid("duplicate-placeholder");
  if (new Set(members.map((member) => member.path.toLowerCase())).size !== members.length)
    return invalid("duplicate-member");
  if (!members.some((member) => member.path === input.reference))
    return invalid("reference-not-a-member");
  if (input.kind === "file" && input.files.length !== 1)
    return invalid("file-family-needs-one-template-file");
  for (const member of members) {
    const present = Object.keys(member.values).sort(compareText);
    if (present.join("\n") !== [...keys].sort(compareText).join("\n"))
      return invalid("member-values-must-match-placeholders");
  }
  const used = new Set(input.files.flatMap((file) => placeholderKeysIn(file.path + file.content)));
  if (keys.some((key) => !used.has(key))) return invalid("unused-placeholder");
  // Placeholders exist only for values that differ across members.
  if (keys.some((key) => new Set(members.map((member) => member.values[key])).size < 2))
    return invalid("placeholder-value-does-not-vary");
  for (const member of members) {
    const rendered = input.files.map((file) => renderPlaceholders(file.path, member.values));
    if (
      rendered.some(
        (file) => !isSafeRepositoryPath(file) || !withinMember(input.kind, member.path, file),
      ) ||
      new Set(rendered.map((file) => file.toLowerCase())).size !== rendered.length
    )
      return invalid("rendered-path-outside-member-unsafe-or-duplicate");
  }
  let referenceFiles: string[];
  try {
    referenceFiles = await enumerateReference(root, input.reference, input.kind, io, signal);
  } catch (error) {
    signal.throwIfAborted();
    return invalid(
      error instanceof Error && /^reference-/.test(error.message)
        ? error.message
        : "reference-unreadable",
    );
  }
  const referenceValues = members.find((member) => member.path === input.reference)?.values ?? {};
  const renderedReference = input.files
    .map((file) => renderPlaceholders(file.path, referenceValues))
    .sort(compareText);
  if (renderedReference.join("\n") !== referenceFiles.join("\n"))
    return invalid("rendered-reference-paths-differ-from-reference-files");
  const referencePrerequisites: { path: string; sha256: string }[] = [];
  for (const file of referenceFiles) {
    let text: string;
    try {
      text = await io.readText(containedPath(root, file), signal);
    } catch {
      signal.throwIfAborted();
      return invalid("reference-file-unreadable-binary-or-oversize");
    }
    // A literal placeholder in the reference could not be told apart from a value.
    if (placeholderKeysIn(text).some((key) => keys.includes(key)))
      return invalid("reference-contains-placeholder-text");
    referencePrerequisites.push({ path: file, sha256: sha256(text) });
  }
  const template = {
    version: 1,
    familyId: input.familyId,
    kind: input.kind,
    placeholders: keys,
    files: [...input.files].sort(byPath),
  };
  const inputs = {
    version: 1,
    reference: input.reference,
    members: members.map((member) => ({
      path: member.path,
      values: Object.fromEntries(keys.map((key) => [key, member.values[key]])),
    })),
  };
  return {
    status: "ready",
    helpers: [
      {
        name: FAMILY_GENERATOR_HELPERS.script,
        content: FAMILY_GENERATOR_HELPER_SOURCE,
        reason:
          "Fixed host-owned Node helper: renders one member's template into a new --out directory.",
      },
      {
        name: FAMILY_GENERATOR_HELPERS.template,
        content: canonicalJson(template),
        reason:
          "Logic-free template drafted from the reference; accepted only by the reference check.",
      },
      {
        name: FAMILY_GENERATOR_HELPERS.inputs,
        content: canonicalJson(inputs),
        reason: "One input record per family member.",
      },
    ],
    referencePrerequisites,
    metadata: {
      familyId: input.familyId,
      kind: input.kind,
      reference: input.reference,
      members: members.map((member) => member.path),
      placeholders: [...keys],
      referenceFiles,
      helperDirectory,
    },
  };
}

export interface ReferenceDifference {
  path: string;
  kind: "missing" | "unexpected" | "bytes";
  referenceBytes?: number;
  generatedBytes?: number;
  /** Zero-based offset of the first differing byte. */
  firstDifferentByte?: number;
  /** Unified diff of the file, capped. */
  diff?: string;
}
export type ReferenceCheck =
  | { result: "passed"; files: string[] }
  | {
      result: "failed";
      reason: "differences" | "generator-exited" | "generator-timeout" | "output-limit";
      differences: ReferenceDifference[];
      diffTruncated: boolean;
      stderr?: string;
    }
  | { result: "unavailable"; reason: string };

export interface ReferenceCheckOptions {
  root: string;
  metadata: FamilyGeneratorMetadata;
  /** Reviewed helper digests (repository-relative paths); edited helpers are refused. */
  helpers: readonly { path: string; sha256: string }[];
  /** Reviewed reference digests; edited reference files are refused. */
  referenceFiles: readonly { path: string; sha256: string }[];
  /** Host-owned Node runtime; never a tool parameter. */
  runtimeExecutable: string;
  io: FamilyFileAccess;
  signal: AbortSignal;
  timeoutMs?: number;
}

function firstDifference(left: Buffer, right: Buffer): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) if (left[index] !== right[index]) return index;
  return length;
}

async function collectOutput(directory: string): Promise<Map<string, Buffer> | null> {
  const files = new Map<string, Buffer>();
  let bytes = 0;
  const walk = async (absolute: string, relative: string): Promise<boolean> => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(absolute, { withFileTypes: true });
    } catch (error) {
      if (relative === "" && (error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const child = path.join(absolute, entry.name);
      if (entry.isDirectory()) {
        if (!(await walk(child, childRelative))) return false;
      } else if (entry.isFile()) {
        const content = await fs.readFile(child);
        bytes += content.length;
        files.set(childRelative, content);
        if (files.size > L.outputFiles || bytes > L.outputBytes) return false;
      } else return false;
    }
    return true;
  };
  return (await walk(directory, "")) ? files : null;
}

function runHelper(
  runtime: string,
  script: string,
  args: string[],
  cwd: string,
  timeout: number,
  signal: AbortSignal,
): Promise<
  { status: "exited"; code: number | null; stderr: string } | { status: "timeout" | "spawn-failed" }
> {
  // Minimal environment: no PATH, NODE_OPTIONS or secrets reach the helper.
  const env: NodeJS.ProcessEnv = {};
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return new Promise((resolve) => {
    execFile(
      runtime,
      [script, ...args],
      { cwd, env, timeout, maxBuffer: L.stdioBytes, windowsHide: true, signal, encoding: "utf8" },
      (error, _stdout, stderr) => {
        if (!error) return resolve({ status: "exited", code: 0, stderr });
        const overflow = error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        if (typeof error.code === "string" && !overflow) return resolve({ status: "spawn-failed" });
        if (error.killed && !overflow && !signal.aborted) return resolve({ status: "timeout" });
        resolve({
          status: "exited",
          code: typeof error.code === "number" ? error.code : null,
          stderr: String(stderr ?? ""),
        });
      },
    );
  });
}

export type MemberRender =
  | { status: "rendered"; files: Map<string, Buffer> }
  | {
      status: "failed";
      reason: "generator-exited" | "generator-timeout" | "output-limit";
      stderr?: string;
    }
  | { status: "unavailable"; reason: "node-runtime-unavailable" | "generator-failed-to-run" };

/**
 * Run the reviewed helper texts for one member in a fresh temporary fixture and
 * collect its output. The fixture is always removed; nothing is written into the
 * repository. Output paths are repository-relative as the helper emits them.
 */
export async function renderMemberInFixture(options: {
  runtimeExecutable: string;
  helperTexts: ReadonlyMap<string, string>;
  member: string;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<MemberRender> {
  const { signal } = options;
  signal.throwIfAborted();
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "gg-reference-check-"));
  try {
    const helpers = path.join(fixture, "helpers");
    await fs.mkdir(helpers);
    for (const name of Object.values(FAMILY_GENERATOR_HELPERS)) {
      const text = options.helperTexts.get(name);
      if (text === undefined) return { status: "unavailable", reason: "generator-failed-to-run" };
      await fs.writeFile(path.join(helpers, name), text, { encoding: "utf8", flag: "wx" });
    }
    const out = path.join(fixture, "out");
    const run = await runHelper(
      options.runtimeExecutable,
      path.join(helpers, FAMILY_GENERATOR_HELPERS.script),
      ["--member", options.member, "--out", out],
      fixture,
      options.timeoutMs ?? L.timeoutMs,
      signal,
    );
    signal.throwIfAborted();
    if (run.status === "spawn-failed")
      return { status: "unavailable", reason: "node-runtime-unavailable" };
    if (run.status === "timeout") return { status: "failed", reason: "generator-timeout" };
    if (run.status === "exited" && run.code !== 0) {
      const stderr = run.stderr.slice(0, L.stderrChars);
      return { status: "failed", reason: "generator-exited", ...(stderr ? { stderr } : {}) };
    }
    const files = await collectOutput(out);
    if (!files) return { status: "failed", reason: "output-limit" };
    return { status: "rendered", files };
  } catch (error) {
    if (signal.aborted) throw error;
    return { status: "unavailable", reason: "generator-failed-to-run" };
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
}

/**
 * Run the reviewed helper for the reference's own inputs in a fresh fixture
 * copy and compare every output byte with the reference on disk. The fixture
 * is always removed; nothing is written into the repository.
 */
export async function checkReferenceReproduction(
  options: ReferenceCheckOptions,
): Promise<ReferenceCheck> {
  const { root, metadata, io, signal } = options;
  const unavailable = (reason: string) => ({ result: "unavailable", reason }) as const;
  const runtime = await io.stat(options.runtimeExecutable).catch(() => null);
  if (!runtime?.isFile()) return unavailable("node-runtime-unavailable");
  const helperTexts = new Map<string, string>();
  for (const name of Object.values(FAMILY_GENERATOR_HELPERS)) {
    const repositoryPath = `${metadata.helperDirectory}/${name}`;
    const expected = options.helpers.find((helper) => helper.path === repositoryPath);
    const text = await io.readText(containedPath(root, repositoryPath), signal).catch(() => null);
    if (!expected || text === null || sha256(text) !== expected.sha256)
      return unavailable("reviewed-helper-changed");
    helperTexts.set(name, text);
  }
  const reference = new Map<string, Buffer>();
  for (const file of metadata.referenceFiles) {
    const expected = options.referenceFiles.find((item) => item.path === file);
    const text = await io.readText(containedPath(root, file), signal).catch(() => null);
    if (!expected || text === null || sha256(text) !== expected.sha256)
      return unavailable("reference-changed");
    reference.set(file, Buffer.from(text, "utf8"));
  }
  signal.throwIfAborted();
  const render = await renderMemberInFixture({
    runtimeExecutable: options.runtimeExecutable,
    helperTexts,
    member: metadata.reference,
    signal,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  if (render.status === "unavailable")
    return unavailable(
      render.reason === "node-runtime-unavailable"
        ? render.reason
        : "reference-check-failed-to-run",
    );
  if (render.status === "failed")
    return {
      result: "failed",
      reason: render.reason,
      differences: [],
      diffTruncated: false,
      ...(render.stderr ? { stderr: render.stderr } : {}),
    };
  const generated = render.files;
  try {
    const differences: ReferenceDifference[] = [];
    let diffBytes = 0;
    let diffTruncated = false;
    const paths = [...new Set([...reference.keys(), ...generated.keys()])].sort(compareText);
    for (const file of paths) {
      const expected = reference.get(file);
      const actual = generated.get(file);
      if (expected && actual && expected.equals(actual)) continue;
      const difference: ReferenceDifference = {
        path: file,
        kind: !actual ? "missing" : !expected ? "unexpected" : "bytes",
        ...(expected ? { referenceBytes: expected.length } : {}),
        ...(actual ? { generatedBytes: actual.length } : {}),
        ...(expected && actual ? { firstDifferentByte: firstDifference(expected, actual) } : {}),
      };
      let diff = createTwoFilesPatch(
        `reference/${file}`,
        `generated/${file}`,
        expected?.toString("utf8") ?? "",
        actual?.toString("utf8") ?? "",
        undefined,
        undefined,
        { context: 3 },
      );
      if (Buffer.byteLength(diff) > L.diffBytesPerFile) {
        diff = `${Buffer.from(diff).subarray(0, L.diffBytesPerFile).toString("utf8")}\n... diff truncated\n`;
        diffTruncated = true;
      }
      if (diffBytes + Buffer.byteLength(diff) <= L.diffBytesTotal) {
        difference.diff = diff;
        diffBytes += Buffer.byteLength(diff);
      } else diffTruncated = true;
      differences.push(difference);
    }
    if (!differences.length) return { result: "passed", files: [...reference.keys()] };
    return { result: "failed", reason: "differences", differences, diffTruncated };
  } catch (error) {
    if (signal.aborted) throw error;
    return unavailable("reference-check-failed-to-run");
  }
}

export type ProjectCheckStatus = "none-found" | "passed" | "failed" | "not-run";
export interface GeneratorVerification {
  reference: string;
  referenceCheck: ReferenceCheck;
  projectCheck: {
    status: ProjectCheckStatus;
    detectedCommands: string[];
    command?: string;
    exitCode?: number | null;
  };
  checksRun: string[];
  generatorVerified: boolean;
  statement: string;
}

/**
 * Combine the reference check with the project's own check. The host never
 * runs the project check: it accepts only a selected, current, nonpersistent
 * bash receipt whose command equals a detected project check.
 */
export function evaluateGeneratorVerification(input: {
  reference: string;
  referenceCheck: ReferenceCheck;
  detectedCommands: readonly string[];
  receipts: readonly { command: string; exitCode: number | null | undefined }[];
}): GeneratorVerification {
  const detectedCommands = [...new Set(input.detectedCommands)];
  const matching = input.receipts.filter((receipt) => detectedCommands.includes(receipt.command));
  const passed = matching.find((receipt) => receipt.exitCode === 0);
  // No observed exit status (undefined) is not evidence either way.
  const failed = matching.find(
    (receipt) => receipt.exitCode !== undefined && receipt.exitCode !== 0,
  );
  const projectCheck: GeneratorVerification["projectCheck"] = !detectedCommands.length
    ? { status: "none-found", detectedCommands }
    : failed
      ? {
          status: "failed",
          detectedCommands,
          command: failed.command,
          exitCode: failed.exitCode ?? null,
        }
      : passed
        ? { status: "passed", detectedCommands, command: passed.command, exitCode: 0 }
        : { status: "not-run", detectedCommands };
  const referencePassed = input.referenceCheck.result === "passed";
  const checksRun = [
    ...(input.referenceCheck.result === "unavailable" ? [] : ["reproduces-reference"]),
    ...(projectCheck.command ? [`project-check: ${projectCheck.command}`] : []),
  ];
  const generatorVerified =
    referencePassed && (projectCheck.status === "passed" || projectCheck.status === "none-found");
  const reference =
    input.referenceCheck.result === "passed"
      ? `The generator reproduced ${input.reference} byte for byte in a fixture copy.`
      : input.referenceCheck.result === "failed"
        ? `The generator did not reproduce ${input.reference} (${input.referenceCheck.reason}); it is not verified. See the reported differences.`
        : `The reference check could not run (${input.referenceCheck.reason}); the generator is not verified.`;
  const project =
    projectCheck.status === "none-found"
      ? "No project check was found; only the exact-match check ran."
      : projectCheck.status === "passed"
        ? `The project check \`${projectCheck.command}\` exited 0 for the current files.`
        : projectCheck.status === "failed"
          ? `The project check \`${projectCheck.command}\` exited with code ${projectCheck.exitCode}; the generator is not verified.`
          : `The project check has not run for the current files (detected: ${detectedCommands.join(", ")}). Run one with a separately approved nonpersistent bash call and pass its receipt; until then the generator is not verified.`;
  return {
    reference: input.reference,
    referenceCheck: input.referenceCheck,
    projectCheck,
    checksRun,
    generatorVerified,
    statement: `${reference} ${project}`,
  };
}
