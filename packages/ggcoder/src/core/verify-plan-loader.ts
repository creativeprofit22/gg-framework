// Loads the project's verify plan (.gg/verify-plan.json); see docs/harness-checks.md "Plan source".
import { statSync, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  VERIFY_PLAN_COMMAND_LIMITS,
  VERIFY_PLAN_DESCRIPTOR_MAX_BYTES,
  VERIFY_PLAN_DESCRIPTOR_PATH,
  VERIFY_PLAN_HEURISTICS_REASONS,
  decideVerifyPlanSource,
  interpretVerifyPlanOutput,
  type VerifyPlan,
  type VerifyPlanDescriptor,
  type VerifyPlanStatus,
} from "@kenkaiiii/gg-core/verify-plan";
import { localProcessLifecycle } from "../tools/operations.js";
import { getSafeToolEnv } from "../tools/safe-env.js";
import { log } from "./logger.js";
import { SANDBOX_ENV_PATCH, prepareSandboxLaunch, type SandboxPolicy } from "./sandbox.js";
import type { ShellResolution } from "./shell.js";
import { SNAPSHOT_MAX_MS, boundedGit, resolveWorkspaceRoot } from "./verification-snapshot.js";
import { verifyPlanDescriptorSha256 } from "./verify-plan-approval.js";

export type VerifyPlanLoadResult =
  { plan: VerifyPlan; reason: null } | { plan: null; reason: string };

export interface VerifyPlanCommandLimits {
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface VerifyPlanLoaderOptions {
  /** Session cwd; the descriptor is read from its git root (the cwd outside git). */
  cwd: string;
  /** The user's consent to run this exact descriptor text; never MCP trust. */
  isApproved: (descriptorText: string) => boolean;
  getSandboxPolicy?: () => SandboxPolicy;
  limits?: VerifyPlanCommandLimits;
}

interface CommandResult {
  stdout: string;
  exitCode: number | null;
  timedOut: boolean;
  oversize: boolean;
  startError: string | null;
}

interface CachedPlan {
  approved: boolean;
  descriptorPath: string | null;
  /** Descriptor text the result was computed from; null when there was none. */
  key: string | null;
  stamp: string;
  result: VerifyPlanLoadResult;
  status: VerifyPlanStatus;
}

export interface CurrentVerifyPlanDescriptor {
  text: string;
  sha256: string;
}

// Bounded wait for "close" after a kill, in case a grandchild holds stdout open.
const KILL_SETTLE_MS = 2_000;
const DESCRIPTOR_SUFFIX = `/${VERIFY_PLAN_DESCRIPTOR_PATH}`;

const heuristics = (reason: string): VerifyPlanLoadResult => ({ plan: null, reason });

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
const WINDOWS_EXE_EXTS = new Set([".com", ".exe"]);
const WINDOWS_BATCH_EXTS = new Set([".bat", ".cmd"]);
// Args that cmd.exe passes through untouched; anything else could inject cmd syntax.
const BATCH_INERT_ARG = /^[A-Za-z0-9_@+=:,./\\-]+$/;
// Characters cmd.exe still interprets inside quotes, or that would end the quoted path.
const BATCH_UNSAFE_PATH = /["%!^]/;

export interface WindowsProgram {
  file: string;
  kind: "exe" | "batch";
}

function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const key = Object.keys(env)
    .filter((candidate) => candidate.toUpperCase() === name)
    .sort()[0];
  return key === undefined ? undefined : env[key];
}

function defaultIsFile(file: string): boolean {
  let stats: Stats;
  try {
    stats = statSync(file);
  } catch {
    return false;
  }
  return stats.isFile();
}

/**
 * Resolve a plan program the way Windows would, since Node can't spawn npm-style
 * `.cmd` shims by bare name. Bare names walk PATH × PATHEXT; anything with a
 * separator resolves against `cwd`. Only .com/.exe/.bat/.cmd results count.
 */
export function resolveWindowsProgram(
  program: string,
  env: Record<string, string | undefined>,
  cwd: string,
  isFile: (file: string) => boolean = defaultIsFile,
): WindowsProgram | null {
  const exts = (envValue(env, "PATHEXT") ?? DEFAULT_PATHEXT)
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext.startsWith("."));
  const own = path.win32.extname(program).toLowerCase();
  const names = own !== "" && exts.includes(own) ? [program] : exts.map((ext) => program + ext);
  const dirs = /[/\\]/.test(program)
    ? [cwd]
    : (envValue(env, "PATH") ?? "")
        .split(";")
        .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
        .filter((dir) => dir !== "" && path.win32.isAbsolute(dir));
  for (const dir of dirs) {
    for (const name of names) {
      const file = path.win32.resolve(dir, name);
      const ext = path.win32.extname(file).toLowerCase();
      const kind = WINDOWS_EXE_EXTS.has(ext) ? "exe" : WINDOWS_BATCH_EXTS.has(ext) ? "batch" : null;
      if (kind !== null && isFile(file)) return { file, kind };
    }
  }
  return null;
}

