import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { VerifyGate, VerifyPlan } from "@kenkaiiii/gg-core/verify-plan";
import { BackgroundGitError } from "../utils/git.js";
import {
  SNAPSHOT_MAX_MS,
  boundedGit,
  hashWorkspaceFiles,
  listWorkspaceFiles,
  resolveWorkspaceRoot,
} from "./verification-snapshot.js";

/** Which files a check's result depends on. */
export type CheckScope =
  { kind: "tree"; root: string } | { kind: "plan"; root: string; gateId: string; covers: string[] };

export interface CheckInputs {
  fingerprint: string;
  /** Content hash of the covered files only (whole tree for `tree` scope). */
  contentHash: string;
  scope: CheckScope;
}

export interface CaptureCheckInputsArgs {
  /** Directory the command runs in. */
  cwd: string;
  /** The command as recorded (used when no project gate matches). */
  command: string;
  shellPath?: string;
  /** Environment the command runs with (safe tool env plus per-command extras). */
  env: Readonly<Record<string, string>>;
  /** Project verify-plan gate this exact command runs, if any. */
  gate?: VerifyGate | null;
  signal?: AbortSignal;
}

export type PathApi = Pick<typeof path, "resolve" | "relative" | "isAbsolute" | "sep">;

const FINGERPRINT_VERSION = 1;
const MEMORY_MAX_ENTRIES = 100;
const MEMORY_MAX_HANDOFFS = 100;
const NOTICE_MAX_GATES = 5;

function escapeRegex(text: string): string {
  return text.replace(/[.+^$()|{}[\]\\]/g, "\\$&");
}

