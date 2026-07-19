import { spawn, spawnSync } from "node:child_process";
import { log } from "../core/logger.js";

/** Kill a process and its descendants on the current platform. */
export function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (result.status === 0) return;
  } else {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // Fall through when the process has no group or already exited.
    }
  }
  killSingleProcess(pid);
}

export interface AsyncProcessTreeKillOptions {
  platform?: NodeJS.Platform;
  spawn?: typeof spawn;
  kill?: typeof process.kill;
}

function killSingleProcess(pid: number, kill: typeof process.kill = process.kill): void {
  try {
    kill(pid, "SIGKILL");
  } catch {
    // Process already exited.
  }
}

/**
 * Kill a process tree without blocking the Node.js event loop.
 *
 * Windows taskkill is detached from the host timer lifecycle: callers may
 * deliberately fire-and-forget this promise. Cleanup failures are logged and
 * swallowed because process teardown must never delay tool settlement.
 */
export async function killProcessTreeAsync(
  pid: number,
  options: AsyncProcessTreeKillOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const kill = options.kill ?? process.kill;

  try {
    if (platform !== "win32") {
      try {
        kill(-pid, "SIGKILL");
        return;
      } catch {
        killSingleProcess(pid, kill);
        return;
      }
    }

    const killer = (options.spawn ?? spawn)("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.unref();
    const succeeded = await new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (result: boolean): void => {
        if (settled) return;
        settled = true;
        killer.off("error", onError);
        killer.off("close", onClose);
        resolve(result);
      };
      const onError = (): void => settle(false);
      const onClose = (code: number | null): void => settle(code === 0);
      killer.once("error", onError);
      killer.once("close", onClose);
    });
    if (!succeeded) killSingleProcess(pid, kill);
  } catch (error) {
    killSingleProcess(pid, kill);
    log("WARN", "process", "Asynchronous process-tree cleanup failed", {
      pid: String(pid),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