type PlanProgram = { ok: true; shell: ShellResolution } | { ok: false; reason: string };

/** What to spawn for the plan argv; on Windows, batch files go through cmd.exe. */
function planProgram(
  program: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): PlanProgram {
  if (process.platform !== "win32")
    return { ok: true, shell: { file: program, args, isCmdFallback: false } };
  const resolved = resolveWindowsProgram(program, env, cwd);
  if (resolved === null)
    return {
      ok: false,
      reason: `${VERIFY_PLAN_HEURISTICS_REASONS.nonZeroExit} (program "${program}" not found)`,
    };
  if (resolved.kind === "exe")
    return { ok: true, shell: { file: resolved.file, args, isCmdFallback: false } };
  if (BATCH_UNSAFE_PATH.test(resolved.file) || !args.every((arg) => BATCH_INERT_ARG.test(arg)))
    return {
      ok: false,
      reason: `${VERIFY_PLAN_HEURISTICS_REASONS.nonZeroExit} (.cmd/.bat programs only take plain arguments)`,
    };
  const quoted = resolved.file.includes(" ") ? `"${resolved.file}"` : resolved.file;
  const comspec = envValue(env, "COMSPEC") ?? "C:\\Windows\\System32\\cmd.exe";
  return {
    ok: true,
    shell: {
      file: comspec,
      args: ["/d", "/s", "/c", `"${[quoted, ...args].join(" ")}"`],
      isCmdFallback: true,
    },
  };
}

function statusOf(result: VerifyPlanLoadResult, descriptorPresent: boolean): VerifyPlanStatus {
  return result.plan !== null
    ? { state: "plan", reason: null }
    : { state: "heuristics", reason: result.reason, descriptorPresent };
}

