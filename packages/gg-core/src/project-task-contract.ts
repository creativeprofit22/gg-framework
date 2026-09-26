export const PROJECT_TASK_STATUSES = ["pending", "in-progress", "done", "blocked"] as const;

export type KnownProjectTaskStatus = (typeof PROJECT_TASK_STATUSES)[number];
export type ProjectTaskStatus = KnownProjectTaskStatus | (string & Record<never, never>);

export const RUNNABLE_TASK_STATUSES = ["pending", "blocked"] as const;
export type RunnableTaskStatus = (typeof RUNNABLE_TASK_STATUSES)[number];

export const MANUALLY_RUNNABLE_TASK_STATUSES = ["pending", "blocked", "in-progress"] as const;
export type ManuallyRunnableTaskStatus = (typeof MANUALLY_RUNNABLE_TASK_STATUSES)[number];

export function isRunnableTaskStatus(status: ProjectTaskStatus): status is RunnableTaskStatus {
  return (RUNNABLE_TASK_STATUSES as readonly ProjectTaskStatus[]).includes(status);
}

export function isManuallyRunnableTaskStatus(
  status: ProjectTaskStatus,
): status is ManuallyRunnableTaskStatus {
  return (MANUALLY_RUNNABLE_TASK_STATUSES as readonly ProjectTaskStatus[]).includes(status);
}

/**
 * Why the most recent run of a task ended `blocked`. Informational only: it
 * never changes `status` or run eligibility. `run-failed` covers the agent turn
 * itself erroring before any review could happen.
 */
export const PROJECT_TASK_BLOCK_REASONS = [
  "review-failed",
  "run-failed",
  "cancelled",
  "plan-mode",
  "plan-checkpoint",
  "queued-messages",
] as const;

export type KnownProjectTaskBlockReason = (typeof PROJECT_TASK_BLOCK_REASONS)[number];
export type ProjectTaskBlockReason = KnownProjectTaskBlockReason | (string & Record<never, never>);

export interface ProjectTaskOutcome {
  reason: ProjectTaskBlockReason;
  /** ISO timestamp of when the run was finalized. */
  at: string;
}

export interface ProjectTask {
  id: string;
  title: string;
  prompt: string;
  status: ProjectTaskStatus;
  createdAt: string;
  /** Set when the last run ended blocked; cleared when a later run succeeds. */
  lastOutcome?: ProjectTaskOutcome;
}
