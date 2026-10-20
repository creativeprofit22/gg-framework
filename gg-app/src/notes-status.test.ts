import { describe, expect, it } from "vitest";
import {
  activePhaseCountLabel,
  getActiveNotesPhaseCount,
  getActiveNotesReminderCount,
  getDueNotesReminderCount,
  getSavedPromptCount,
  getUnfinishedNotesTaskCount,
  groupNotesPhases,
  groupNotesTasks,
  isNotesHandoffUnread,
  roadmapProgressLabel,
  selectNotesRoadmapProgress,
} from "./notes-status";
import type { NotesDocumentV3, NotesPhase, NotesPhaseStatus, NotesTask } from "./notes-types";

const NOW = "2026-07-25T12:00:00.000Z";

function phase(status: NotesPhaseStatus, withReminder = false): NotesPhase {
  return {
    id: `phase-${status}`,
    title: status,
    goal: "Verify shell counts",
    doneWhen: ["Counts are correct"],
    order: 0,
    status,
    sourcePrompt: "Implement Phase 17",
    referenceIds: [],
    session: null,
    reminder: withReminder
      ? {
          id: `reminder-${status}`,
          occurrenceKey: `occurrence-${status}`,
          dueAt: NOW,
          note: "Review",
          createdAt: NOW,
          lastDelivery: null,
        }
      : null,
    attentionReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: status === "done" || status === "cancelled" ? NOW : null,
    archivedAt: null,
    overrides: { status: null, referenceIds: null },
    pendingAutomaticLifecycleTransition: null,
    lifecycleEvents: [],
    roadmapEvents: [],
  };
}

function document(phases: NotesPhase[] = []): NotesDocumentV3 {
  return {
    version: 3,
    reference: "Reference",
    currentFocus: "Focus",
    tasks: [],
    handoff: { text: "", updatedAt: null, readAt: null },
    updatedAt: NOW,
    legacyImportedAt: null,
    phases,
    references: [],
  };
}

describe("Notes status selectors", () => {
  it("keeps existing task and Handoff semantics", () => {
    const notes = document();
    notes.tasks = [
      {
        id: "todo",
        text: "Active task",
        status: "todo",
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: null,
        archivedAt: null,
      },
      {
        id: "archived",
        text: "Archived task",
        status: "todo",
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: null,
        archivedAt: NOW,
      },
    ];
    notes.handoff = { text: "Unread", updatedAt: NOW, readAt: null };

    expect(getUnfinishedNotesTaskCount(notes)).toBe(1);
    expect(isNotesHandoffUnread(notes)).toBe(true);
  });

  it("counts non-empty saved prompts only on visible Roadmap phases", () => {
    const saved = phase("not-started");
    const empty = { ...phase("planning"), sourcePrompt: "" };
    const whitespace = { ...phase("review"), sourcePrompt: "   \n" };
    const archived = { ...phase("in-progress"), archivedAt: NOW };

    expect(getSavedPromptCount(document([saved, empty, whitespace, archived]))).toBe(1);
  });

  it("counts every unsettled phase as active", () => {
    const activeStatuses: NotesPhaseStatus[] = [
      "not-started",
      "planning",
      "waiting-for-approval",
      "in-progress",
      "review",
      "needs-attention",
    ];
    const notes = document([
      ...activeStatuses.map((status) => phase(status)),
      phase("done"),
      phase("cancelled"),
    ]);

    expect(getActiveNotesPhaseCount(notes)).toBe(activeStatuses.length);
  });

  it("does not count done or cancelled phases", () => {
    expect(getActiveNotesPhaseCount(document([phase("done"), phase("cancelled")]))).toBe(0);
  });

  it("counts reminders only when attached to active phases", () => {
    const notes = document([
      phase("planning", true),
      phase("in-progress", false),
      phase("review", true),
      phase("done", true),
      phase("cancelled", true),
    ]);

    expect(getActiveNotesReminderCount(notes)).toBe(2);
  });

  it("counts only current delivered occurrences as due reminder actions", () => {
    const delivered = phase("in-progress", true);
    delivered.reminder!.lastDelivery = {
      occurrenceKey: delivered.reminder!.occurrenceKey,
      attemptedAt: NOW,
      channel: "in-app",
      permission: "not-required",
    };
    const priorOccurrence = phase("review", true);
    priorOccurrence.reminder!.lastDelivery = {
      occurrenceKey: "prior-occurrence",
      attemptedAt: NOW,
      channel: "native",
      permission: "granted",
    };

    expect(
      getDueNotesReminderCount(document([delivered, priorOccurrence, phase("done", true)])),
    ).toBe(1);
  });

  it("excludes archived active phases and their reminders", () => {
    const archived = { ...phase("in-progress", true), archivedAt: NOW };
    expect(getActiveNotesPhaseCount(document([archived]))).toBe(0);
    expect(getActiveNotesReminderCount(document([archived]))).toBe(0);
    expect(getDueNotesReminderCount(document([archived]))).toBe(0);
  });

  it.each([
    [0, "No active phases"],
    [1, "1 active phase"],
    [2, "2 active phases"],
  ] as const)("labels %i active phases as %s", (count, label) => {
    expect(activePhaseCountLabel(count)).toBe(label);
  });

  it("returns zero counts for an empty roadmap", () => {
    expect(getActiveNotesPhaseCount(document())).toBe(0);
    expect(getActiveNotesReminderCount(document())).toBe(0);
    expect(getDueNotesReminderCount(document())).toBe(0);
  });
});

