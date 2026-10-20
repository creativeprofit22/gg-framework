import { isNotesPhasePresent } from "@kenkaiiii/gg-core/project-notes";
import type { NotesDocumentV3, NotesPhase, NotesTask } from "./notes-types";

export function getUnfinishedNotesTaskCount(document: NotesDocumentV3): number {
  return document.tasks.filter((task) => task.status === "todo" && task.archivedAt === null).length;
}

export function getSavedPromptCount(document: NotesDocumentV3): number {
  return document.phases.filter(
    (phase) =>
      isNotesPhasePresent(phase) &&
      phase.archivedAt === null &&
      phase.sourcePrompt.trim().length > 0,
  ).length;
}

export function isNotesHandoffUnread(document: NotesDocumentV3): boolean {
  const { handoff } = document;
  if (handoff.text.trim().length === 0 || handoff.updatedAt === null) return false;
  if (handoff.readAt === null) return true;
  return Date.parse(handoff.readAt) < Date.parse(handoff.updatedAt);
}

function isActivePhase(status: NotesDocumentV3["phases"][number]["status"]): boolean {
  return status !== "done" && status !== "cancelled";
}

/** Present, not archived, and not settled (done or cancelled). */
export function isActiveNotesPhase(phase: NotesDocumentV3["phases"][number]): boolean {
  return isNotesPhasePresent(phase) && phase.archivedAt === null && isActivePhase(phase.status);
}

export function getActiveNotesPhaseCount(document: NotesDocumentV3): number {
  return document.phases.filter(isActiveNotesPhase).length;
}

export function activePhaseCountLabel(count: number): string {
  if (count === 0) return "No active phases";
  return `${count} active phase${count === 1 ? "" : "s"}`;
}

export function getActiveNotesReminderCount(document: NotesDocumentV3): number {
  return document.phases.filter(
    (phase) =>
      isNotesPhasePresent(phase) &&
      phase.archivedAt === null &&
      isActivePhase(phase.status) &&
      phase.reminder !== null,
  ).length;
}

export function getDueNotesReminderCount(document: NotesDocumentV3): number {
  return document.phases.filter((phase) => {
    const reminder = phase.reminder;
    return (
      isNotesPhasePresent(phase) &&
      phase.archivedAt === null &&
      isActivePhase(phase.status) &&
      reminder !== null &&
      reminder.lastDelivery?.occurrenceKey === reminder.occurrenceKey
    );
  }).length;
}

/** The only predicate that decides whether a phase belongs in the Completed group. */
export function isCompletedNotesPhase(phase: NotesPhase): boolean {
  return phase.status === "done";
}

/** The only predicate that decides whether a task belongs in the Completed group. */
export function isCompletedNotesTask(task: NotesTask): boolean {
  return task.status === "done";
}

export interface NotesGroups<T> {
  open: T[];
  completed: T[];
}

/** Present, non-archived phases split into open and completed, document order preserved. */
export function groupNotesPhases(phases: readonly NotesPhase[]): NotesGroups<NotesPhase> {
  const groups: NotesGroups<NotesPhase> = { open: [], completed: [] };
  for (const phase of phases) {
    if (!isNotesPhasePresent(phase) || phase.archivedAt !== null) continue;
    (isCompletedNotesPhase(phase) ? groups.completed : groups.open).push(phase);
  }
  return groups;
}

/** Non-archived tasks split into open and completed, document order preserved. */
export function groupNotesTasks(tasks: readonly NotesTask[]): NotesGroups<NotesTask> {
  const groups: NotesGroups<NotesTask> = { open: [], completed: [] };
  for (const task of tasks) {
    if (task.archivedAt !== null) continue;
    (isCompletedNotesTask(task) ? groups.completed : groups.open).push(task);
  }
  return groups;
}

export interface NotesRoadmapProgress {
  done: number;
  /** Visible phases minus cancelled ones. */
  total: number;
  /** done ÷ total, or null when nothing counts toward progress. */
  ratio: number | null;
}

/** Single source for Roadmap progress: done ÷ (visible − cancelled). */
export function selectNotesRoadmapProgress(phases: readonly NotesPhase[]): NotesRoadmapProgress {
  let done = 0;
  let total = 0;
  for (const phase of phases) {
    if (!isNotesPhasePresent(phase) || phase.archivedAt !== null) continue;
    if (phase.status === "cancelled") continue;
    total += 1;
    if (isCompletedNotesPhase(phase)) done += 1;
  }
  return { done, total, ratio: total === 0 ? null : done / total };
}

export function roadmapProgressLabel(progress: NotesRoadmapProgress): string | null {
  if (progress.total === 0) return null;
  return `${progress.done} of ${progress.total} phase${progress.total === 1 ? "" : "s"} done`;
}
