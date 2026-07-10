import { describe, expect, it } from "vitest";
import { getUnfinishedNotesTaskCount, isNotesHandoffUnread } from "./notes-status";
import type { NotesDocumentV2, NotesTask } from "./notes-types";

const NOW = "2026-07-09T12:00:00.000Z";

function task(overrides: Partial<NotesTask>): NotesTask {
  return {
    id: "task",
    text: "Task",
    status: "todo",
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

function document(overrides: Partial<NotesDocumentV2> = {}): NotesDocumentV2 {
  return {
    version: 2,
    reference: "",
    currentFocus: "",
    tasks: [],
    handoff: { text: "", updatedAt: null, readAt: null },
    updatedAt: NOW,
    legacyImportedAt: null,
    ...overrides,
  };
}

describe("notes status", () => {
  it("counts only active todo tasks", () => {
    const notes = document({
      tasks: [
        task({ id: "active-todo" }),
        task({ id: "done", status: "done", completedAt: NOW }),
        task({ id: "archived-todo", archivedAt: NOW }),
        task({ id: "archived-done", status: "done", completedAt: NOW, archivedAt: NOW }),
      ],
    });

    expect(getUnfinishedNotesTaskCount(notes)).toBe(1);
  });

  it.each([
    ["empty", "", NOW, null],
    ["whitespace", "  \n", NOW, null],
    ["unversioned", "Continue here", null, null],
  ])("does not mark %s Handoffs unread", (_label, text, updatedAt, readAt) => {
    expect(isNotesHandoffUnread(document({ handoff: { text, updatedAt, readAt } }))).toBe(false);
  });

  it("marks a meaningful Handoff with no read timestamp unread", () => {
    expect(
      isNotesHandoffUnread(
        document({ handoff: { text: "Continue here", updatedAt: NOW, readAt: null } }),
      ),
    ).toBe(true);
  });

  it("marks a Handoff unread when its read timestamp is older", () => {
    expect(
      isNotesHandoffUnread(
        document({
          handoff: {
            text: "Continue here",
            updatedAt: NOW,
            readAt: "2026-07-09T11:59:59.999Z",
          },
        }),
      ),
    ).toBe(true);
  });

  it.each([
    ["equal", NOW],
    ["newer", "2026-07-09T12:00:00.001Z"],
    ["equivalent offset", "2026-07-09T08:00:00.000-04:00"],
  ])("marks a Handoff read when its read timestamp is %s", (_label, readAt) => {
    expect(
      isNotesHandoffUnread(
        document({ handoff: { text: "Continue here", updatedAt: NOW, readAt } }),
      ),
    ).toBe(false);
  });
});