function named(status: NotesPhaseStatus, id: string, extra: Partial<NotesPhase> = {}): NotesPhase {
  return { ...phase(status), id, title: id, ...extra };
}

function task(
  id: string,
  status: NotesTask["status"],
  archivedAt: string | null = null,
): NotesTask {
  return {
    id,
    text: id,
    status,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: status === "done" ? NOW : null,
    archivedAt,
  };
}

describe("Roadmap progress selector", () => {
  it("divides done by visible phases minus cancelled", () => {
    const progress = selectNotesRoadmapProgress([
      named("done", "a"),
      named("in-progress", "b"),
      named("cancelled", "c"),
      named("done", "d"),
      named("not-started", "e"),
    ]);
    expect(progress).toEqual({ done: 2, total: 4, ratio: 0.5 });
    expect(roadmapProgressLabel(progress)).toBe("2 of 4 phases done");
  });

  it("returns a null ratio and no label when every phase is cancelled", () => {
    const progress = selectNotesRoadmapProgress([named("cancelled", "a"), named("cancelled", "b")]);
    expect(progress).toEqual({ done: 0, total: 0, ratio: null });
    expect(roadmapProgressLabel(progress)).toBeNull();
  });

  it("returns a null ratio and no label for an empty roadmap", () => {
    const progress = selectNotesRoadmapProgress([]);
    expect(progress).toEqual({ done: 0, total: 0, ratio: null });
    expect(roadmapProgressLabel(progress)).toBeNull();
  });

  it("excludes archived and deleted phases", () => {
    const progress = selectNotesRoadmapProgress([
      named("done", "kept"),
      named("done", "archived", { archivedAt: NOW }),
      named("in-progress", "deleted", {
        deletion: { version: 1, currentDeletionId: "deletion-1", events: [] },
      }),
    ]);
    expect(progress).toEqual({ done: 1, total: 1, ratio: 1 });
    expect(roadmapProgressLabel(progress)).toBe("1 of 1 phase done");
  });
});

describe("Notes grouping", () => {
  it("splits phases into open and completed in document order", () => {
    const groups = groupNotesPhases([
      named("done", "a"),
      named("planning", "b"),
      named("cancelled", "c"),
      named("done", "d"),
      named("done", "archived", { archivedAt: NOW }),
    ]);
    expect(groups.open.map((item) => item.id)).toEqual(["b", "c"]);
    expect(groups.completed.map((item) => item.id)).toEqual(["a", "d"]);
  });

  it("splits tasks into open and completed and drops archived tasks", () => {
    const groups = groupNotesTasks([
      task("done-1", "done"),
      task("todo-1", "todo"),
      task("archived", "done", NOW),
      task("todo-2", "todo"),
      task("done-2", "done"),
    ]);
    expect(groups.open.map((item) => item.id)).toEqual(["todo-1", "todo-2"]);
    expect(groups.completed.map((item) => item.id)).toEqual(["done-1", "done-2"]);
  });
});