/** Whether `.gg/verify-plan.json` exists in `cwd` or any parent (the git root is one of them). */
async function descriptorMayExist(cwd: string): Promise<boolean> {
  let dir = cwd;
  for (;;) {
    try {
      await fs.access(path.join(dir, VERIFY_PLAN_DESCRIPTOR_PATH));
      return true;
    } catch {
      // Keep walking up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** Absolute command cwd, or null when it would leave the repository root. */
function commandCwd(root: string, descriptor: VerifyPlanDescriptor): string | null {
  const cwd = path.resolve(root, descriptor.command.cwd);
  const relative = path.relative(root, cwd);
  return relative.startsWith("..") || path.isAbsolute(relative) ? null : cwd;
}

function stampOf(file: string): string {
  try {
    const stats = statSync(file);
    return `${stats.size}:${stats.mtimeMs}:${stats.ino}`;
  } catch {
    return "missing";
  }
}

async function readDescriptor(file: string): Promise<string | null> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, "r");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
  try {
    // One byte past the cap is enough for the parser to reject oversize text.
    const buffer = Buffer.alloc(VERIFY_PLAN_DESCRIPTOR_MAX_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    return buffer.subarray(0, total).toString("utf8");
  } finally {
    await handle.close();
  }
}

function runPlanCommand(
  file: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  limits: VerifyPlanCommandLimits,
  signal: AbortSignal,
  windowsVerbatimArguments: boolean,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    let oversize = false;
    let settled = false;
    let settleTimer: NodeJS.Timeout | undefined;
    let child: ChildProcess | undefined;
    const finish = (exitCode: number | null, startError: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(settleTimer);
      signal.removeEventListener("abort", kill);
      child?.stdout?.destroy();
      resolve({
        stdout: Buffer.concat(chunks).toString("utf8"),
        exitCode,
        timedOut,
        oversize,
        startError,
      });
    };
    function kill(): void {
      const target = child;
      if (target?.pid !== undefined && target.exitCode === null && target.signalCode === null) {
        localProcessLifecycle.killProcessTree({
          pid: target.pid,
          isExited: () => target.exitCode !== null || target.signalCode !== null,
        });
      }
      settleTimer ??= setTimeout(() => finish(null, null), KILL_SETTLE_MS);
    }
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, limits.timeoutMs);
    if (signal.aborted) {
      finish(null, "aborted");
      return;
    }
    signal.addEventListener("abort", kill, { once: true });
    try {
      child = localProcessLifecycle.spawn(file, args, {
        cwd,
        env,
        // POSIX tree kill signals the process group; Windows uses taskkill /T.
        detached: process.platform !== "win32",
        windowsVerbatimArguments,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (error) {
      finish(null, error instanceof Error ? error.message : String(error));
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      if (oversize) return;
      bytes += chunk.length;
      if (bytes > limits.maxOutputBytes) {
        oversize = true;
        chunks.length = 0;
        kill();
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", (error) => finish(null, error.message));
    child.once("close", (code) => finish(code, null));
  });
}

/**
 * Per-session cache of the project's verify plan. `get()` is synchronous and
 * never blocks: a changed descriptor or approval yields null (heuristics)
 * and starts a background reload. Nothing runs before the user approves the
 * descriptor's exact text. Nothing here throws.
 */
export class VerifyPlanLoader {
  private readonly cwd: string;
  private readonly isApproved: (descriptorText: string) => boolean;
  private readonly getSandboxPolicy: () => SandboxPolicy;
  private readonly limits: VerifyPlanCommandLimits;
  private readonly controller = new AbortController();
  private cached: CachedPlan | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private scheduled = false;
  /** Bumped by invalidate(); loads started earlier don't store their result. */
  private generation = 0;

  constructor(options: VerifyPlanLoaderOptions) {
    this.cwd = path.resolve(options.cwd);
    this.isApproved = options.isApproved;
    this.getSandboxPolicy =
      options.getSandboxPolicy ?? (() => ({ mode: "off", allowedDomains: [] }));
    this.limits = options.limits ?? VERIFY_PLAN_COMMAND_LIMITS;
  }

  get(): VerifyPlan | null {
    const cached = this.current();
    if (cached === null) {
      this.schedule();
      return null;
    }
    return cached.result.plan;
  }

  /** Last load's status for the app, or null while it is missing or stale. */
  status(): VerifyPlanStatus | null {
    return this.current()?.status ?? null;
  }

  /** Read the descriptor as it is now, for approving exactly what was shown. */
  async readCurrentDescriptor(): Promise<CurrentVerifyPlanDescriptor | null> {
    const root = await this.resolveRoot();
    const text = await readDescriptor(path.join(root, VERIFY_PLAN_DESCRIPTOR_PATH));
    return text === null ? null : { text, sha256: verifyPlanDescriptorSha256(text) };
  }

  /** Load (or confirm) the plan; serialized, cheap while the descriptor is unchanged. */
  refresh(): Promise<VerifyPlanLoadResult> {
    const next = this.queue.then(() => this.load());
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Wait for a pending load at most `maxWaitMs`; a slower load keeps running and lands later. */
  async settle(maxWaitMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, maxWaitMs);
    });
    try {
      await Promise.race([this.refresh(), waited]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Edit/write hook: drop the cached plan when the descriptor itself changed. */
  noteFileMutated(filePath: string): void {
    let normalized = path.resolve(this.cwd, filePath).replace(/\\/g, "/");
    if (process.platform === "win32") normalized = normalized.toLowerCase();
    if (!normalized.endsWith(DESCRIPTOR_SUFFIX)) return;
    this.generation += 1;
    this.cached = null;
    this.schedule();
  }

  dispose(): void {
    this.controller.abort();
    this.cached = null;
  }

  private current(): CachedPlan | null {
    if (this.controller.signal.aborted) return null;
    const cached = this.cached;
    if (
      cached === null ||
      (cached.key !== null && cached.approved !== this.isApproved(cached.key)) ||
      (cached.descriptorPath !== null && stampOf(cached.descriptorPath) !== cached.stamp)
    )
      return null;
    return cached;
  }

  private schedule(): void {
    if (this.scheduled || this.controller.signal.aborted) return;
    this.scheduled = true;
    void this.refresh().finally(() => {
      this.scheduled = false;
    });
  }

  private async load(): Promise<VerifyPlanLoadResult> {
    const generation = this.generation;
    let entry: CachedPlan;
    try {
      entry = await this.compute();
    } catch (error) {
      log("WARN", "verify-plan", "Could not load the verify plan", {
        message: error instanceof Error ? error.message : String(error),
      });
      const result = heuristics(
        `${VERIFY_PLAN_HEURISTICS_REASONS.badDescriptor}: could not be read`,
      );
      entry = {
        approved: false,
        descriptorPath: null,
        key: null,
        stamp: "",
        result,
        status: statusOf(result, true),
      };
    }
    if (generation === this.generation && !this.controller.signal.aborted) this.cached = entry;
    return entry.result;
  }

  private async compute(): Promise<CachedPlan> {
    // Most projects have no descriptor: answer from the filesystem without
    // spawning git (a child in the cwd also blocks deleting it on Windows).
    if (!(await descriptorMayExist(this.cwd))) {
      const result = heuristics(VERIFY_PLAN_HEURISTICS_REASONS.noDescriptor);
      return {
        approved: false,
        descriptorPath: null,
        key: null,
        stamp: "",
        result,
        status: statusOf(result, false),
      };
    }
    const root = await this.resolveRoot();
    const descriptorPath = path.join(root, VERIFY_PLAN_DESCRIPTOR_PATH);
    // Stamp before reading, so a change during the read shows up as a mismatch.
    const stamp = stampOf(descriptorPath);
    const text = await readDescriptor(descriptorPath);
    const approved = text !== null && this.isApproved(text);
    const previous = this.cached;
    if (
      previous !== null &&
      previous.approved === approved &&
      previous.descriptorPath === descriptorPath &&
      previous.key === text
    )
      return { ...previous, stamp };
    // An unapproved descriptor is parsed so its argv can be shown, never run.
    const decision = decideVerifyPlanSource({ trusted: approved, descriptor: text });
    let result: VerifyPlanLoadResult;
    let status: VerifyPlanStatus | null = null;
    if (decision.kind === "run") {
      result = await this.runDescriptor(decision.descriptor, root);
    } else if (decision.kind === "needs-approval") {
      const cwd = commandCwd(root, decision.descriptor);
      if (cwd === null || text === null) {
        result = heuristics(`${VERIFY_PLAN_HEURISTICS_REASONS.badDescriptor}: command.cwd`);
      } else {
        result = heuristics(decision.reason);
        status = {
          state: "needs-approval",
          reason: decision.reason,
          argv: [...decision.descriptor.command.argv],
          cwd,
          descriptorSha256: verifyPlanDescriptorSha256(text),
        };
      }
    } else {
      result = heuristics(decision.reason);
    }
    if (result.plan === null && text !== null)
      log("INFO", "verify-plan", "Using heuristics instead of the project plan", {
        reason: result.reason,
      });
    return {
      approved,
      descriptorPath,
      key: text,
      stamp,
      result,
      status: status ?? statusOf(result, text !== null),
    };
  }

  private async resolveRoot(): Promise<string> {
    try {
      const git = boundedGit(this.cwd, Date.now() + SNAPSHOT_MAX_MS, this.controller.signal);
      return await resolveWorkspaceRoot(git);
    } catch {
      return this.cwd;
    }
  }

  private async runDescriptor(
    descriptor: VerifyPlanDescriptor,
    root: string,
  ): Promise<VerifyPlanLoadResult> {
    const [program, ...args] = descriptor.command.argv;
    const cwd = commandCwd(root, descriptor);
    if (program === undefined || cwd === null)
      return heuristics(`${VERIFY_PLAN_HEURISTICS_REASONS.badDescriptor}: command.cwd`);
    const safeEnv = getSafeToolEnv();
    const target = planProgram(program, args, cwd, safeEnv);
    if (!target.ok) {
      log("WARN", "verify-plan", "Plan command not run", { reason: target.reason });
      return heuristics(target.reason);
    }
    let launch;
    try {
      launch = await prepareSandboxLaunch(target.shell, root, this.getSandboxPolicy());
    } catch (error) {
      log("WARN", "verify-plan", "OS sandbox unavailable; plan command not run", {
        message: error instanceof Error ? error.message : String(error),
      });
      return heuristics(`${VERIFY_PLAN_HEURISTICS_REASONS.nonZeroExit} (sandbox unavailable)`);
    }
    const env = launch.sandboxed ? { ...safeEnv, ...SANDBOX_ENV_PATCH } : safeEnv;
    const run = await runPlanCommand(
      launch.file,
      launch.args,
      cwd,
      env,
      this.limits,
      this.controller.signal,
      // Only cmd.exe itself takes verbatim args; the sandbox CLI needs normal quoting.
      launch.isCmdFallback && !launch.sandboxed,
    );
    if (run.startError !== null && !run.timedOut) {
      log("WARN", "verify-plan", "Plan command could not start", { message: run.startError });
      return heuristics(`${VERIFY_PLAN_HEURISTICS_REASONS.nonZeroExit} (could not start)`);
    }
    if (run.oversize && !run.timedOut) return heuristics(VERIFY_PLAN_HEURISTICS_REASONS.oversize);
    const outcome = interpretVerifyPlanOutput(
      descriptor.format,
      run.stdout,
      run.exitCode,
      run.timedOut,
    );
    return outcome.kind === "plan"
      ? { plan: outcome.plan, reason: null }
      : heuristics(outcome.reason);
  }
}
