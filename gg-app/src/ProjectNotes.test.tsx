// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectNotes } from "./ProjectNotes";
import { createEmptyNotesDocument, v2NotesKey } from "./notes-storage";
import type { NotesDocumentV2, NotesTask } from "./notes-types";

const NOW = "2026-07-09T12:00:00.000Z";
const LATER = "2026-07-09T12:01:00.000Z";

function task(id: string): NotesTask {
  return {
    id,
    text: `Task ${id}`,
    status: "todo",
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    archivedAt: null,
  };
}

function notesDocument({
  unfinishedCount = 0,
  handoffUnread = false,
}: {
  unfinishedCount?: number;
  handoffUnread?: boolean;
} = {}): NotesDocumentV2 {
  return {
    ...createEmptyNotesDocument(NOW),
    tasks: Array.from({ length: unfinishedCount }, (_, index) => task(String(index + 1))),
    handoff: handoffUnread
      ? { text: "Continue from here", updatedAt: LATER, readAt: null }
      : { text: "", updatedAt: null, readAt: null },
  };
}

function store(cwd: string, document: NotesDocumentV2): string {
  const value = JSON.stringify(document);
  localStorage.setItem(v2NotesKey(cwd), value);
  return value;
}

function deliver(cwd: string, document: NotesDocumentV2): void {
  const value = store(cwd, document);
  window.dispatchEvent(new StorageEvent("storage", { key: v2NotesKey(cwd), newValue: value }));
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("ProjectNotes App composition", () => {
  it("derives the real trigger through plain, count-only, dot-only, and combined states", async () => {
    const cwd = "/work/project";
    store(cwd, notesDocument());
    render(<ProjectNotes cwd={cwd} />);

    const trigger = await screen.findByRole("button", { name: "Notes" });
    expect(trigger.textContent).toBe("Notes");
    expect(trigger.querySelector(".notes-status-dot")).toBeNull();

    act(() => deliver(cwd, notesDocument({ unfinishedCount: 2 })));
    await waitFor(() => {
      expect(trigger.textContent).toBe("Notes (2)");
      expect(trigger.getAttribute("aria-label")).toBe("Notes, 2 unfinished tasks");
    });
    expect(trigger.querySelector(".notes-status-dot")).toBeNull();

    act(() => deliver(cwd, notesDocument({ handoffUnread: true })));
    await waitFor(() => {
      expect(trigger.textContent).toBe("Notes");
      expect(trigger.getAttribute("aria-label")).toBe("Notes, unread Handoff");
      expect(trigger.querySelector(".notes-status-dot")).toBeTruthy();
    });

    act(() => deliver(cwd, notesDocument({ unfinishedCount: 1, handoffUnread: true })));
    await waitFor(() => {
      expect(trigger.textContent).toBe("Notes (1)");
      expect(trigger.getAttribute("aria-label")).toBe("Notes, 1 unfinished task, unread Handoff");
      expect(trigger.getAttribute("title")).toBe("Notes, 1 unfinished task, unread Handoff");
      expect(trigger.querySelector(".notes-status-dot")).toBeTruthy();
    });
  });

  it("clears unread only after the matching Handoff is rendered in the opened modal", async () => {
    const cwd = "/work/project";
    store(cwd, notesDocument({ handoffUnread: true }));
    render(<ProjectNotes cwd={cwd} />);

    const trigger = await screen.findByRole("button", { name: "Notes, unread Handoff" });
    expect(JSON.parse(localStorage.getItem(v2NotesKey(cwd))!).handoff.readAt).toBeNull();
    expect(screen.queryByLabelText("Handoff notes")).toBeNull();

    fireEvent.click(trigger);

    expect(((await screen.findByLabelText("Handoff notes")) as HTMLTextAreaElement).value).toBe(
      "Continue from here",
    );
    await waitFor(() => {
      expect(trigger.getAttribute("aria-label")).toBe("Notes");
      expect(JSON.parse(localStorage.getItem(v2NotesKey(cwd))!).handoff.readAt).not.toBeNull();
    });
  });

  it("unmounts an open modal at a canonical project switch without acknowledging the new project", async () => {
    const cwdA = "C:\\work\\a";
    const cwdB = "C:\\work\\b";
    store(cwdA, notesDocument());
    store(cwdB, notesDocument({ handoffUnread: true }));
    const view = render(<ProjectNotes cwd={cwdA} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();

    view.rerender(<ProjectNotes cwd={cwdB} />);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByRole("button", { name: "Notes, unread Handoff" })).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(v2NotesKey(cwdB))!).handoff.readAt).toBeNull();
  });

  it("shares acknowledgement across canonical cwd aliases through a storage event", async () => {
    const cwdWindows = "C:\\Work\\Project";
    const cwdAlias = "c:/work/./project";
    store(cwdWindows, notesDocument({ handoffUnread: true }));
    const first = render(<ProjectNotes cwd={cwdWindows} />);
    const second = render(<ProjectNotes cwd={cwdAlias} />);

    const firstTrigger = await within(first.container).findByRole("button", {
      name: "Notes, unread Handoff",
    });
    const secondTrigger = await within(second.container).findByRole("button", {
      name: "Notes, unread Handoff",
    });
    fireEvent.click(firstTrigger);
    await waitFor(() => expect(firstTrigger.getAttribute("aria-label")).toBe("Notes"));

    const acknowledged = localStorage.getItem(v2NotesKey(cwdWindows))!;
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: v2NotesKey(cwdAlias), newValue: acknowledged }),
      );
    });

    await waitFor(() => expect(secondTrigger.getAttribute("aria-label")).toBe("Notes"));
  });
});
