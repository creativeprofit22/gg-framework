import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { log } from "../core/logger.js";

const TASKKILL_ARGUMENTS = (pid: number): string[] => ["/PID", String(pid), "/T", "/F"];
const DEFAULT_TASKKILL_TIMEOUT_MS = 5_000;
const POSIX_PS_PATH = "/bin/ps";
const POSIX_PS_ARGUMENTS = ["-A", "-o", "pid=,ppid="];
const DEFAULT_POSIX_PS_TIMEOUT_MS = 150;
const DEFAULT_POSIX_PS_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_POSIX_MAX_DESCENDANTS = 1_024;
export const DEFAULT_POSIX_TERM_GRACE_MS = 500;

export interface ProcessTreeKillOptions {
  platform?: NodeJS.Platform;
  spawn?: typeof spawn;
  spawnSync?: typeof spawnSync;
  kill?: typeof process.kill;
  env?: NodeJS.ProcessEnv;
  taskkillTimeoutMs?: number;
  posixGraceMs?: number;
  posixPsTimeoutMs?: number;
  posixPsOutputBytes?: number;
  posixMaxDescendants?: number;
}

export type AsyncProcessTreeKillOptions = ProcessTreeKillOptions;

function getEnvCaseInsensitive(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const normalizedName = name.toLowerCase();
  return Object.entries(env).find(([key]) => key.toLowerCase() === normalizedName)?.[1];
}

export function normalizeWindowsSystemRoot(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const root = value.trim();
  const hasUnsafeCharacter = [...root].some((character) => {
    const code = character.charCodeAt(0);
    return character === ";" || code <= 31 || code === 127;
  });
  if (!/^[A-Za-z]:[\\/]/.test(root) || hasUnsafeCharacter) return undefined;
  return path.win32.normalize(root);
}

export function resolveWindowsTaskkillPath(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot =
    normalizeWindowsSystemRoot(getEnvCaseInsensitive(env, "SystemRoot")) ??
    normalizeWindowsSystemRoot(getEnvCaseInsensitive(env, "WINDIR")) ??
    "C:\\Windows";
  return path.win32.join(systemRoot, "System32", "taskkill.exe");
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0;
}

function isPidAlive(pid: number, kill: typeof process.kill): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    return true;
  }
}

function warnPosix(message: string, pid: number, details: Record<string, string> = {}): void {
  log("WARN", "process", message, { pid: String(pid), ...details });
}

function parseDescendants(output: string, rootPid: number, maximum: number): number[] {
  const children = new Map<number, number[]>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    if (!validPid(pid) || !validPid(parentPid) || pid === rootPid) continue;
    const siblings = children.get(parentPid) ?? [];
    siblings.push(pid);
    children.set(parentPid, siblings);
  }

  const descendants: Array<{ pid: number; depth: number }> = [];
  const seen = new Set<number>([rootPid]);
  const queue: Array<{ pid: number; depth: number }> = [{ pid: rootPid, depth: 0 }];
  while (queue.length > 0 && descendants.length < maximum) {
    const parent = queue.shift()!;
    for (const childPid of children.get(parent.pid) ?? []) {
      if (seen.has(childPid)) continue;
      seen.add(childPid);
      const child = { pid: childPid, depth: parent.depth + 1 };
      descendants.push(child);
      queue.push(child);
      if (descendants.length >= maximum) break;
    }
  }
  return descendants.sort((a, b) => b.depth - a.depth).map(({ pid }) => pid);
}

function snapshotDescendantsSync(pid: number, options: ProcessTreeKillOptions): number[] {
  try {
    const result = (options.spawnSync ?? spawnSync)(POSIX_PS_PATH, POSIX_PS_ARGUMENTS, {
      encoding: "utf8",
      timeout: options.posixPsTimeoutMs ?? DEFAULT_POSIX_PS_TIMEOUT_MS,
      maxBuffer: options.posixPsOutputBytes ?? DEFAULT_POSIX_PS_OUTPUT_BYTES,
      windowsHide: true,
    });
    if (result.error !== undefined || result.status !== 0) {
      throw result.error ?? new Error(`ps exited with status ${String(result.status)}`);
    }
    return parseDescendants(
      typeof result.stdout === "string" ? result.stdout : "",
      pid,
      options.posixMaxDescendants ?? DEFAULT_POSIX_MAX_DESCENDANTS,
    );
  } catch (error) {
    warnPosix("POSIX descendant snapshot failed", pid, { error: errorDetail(error) });
    return [];
  }
}

