// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectNotes } from "./ProjectNotes";
import { createEmptyNotesDocument, legacyNotesKey, v2NotesKey } from "./notes-storage";
import type { NotesDocumentV2 } from "./notes-types";

const NOW = "2026-07-15T12:00:00.000Z";

function notes(reference: string, taskCount = 0): NotesDocumentV2 {
  return {
    ...createEmptyNotesDocument(NOW),
    reference,
    currentFocus: `Focus ${reference}`,
    tasks: Array.from({ length: taskCount }, (_, index) => ({
      id: `task-${index}`,
      text: `Task ${index + 1}`,
      status: "todo" as const,
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: null,
      archivedAt: null,
    })),
  };
}

function store(cwd: string, document: NotesDocumentV2): void {
  localStorage.setItem(v2NotesKey(cwd), JSON.stringify(document));
  localStorage.setItem(legacyNotesKey(cwd), document.reference);
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("ProjectNotes", () => {
  it("shows structured status and persists edits in both formats", async () => {
    const cwd = "/work/project";
    store(cwd, notes("reference A", 2));
    render(<ProjectNotes cwd={cwd} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes, 2 unfinished tasks" }));
    expect((screen.getByLabelText("Current focus") as HTMLInputElement).value).toBe(
      "Focus reference A",
    );

    fireEvent.change(screen.getByLabelText("Reference notes"), {
      target: { value: "updated reference" },
    });

    expect(localStorage.getItem(legacyNotesKey(cwd))).toBe("updated reference");
    expect(JSON.parse(localStorage.getItem(v2NotesKey(cwd))!).reference).toBe("updated reference");
  });

  it("persists the structured focus, task lifecycle, and handoff workflow", async () => {
    const cwd = "/work/structured";
    store(cwd, notes("reference", 1));
    render(<ProjectNotes cwd={cwd} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes, 1 unfinished task" }));
    fireEvent.change(screen.getByLabelText("Current focus"), {
      target: { value: "Finish the port" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "Complete task: Task 1" }));
    fireEvent.change(screen.getByLabelText("Handoff notes"), {
      target: { value: "Review the uncommitted diff" },
    });

    const persisted = JSON.parse(localStorage.getItem(v2NotesKey(cwd))!);
    expect(persisted.currentFocus).toBe("Finish the port");
    expect(persisted.tasks[0]).toMatchObject({ status: "done" });
    expect(persisted.tasks[0].completedAt).not.toBeNull();
    expect(persisted.handoff.text).toBe("Review the uncommitted diff");
    expect(await screen.findByRole("button", { name: "Notes" })).toBeTruthy();
  });

  it("closes an open modal and loads only the newly selected project's notes", async () => {
    const cwdA = "C:\\work\\a";
    const cwdB = "C:\\work\\b";
    store(cwdA, notes("project A"));
    store(cwdB, notes("project B", 1));
    const view = render(<ProjectNotes cwd={cwdA} />);

    fireEvent.click(await screen.findByRole("button", { name: "Notes" }));
    expect((screen.getByLabelText("Reference notes") as HTMLTextAreaElement).value).toBe(
      "project A",
    );

    view.rerender(<ProjectNotes cwd={cwdB} />);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(await screen.findByRole("button", { name: "Notes, 1 unfinished task" }));

    expect((screen.getByLabelText("Reference notes") as HTMLTextAreaElement).value).toBe(
      "project B",
    );
    expect(localStorage.getItem(legacyNotesKey(cwdA))).toBe("project A");
  });

  it("reloads the latest same-project state instead of an out-of-order event payload", async () => {
    const cwd = "C:\\Work\\Project";
    const stale = notes("stale", 1);
    store(cwd, stale);
    render(<ProjectNotes cwd={cwd} />);
    expect(await screen.findByRole("button", { name: "Notes, 1 unfinished task" })).toBeTruthy();

    const latest = notes("latest", 3);
    store(cwd, latest);
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: v2NotesKey(cwd),
          newValue: JSON.stringify(stale),
        }),
      );
    });

    const trigger = await screen.findByRole("button", { name: "Notes, 3 unfinished tasks" });
    fireEvent.click(trigger);
    expect((screen.getByLabelText("Reference notes") as HTMLTextAreaElement).value).toBe("latest");
  });
});
