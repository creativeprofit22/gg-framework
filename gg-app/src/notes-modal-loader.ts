import type { NotesModalContent } from "./NotesModal";

type Content = typeof NotesModalContent;
let content: Content | null = null;
let pending: Promise<Content> | null = null;

export function loadedNotesModalContent(): Content | null {
  return content;
}

/** Share successful loads across panes, but do not cache a rejected load. */
export function loadNotesModalContent(): Promise<Content> {
  pending ??= import("./NotesModal").then(
    (module) => {
      content = module.NotesModalContent;
      return content;
    },
    (error: unknown) => {
      pending = null;
      throw error;
    },
  );
  return pending;
}
