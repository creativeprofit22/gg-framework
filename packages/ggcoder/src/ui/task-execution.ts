import { assertProviderExecutionAllowed } from "../core/provider-execution-policy.js";
import { markTaskInProgress } from "../core/tasks-store.js";

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
