import { AsyncLocalStorage } from "node:async_hooks";

export const QWEN_UNATTENDED_ERROR =
  "Qwen Cloud Token Plan is available only for user-initiated interactive coding and agent-tool runs, not unattended or batch execution.";
export const UNATTENDED_AGENT_ENV = "GG_AGENT_UNATTENDED";
const unattendedRuns = new AsyncLocalStorage<boolean>();

export function isUnattendedExecution(): boolean {
  return unattendedRuns.getStore() === true;
}

/** Execution intent, not terminal presence: trusted delegated workers use pipes too. */
export function isUnattendedWorker(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[UNATTENDED_AGENT_ENV] === "1" || !/^[1-9]\d*$/.test(env.GG_SUBAGENT_DEPTH ?? "");
}

export function assertProviderExecutionAllowed(provider: string, unattended = false): void {
  if (provider === "qwen-cloud" && (unattended || isUnattendedExecution())) {
    throw new Error(QWEN_UNATTENDED_ERROR);
  }
}

/** Async-local intent cannot leak from an unattended run into another desktop pane. */
export function runUnattended<T>(run: () => T): T {
  return unattendedRuns.run(true, run);
}