function globToRegex(glob: string): string {
  let out = "";
  let inBrace = false;
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index] ?? "";
    if (char === "*") {
      if (glob[index + 1] === "*") {
        const atSegmentStart = index === 0 || glob[index - 1] === "/";
        if (atSegmentStart && glob[index + 2] === "/") {
          out += "(?:.*/)?";
          index += 2;
        } else {
          out += ".*";
          index += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else if (char === "{" && !inBrace) {
      inBrace = true;
      out += "(?:";
    } else if (char === "}" && inBrace) {
      inBrace = false;
      out += ")";
    } else if (char === "," && inBrace) {
      out += "|";
    } else {
      out += escapeRegex(char);
    }
  }
  // An unclosed brace is not a glob we understand: match it literally.
  if (inBrace) return escapeRegex(glob);
  return out;
}

function normalizeCover(cover: string): string {
  let value = cover.trim().replace(/\\/g, "/");
  while (value.startsWith("./")) value = value.slice(2);
  value = value.replace(/\/+$/, "");
  return value === "" ? "." : value;
}

/**
 * Matcher for the contract's glob subset (`**`, `*`, `?`, `{a,b}`) over
 * `/`-separated repo paths. Every pattern also matches everything below
 * what it names, so a plain path or a directory glob covers its contents;
 * matching too much only means less reuse.
 */
export function compileCovers(covers: readonly string[]): (repoPath: string) => boolean {
  const patterns: RegExp[] = [];
  for (const raw of covers) {
    const cover = normalizeCover(raw);
    if (cover === "." || cover === "**") return () => true;
    // Case-insensitive: Windows and macOS file systems usually are, and over-matching is safe.
    patterns.push(new RegExp(`^${globToRegex(cover)}(?:/.*)?$`, "i"));
  }
  return (repoPath) => patterns.some((pattern) => pattern.test(repoPath));
}

/**
 * `/`-separated path of `file` relative to `root`, resolving relative paths
 * against `sessionCwd`; null outside the root (or for the root itself).
 */
export function toRepoRelative(
  root: string,
  sessionCwd: string,
  file: string,
  pathApi: PathApi = path,
): string | null {
  const absolute = pathApi.resolve(sessionCwd, file);
  const direct = relativeInside(root, absolute, pathApi);
  if (direct !== null || pathApi !== path) return direct;
  // The root is canonical; an alias (symlink, Windows 8.3 name) only matches once resolved.
  const canonical = canonicalPath(absolute);
  return canonical === absolute ? null : relativeInside(root, canonical, pathApi);
}

function relativeInside(root: string, absolute: string, pathApi: PathApi): string | null {
  const relative = pathApi.relative(root, absolute);
  if (relative === "" || pathApi.isAbsolute(relative)) return null;
  const parts = relative.split(pathApi.sep).filter(Boolean);
  if (parts.length === 0 || parts[0] === "..") return null;
  return parts.join("/");
}

/** Real path of the deepest existing ancestor plus the rest, so new or deleted files resolve too. */
function canonicalPath(absolute: string): string {
  const rest: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return path.join(realpathSync.native(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Whether a change can affect a check of this scope. Unknown changes, the
 * whole-tree scope and paths outside the root always do (fail-closed).
 */
export function scopeAffectedBy(
  scope: CheckScope,
  changedPaths: readonly string[] | null,
  sessionCwd: string,
  pathApi: PathApi = path,
): boolean {
  if (changedPaths === null || scope.kind === "tree") return true;
  const matches = compileCovers(scope.covers);
  for (const file of changedPaths) {
    const relative = toRepoRelative(scope.root, sessionCwd, file, pathApi);
    if (relative === null || matches(relative)) return true;
  }
  return false;
}

function digestEnv(env: Readonly<Record<string, string>>): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        Object.entries(env).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
      ),
    )
    .digest("hex");
}

/**
 * Fingerprint of everything a check's result depends on: argv, cwd, env,
 * git HEAD and the content of the covered files. Null on any error, cap or
 * race, so the check simply runs and nothing is reused or stored.
 */
export async function captureCheckInputs(
  args: CaptureCheckInputsArgs,
): Promise<CheckInputs | null> {
  const deadline = Date.now() + SNAPSHOT_MAX_MS;
  try {
    const git = boundedGit(args.cwd, deadline, args.signal);
    const root = await resolveWorkspaceRoot(git);
    let head: string;
    try {
      head = (await git(["-C", root, "rev-parse", "--verify", "-q", "HEAD"])).trim();
    } catch (error) {
      // `--verify -q` exits 1 without output when the branch has no commit yet.
      if (!(error instanceof BackgroundGitError) || error.code !== 1 || error.killed) throw error;
      head = "unborn";
    }
    const gate = args.gate ?? null;
    const covers = gate ? gate.covers.map(normalizeCover) : [];
    const scope: CheckScope =
      gate && covers.length > 0
        ? { kind: "plan", root, gateId: gate.id, covers }
        : { kind: "tree", root };
    const listed = await listWorkspaceFiles(git, root);
    const matches = scope.kind === "plan" ? compileCovers(scope.covers) : null;
    const files = matches ? listed.filter(matches) : listed;
    const contentHash = await hashWorkspaceFiles(root, files, deadline);
    if (contentHash === null) return null;
    if (
      Date.now() > deadline ||
      JSON.stringify(listed) !== JSON.stringify(await listWorkspaceFiles(git, root))
    )
      return null;
    const cwd = path.relative(root, await fs.realpath(args.cwd));
    if (path.isAbsolute(cwd) || cwd.split(path.sep).includes("..")) return null;
    const argv = gate
      ? ["gate", gate.id, gate.cwd, ...gate.argv]
      : ["shell", args.shellPath ?? "", args.command];
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          v: FINGERPRINT_VERSION,
          argv,
          cwd: cwd.split(path.sep).join("/"),
          env: digestEnv(args.env),
          head,
          scope: scope.kind,
          covers: scope.kind === "plan" ? scope.covers : [],
          contentHash,
        }),
      )
      .digest("hex");
    return { fingerprint, contentHash, scope };
  } catch {
    return null;
  }
}

export interface CheckCoverageRecord {
  fingerprint: string;
  status: "passed" | "failed";
  command: string;
  executionId: string;
  run: number;
  observedAt: string;
}

export interface SettledCheckCoverage {
  fingerprint: string;
  scope: CheckScope;
}

/** Validates a scope from tool details; null for anything malformed. */
export function parseCheckScope(value: unknown): CheckScope | null {
  if (!value || typeof value !== "object") return null;
  const scope = value as Record<string, unknown>;
  if (typeof scope.root !== "string" || !scope.root) return null;
  if (scope.kind === "tree") return { kind: "tree", root: scope.root };
  if (
    scope.kind === "plan" &&
    typeof scope.gateId === "string" &&
    Array.isArray(scope.covers) &&
    scope.covers.length > 0 &&
    scope.covers.every((cover) => typeof cover === "string")
  ) {
    return {
      kind: "plan",
      root: scope.root,
      gateId: scope.gateId,
      covers: [...(scope.covers as string[])],
    };
  }
  return null;
}

