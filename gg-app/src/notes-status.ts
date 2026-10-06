import { isNotesPhasePresent } from "@kenkaiiii/gg-core/project-notes";
import type { NotesDocumentV3 } from "./notes-types";

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
