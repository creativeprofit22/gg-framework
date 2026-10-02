import type { BackgroundTask } from "./agent";

/**
 * Liveness comes from the daemon's `isRunning`; `exitCode` alone is wrong because
 * signal exits (user kill, watchdog stop) keep a null code. Older daemons omit
 * `isRunning`, so fall back to the legacy exit-code check for them.
 */
export function isBackgroundTaskRunning(task: BackgroundTask): boolean {
  return typeof task.isRunning === "boolean" ? task.isRunning : task.exitCode === null;
}

/** Status label mirroring the ggcoder TUI's `formatBackgroundTaskStatus`. */
export function formatBackgroundTaskStatus(task: BackgroundTask): string {
  if (isBackgroundTaskRunning(task)) return `pid ${task.pid}`;
  if (task.stopReason === "inactive") return "stopped: no output";
  if (task.stopReason === "timedOut") return "stopped: time limit";
  if (task.signal) return `signal ${task.signal}`;
  if (task.exitCode !== null) return `exit ${task.exitCode}`;
  return "completed";
}
