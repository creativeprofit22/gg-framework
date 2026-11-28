import { assertProviderExecutionAllowed } from "../core/provider-execution-policy.js";
import {
  finalizeTaskRun,
  markTaskInProgress,
  type TaskRunSettlement,
} from "../core/tasks-store.js";

/** Shared by initial task starts and delayed auto-advance, before session/UI mutation. */
export function admitTerminalTask(
  provider: string,
  cwd: string,
  taskId: string,
  unattended: boolean,
): void {
  assertProviderExecutionAllowed(provider, unattended);
  markTaskInProgress(cwd, taskId);
}

/**
 * Settle a terminal task run the same way the desktop runner does: done only
 * with completion evidence, otherwise blocked with the reason. Returns whether
 * Run All may advance — only past a done task or one removed mid-run, so the
 * batch pauses on a blocked task instead of silently skipping it.
 */
export function settleTerminalTask(
  cwd: string,
  taskId: string,
  settlement: TaskRunSettlement,
): boolean {
  const status = finalizeTaskRun(cwd, taskId, settlement);
  return status === "done" || status === null;
}
