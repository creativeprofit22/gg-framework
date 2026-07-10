import type { NotesDocumentV2 } from "./notes-types";

export function getUnfinishedNotesTaskCount(document: NotesDocumentV2): number {
  return document.tasks.filter((task) => task.status === "todo" && task.archivedAt === null).length;
}

export function isNotesHandoffUnread(document: NotesDocumentV2): boolean {
  const { handoff } = document;
  if (handoff.text.trim().length === 0 || handoff.updatedAt === null) return false;
  if (handoff.readAt === null) return true;
  return Date.parse(handoff.readAt) < Date.parse(handoff.updatedAt);
}