/** Validates `{ fingerprint, scope }` from tool details; null for anything malformed. */
export function parseSettledCheckCoverage(value: unknown): SettledCheckCoverage | null {
  if (!value || typeof value !== "object") return null;
  const coverage = value as Record<string, unknown>;
  const scope = parseCheckScope(coverage.scope);
  if (typeof coverage.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(coverage.fingerprint)) {
    return null;
  }
  return scope ? { fingerprint: coverage.fingerprint, scope } : null;
}

interface PendingHandoff {
  before: CheckInputs;
  capture: CaptureCheckInputsArgs;
}

/** Bounded memory of conclusive check outcomes by input fingerprint. */
export class CheckCoverageMemory {
  private readonly records = new Map<string, CheckCoverageRecord>();
  private readonly handoffs = new Map<string, PendingHandoff>();
  private readonly maxEntries: number;
  private readonly maxHandoffs: number;
  private readonly capture: (args: CaptureCheckInputsArgs) => Promise<CheckInputs | null>;

  constructor({
    maxEntries = MEMORY_MAX_ENTRIES,
    maxHandoffs = MEMORY_MAX_HANDOFFS,
    capture = captureCheckInputs,
  }: {
    maxEntries?: number;
    maxHandoffs?: number;
    capture?: (args: CaptureCheckInputsArgs) => Promise<CheckInputs | null>;
  } = {}) {
    this.maxEntries = maxEntries;
    this.maxHandoffs = maxHandoffs;
    this.capture = capture;
  }

  get size(): number {
    return this.records.size;
  }

  /** Stores only conclusive outcomes; the latest one per fingerprint wins. */
  remember(record: CheckCoverageRecord): void {
    if (record.status !== "passed" && record.status !== "failed") return;
    if (!record.fingerprint) return;
    this.records.delete(record.fingerprint);
    this.records.set(record.fingerprint, { ...record });
    while (this.records.size > this.maxEntries) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
  }

  lookup(fingerprint: string): CheckCoverageRecord | null {
    const record = this.records.get(fingerprint);
    return record ? { ...record } : null;
  }

  trackHandoff(taskId: string, before: CheckInputs, capture: CaptureCheckInputsArgs): void {
    this.handoffs.delete(taskId);
    // The tool call's abort signal ends with the call; settling must not inherit it.
    this.handoffs.set(taskId, { before, capture: { ...capture, signal: undefined } });
    while (this.handoffs.size > this.maxHandoffs) {
      const oldest = this.handoffs.keys().next().value;
      if (oldest === undefined) break;
      this.handoffs.delete(oldest);
    }
  }

  hasHandoff(taskId: string): boolean {
    return this.handoffs.has(taskId);
  }

  /** Recomputes a finished hand-off's inputs; the fingerprint only if they did not move. */
  async settleHandoff(taskId: string): Promise<SettledCheckCoverage | null> {
    const pending = this.handoffs.get(taskId);
    if (!pending) return null;
    this.handoffs.delete(taskId);
    const after = await this.capture(pending.capture);
    if (!after || after.fingerprint !== pending.before.fingerprint) return null;
    return { fingerprint: after.fingerprint, scope: after.scope };
  }

  clear(): void {
    this.records.clear();
    this.handoffs.clear();
  }
}

function oneLine(text: string, max = 128): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function isoSeconds(value: string): string {
  return value.replace(/\.\d+Z$/, "Z");
}

/** One line telling the agent an identical earlier pass exists. */
export function formatPriorPassNotice(record: CheckCoverageRecord, current: boolean): string {
  const where = `in run ${record.run} at ${oneLine(isoSeconds(record.observedAt), 40)} (exec ${oneLine(record.executionId)})`;
  return current
    ? `[Same check passed with identical inputs ${where}; it is still current evidence, so this re-run is optional.]`
    : `[Same check passed with identical inputs ${where}; that pass is no longer current evidence, so this run records fresh evidence.]`;
}

/** One line listing passes the project says it reused; never harness evidence. */
export function formatProjectReportedPasses(plan: VerifyPlan | null | undefined): string | null {
  const reused = (plan?.advice ?? []).filter((advice) => advice.kind === "reused-pass");
  if (reused.length === 0) return null;
  const shown = reused.slice(0, NOTICE_MAX_GATES).map((advice) => {
    const gate = oneLine(advice.gateId, 64);
    return advice.lastRun ? `${gate} (last run ${oneLine(advice.lastRun, 40)})` : gate;
  });
  const more = reused.length > shown.length ? ` +${reused.length - shown.length} more` : "";
  return `[Passes reused by the project: ${shown.join(", ")}${more}; reported by the project, not harness evidence.]`;
}