async function snapshotDescendantsAsync(
  pid: number,
  options: AsyncProcessTreeKillOptions,
): Promise<number[]> {
  let helper: ChildProcess;
  try {
    helper = (options.spawn ?? spawn)(POSIX_PS_PATH, POSIX_PS_ARGUMENTS, {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch (error) {
    warnPosix("POSIX descendant snapshot failed", pid, { error: errorDetail(error) });
    return [];
  }

  const outputLimit = options.posixPsOutputBytes ?? DEFAULT_POSIX_PS_OUTPUT_BYTES;
  const result = await new Promise<{ output?: string; error?: unknown }>((resolve) => {
    let settled = false;
    let output = "";
    let overflow = false;
    let timedOut = false;
    let reapTimer: NodeJS.Timeout | undefined;
    const stdout = helper.stdout;
    const settle = (value: { output?: string; error?: unknown }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (reapTimer) clearTimeout(reapTimer);
      helper.off("error", onError);
      helper.off("close", onClose);
      stdout?.off("data", onData);
      resolve(value);
    };
    const onData = (chunk: Buffer | string): void => {
      if (overflow) return;
      output += chunk.toString();
      if (Buffer.byteLength(output) > outputLimit) {
        overflow = true;
        try {
          helper.kill("SIGKILL");
        } catch {
          // The bounded snapshot will settle through close or its timeout.
        }
      }
    };
    const onError = (error: Error): void => settle({ error });
    const onClose = (status: number | null): void => {
      if (timedOut) settle({ error: new Error("ps timed out") });
      else if (overflow) settle({ error: new Error("ps output exceeded limit") });
      else if (status === 0) settle({ output });
      else settle({ error: new Error(`ps exited with status ${String(status)}`) });
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        helper.kill("SIGKILL");
      } catch {
        // Settlement still proceeds and direct-PID fallback remains available.
      }
      // Normally SIGKILL produces close immediately; retain a hard bound for a broken handle.
      reapTimer = setTimeout(() => settle({ error: new Error("ps timed out") }), 50);
    }, options.posixPsTimeoutMs ?? DEFAULT_POSIX_PS_TIMEOUT_MS);
    helper.once("error", onError);
    helper.once("close", onClose);
    stdout?.on("data", onData);
  });

  if (result.error !== undefined) {
    warnPosix("POSIX descendant snapshot failed", pid, { error: errorDetail(result.error) });
    return [];
  }
  return parseDescendants(
    result.output ?? "",
    pid,
    options.posixMaxDescendants ?? DEFAULT_POSIX_MAX_DESCENDANTS,
  );
}

function fallbackSignal(
  pid: number,
  descendants: number[],
  signal: NodeJS.Signals,
  kill: typeof process.kill,
): void {
  for (const targetPid of [...descendants, pid]) {
    if (!isPidAlive(targetPid, kill)) continue;
    try {
      kill(targetPid, signal);
    } catch (error) {
      if (!isPidAlive(targetPid, kill)) continue;
      warnPosix("POSIX process cleanup fallback failed", pid, {
        targetPid: String(targetPid),
        signal,
        error: errorDetail(error),
      });
    }
  }
}

function signalPosixGroup(
  pid: number,
  descendants: number[],
  signal: NodeJS.Signals,
  kill: typeof process.kill,
): "sent" | "dead" | "failed" {
  try {
    kill(-pid, signal);
    return "sent";
  } catch (error) {
    if (errorCode(error) === "ESRCH") return "dead";
    const targetsAlive =
      descendants.some((targetPid) => isPidAlive(targetPid, kill)) || isPidAlive(pid, kill);
    if (!targetsAlive) return "dead";
    warnPosix("POSIX process-group cleanup failed", pid, {
      signal,
      error: errorDetail(error),
    });
    fallbackSignal(pid, descendants, signal, kill);
    return "failed";
  }
}

function posixTargetsAlive(
  pid: number,
  descendants: number[],
  groupAvailable: boolean,
  kill: typeof process.kill,
): boolean {
  if (groupAvailable && isPidAlive(-pid, kill)) return true;
  return descendants.some((targetPid) => isPidAlive(targetPid, kill)) || isPidAlive(pid, kill);
}

function warnTaskkillFailure(
  pid: number,
  executable: string,
  failureKind: "access-denied" | "launch" | "non-zero" | "timed-out",
  details: { error?: unknown; status?: number | null; signal?: NodeJS.Signals | null },
): void {
  log("WARN", "process", "Windows process-tree cleanup failed", {
    pid: String(pid),
    executable,
    failureKind,
    ...(details.status === undefined ? {} : { status: String(details.status) }),
    ...(details.signal == null ? {} : { signal: details.signal }),
    ...(details.error === undefined ? {} : { error: errorDetail(details.error) }),
  });
}

function killSingleProcess(pid: number, kill: typeof process.kill): void {
  try {
    kill(pid, "SIGKILL");
  } catch (error) {
    if (!isPidAlive(pid, kill)) return;
    log("WARN", "process", "Direct PID cleanup fallback failed", {
      pid: String(pid),
      error: errorDetail(error),
    });
  }
}

function handleWindowsTaskkillFailure(
  pid: number,
  executable: string,
  kill: typeof process.kill,
  details: {
    error?: unknown;
    status?: number | null;
    signal?: NodeJS.Signals | null;
    timedOut?: boolean;
  },
): void {
  if (!isPidAlive(pid, kill)) return;
  const code = errorCode(details.error);
  warnTaskkillFailure(
    pid,
    executable,
    details.timedOut
      ? "timed-out"
      : code === "EACCES" || code === "EPERM"
        ? "access-denied"
        : details.error !== undefined
          ? "launch"
          : "non-zero",
    details,
  );
  killSingleProcess(pid, kill);
}

/** Kill a process and its descendants on the current platform. */
export function killProcessTree(pid: number, options: ProcessTreeKillOptions = {}): void {
  const platform = options.platform ?? process.platform;
  const kill = options.kill ?? process.kill;

  if (platform !== "win32") {
    if (!validPid(pid)) {
      warnPosix("Refusing to clean up an invalid POSIX PID", pid);
      return;
    }
    const descendants = snapshotDescendantsSync(pid, options);
    signalPosixGroup(pid, descendants, "SIGKILL", kill);
    return;
  }

  if (!isPidAlive(pid, kill)) return;
  const executable = resolveWindowsTaskkillPath(options.env);
  try {
    const result = (options.spawnSync ?? spawnSync)(executable, TASKKILL_ARGUMENTS(pid), {
      stdio: "ignore",
      windowsHide: true,
      timeout: options.taskkillTimeoutMs ?? DEFAULT_TASKKILL_TIMEOUT_MS,
    });
    if (result.status === 0 && result.error === undefined) return;
    handleWindowsTaskkillFailure(pid, executable, kill, {
      error: result.error,
      status: result.status,
      signal: result.signal,
    });
  } catch (error) {
    handleWindowsTaskkillFailure(pid, executable, kill, { error });
  }
}

/** Gracefully terminate a process tree, escalating without replacing the caller's outcome. */
export async function killProcessTreeAsync(
  pid: number,
  options: AsyncProcessTreeKillOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const kill = options.kill ?? process.kill;

  if (platform !== "win32") {
    if (!validPid(pid)) {
      warnPosix("Refusing to clean up an invalid POSIX PID", pid);
      return;
    }
    const descendants = await snapshotDescendantsAsync(pid, options);
    const termResult = signalPosixGroup(pid, descendants, "SIGTERM", kill);
    if (termResult === "dead") return;
    await new Promise<void>((resolve) =>
      setTimeout(resolve, options.posixGraceMs ?? DEFAULT_POSIX_TERM_GRACE_MS),
    );
    if (!posixTargetsAlive(pid, descendants, termResult === "sent", kill)) return;
    signalPosixGroup(pid, descendants, "SIGKILL", kill);
    return;
  }

  if (!isPidAlive(pid, kill)) return;
  const executable = resolveWindowsTaskkillPath(options.env);
  let killer: ReturnType<typeof spawn>;
  try {
    killer = (options.spawn ?? spawn)(executable, TASKKILL_ARGUMENTS(pid), {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch (error) {
    handleWindowsTaskkillFailure(pid, executable, kill, { error });
    return;
  }

  killer.unref();
  const failure = await new Promise<
    | { error: unknown; status?: undefined; signal?: undefined; timedOut?: undefined }
    | {
        error?: undefined;
        status: number | null;
        signal: NodeJS.Signals | null;
        timedOut?: undefined;
      }
    | { error?: undefined; status?: undefined; signal?: undefined; timedOut: true }
    | undefined
  >((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settle({ timedOut: true });
      try {
        killer.kill("SIGKILL");
      } catch {
        // The direct target-PID fallback below still runs after a taskkill timeout.
      }
      killer.unref();
    }, options.taskkillTimeoutMs ?? DEFAULT_TASKKILL_TIMEOUT_MS);
    const settle = (result: Parameters<typeof resolve>[0]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      killer.off("error", onError);
      killer.off("close", onClose);
      resolve(result);
    };
    const onError = (error: Error): void => settle({ error });
    const onClose = (status: number | null, signal: NodeJS.Signals | null): void =>
      settle(status === 0 ? undefined : { status, signal });
    killer.once("error", onError);
    killer.once("close", onClose);
  });

  if (failure !== undefined) {
    handleWindowsTaskkillFailure(pid, executable, kill, failure);
  }
}
