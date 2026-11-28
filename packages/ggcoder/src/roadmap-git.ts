import { execFile } from "node:child_process";
import { withoutQwenRuntimeSecret } from "./tools/safe-env.js";
import { resolveGitBinary } from "./utils/git.js";

// Approval is a human action: a slow answer from a busy disk beats a false failure.
export const ROADMAP_SNAPSHOT_BUDGET_MS = 90_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const STDERR_LINE_MAX = 300;

export type RoadmapGitFailureKind = "timeout" | "exit" | "spawn";

export class RoadmapGitError extends Error {
  readonly subcommand: string;
  readonly kind: RoadmapGitFailureKind;
  readonly exitCode: number | null;
  readonly stderrLine: string;
  readonly elapsedMs: number;

  constructor(details: {
    subcommand: string;
    kind: RoadmapGitFailureKind;
    exitCode: number | null;
    stderrLine: string;
    elapsedMs: number;
  }) {
    super(
      `git ${details.subcommand} ${details.kind === "timeout" ? "timed out" : "failed"}` +
        (details.stderrLine ? `: ${details.stderrLine}` : ""),
    );
    this.name = "RoadmapGitError";
    this.subcommand = details.subcommand;
    this.kind = details.kind;
    this.exitCode = details.exitCode;
    this.stderrLine = details.stderrLine;
    this.elapsedMs = details.elapsedMs;
  }
}

export interface RoadmapGitExecOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
  windowsHide: true;
}

/** Rejects like `execFile`: `killed`, `code`, plus the captured `stderr`. */
export type RoadmapGitExec = (
  file: string,
  args: string[],
  options: RoadmapGitExecOptions,
) => Promise<Buffer>;

export type RoadmapGit = (args: string[]) => Promise<Buffer>;

export interface RoadmapGitOptions {
  /** Absolute epoch-ms deadline shared by every call of this runner. */
  deadlineMs?: number;
  exec?: RoadmapGitExec;
  now?: () => number;
}

export function roadmapGitEnv(sourceEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...withoutQwenRuntimeSecret(sourceEnv),
    // Read-only snapshots must not take .git/index.lock from a concurrent commit.
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
  };
}

export function createRoadmapGit(cwd: string, options: RoadmapGitOptions = {}): RoadmapGit {
  const now = options.now ?? Date.now;
  const exec = options.exec ?? defaultExec;
  const deadline = options.deadlineMs ?? now() + ROADMAP_SNAPSHOT_BUDGET_MS;
  return async (args) => {
    const subcommand = args.find((arg) => !arg.startsWith("-")) ?? "git";
    const started = now();
    const remaining = deadline - started;
    if (remaining <= 0) {
      throw new RoadmapGitError({
        subcommand,
        kind: "timeout",
        exitCode: null,
        stderrLine: "",
        elapsedMs: 0,
      });
    }
    try {
      return await exec(resolveGitBinary(), args, {
        cwd,
        env: roadmapGitEnv(),
        timeout: remaining,
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: true,
      });
    } catch (error) {
      throw toRoadmapGitError(error, subcommand, now() - started);
    }
  };
}

function toRoadmapGitError(error: unknown, subcommand: string, elapsedMs: number): RoadmapGitError {
  const failure = (error ?? {}) as {
    code?: unknown;
    killed?: unknown;
    stderr?: unknown;
    message?: unknown;
  };
  const stderrLine = firstLine(failure.stderr);
  // String codes (ENOENT, EACCES, maxBuffer) mean Git never produced a usable answer.
  if (typeof failure.code === "string") {
    return new RoadmapGitError({
      subcommand,
      kind: "spawn",
      exitCode: null,
      stderrLine: stderrLine || failure.code,
      elapsedMs,
    });
  }
  if (failure.killed === true) {
    return new RoadmapGitError({
      subcommand,
      kind: "timeout",
      exitCode: null,
      stderrLine,
      elapsedMs,
    });
  }
  return new RoadmapGitError({
    subcommand,
    kind: "exit",
    exitCode: typeof failure.code === "number" ? failure.code : null,
    stderrLine: stderrLine || firstLine(failure.message),
    elapsedMs,
  });
}

function firstLine(value: unknown): string {
  const text = Buffer.isBuffer(value)
    ? value.toString("utf8")
    : typeof value === "string"
      ? value
      : "";
  const line = text.split(/\r?\n/).find((entry) => entry.trim()) ?? "";
  return line.trim().slice(0, STDERR_LINE_MAX);
}

const defaultExec: RoadmapGitExec = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { ...options, encoding: "buffer" }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr }));
      else resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
    });
  });
