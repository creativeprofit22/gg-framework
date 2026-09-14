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

export interface ProjectTask {
  id: string;
  title: string;
  prompt: string;
  status: ProjectTaskStatus;
  createdAt: string;
}
