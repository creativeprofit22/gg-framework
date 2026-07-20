import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { log } from "../core/logger.js";

const TASKKILL_ARGUMENTS = (pid: number): string[] => ["/PID", String(pid), "/T", "/F"];
const DEFAULT_TASKKILL_TIMEOUT_MS = 5_000;

export interface ProcessTreeKillOptions {
  platform?: NodeJS.Platform;
  spawn?: typeof spawn;
  spawnSync?: typeof spawnSync;
  kill?: typeof process.kill;
  env?: NodeJS.ProcessEnv;
  taskkillTimeoutMs?: number;
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

function isPidAlive(pid: number, kill: typeof process.kill): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    return true;
  }
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
    try {
      kill(-pid, "SIGKILL");
      return;
    } catch {
      killSingleProcess(pid, kill);
      return;
    }
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

/**
 * Kill a process tree without blocking the Node.js event loop.
 *
 * Cleanup failures are logged and swallowed because process teardown must not
 * alter the tool's already-determined timeout or abort result.
 */
export async function killProcessTreeAsync(
  pid: number,
  options: AsyncProcessTreeKillOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const kill = options.kill ?? process.kill;

  if (platform !== "win32") {
    try {
      kill(-pid, "SIGKILL");
    } catch {
      killSingleProcess(pid, kill);
    }
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
