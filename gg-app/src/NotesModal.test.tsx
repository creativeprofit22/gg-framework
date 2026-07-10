// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { NotesModal } from "./NotesModal";
import type { NotesTask } from "./notes-types";

const TODO: NotesTask = {
  id: "todo",
  text: "Write tests",
  status: "todo",
  createdAt: "2026-07-09T12:00:00.000Z",
  updatedAt: "2026-07-09T12:00:00.000Z",
  completedAt: null,
  archivedAt: null,
};

const DONE: NotesTask = {
  ...TODO,
  id: "done",
  text: "Ship feature",
  status: "done",
  completedAt: "2026-07-09T12:01:00.000Z",
};

const ARCHIVED: NotesTask = {
  ...TODO,
  id: "archived",
  text: "Hidden task",
  archivedAt: "2026-07-09T12:02:00.000Z",
};

interface HarnessProps {
  onCurrentFocus?: (text: string) => void;
  onHandoff?: (text: string) => void;
  onReference?: (text: string) => void;
}

function Harness({ onCurrentFocus, onHandoff, onReference }: HarnessProps): React.ReactElement {
  const [currentFocus, setCurrentFocus] = useState("Ship current focus");
  const [tasks, setTasks] = useState([TODO, DONE, ARCHIVED]);
  const [handoff, setHandoff] = useState("handoff 😀");
  const [reference, setReference] = useState("reference text");

  return (
    <NotesModal
      value={reference}
      onChange={(text) => {
        setReference(text);
        onReference?.(text);
      }}
      currentFocus={currentFocus}
      tasks={tasks}
      handoff={handoff}
      onChangeCurrentFocus={(text) => {
        setCurrentFocus(text);
        onCurrentFocus?.(text);
      }}
      onCreateTask={(text) =>
        setTasks((current) => [
          ...current,
          { ...TODO, id: `new-${current.length}`, text, status: "todo" },
        ])
      }
      onEditTask={(id, text) =>
        setTasks((current) => current.map((task) => (task.id === id ? { ...task, text } : task)))
      }
      onToggleTask={(id) =>
        setTasks((current) =>
          current.map((task) =>
            task.id === id ? { ...task, status: task.status === "done" ? "todo" : "done" } : task,
          ),
        )
      }
      onArchiveTask={(id) =>
        setTasks((current) =>
          current.map((task) =>
            task.id === id ? { ...task, archivedAt: "2026-07-09T13:00:00.000Z" } : task,
          ),
        )
      }
      onRestoreTask={(id) =>
        setTasks((current) =>
          current.map((task) => (task.id === id ? { ...task, archivedAt: null } : task)),
        )
      }
      onChangeHandoff={(text) => {
        setHandoff(text);
        onHandoff?.(text);
      }}
      onClose={() => undefined}
    />
  );
}

describe("NotesModal", () => {
  it("renders active task state, Handoff, and Reference while omitting archived tasks", () => {
    render(<Harness />);

    expect((screen.getByLabelText("Current focus") as HTMLInputElement).value).toBe(
      "Ship current focus",
    );
    expect(document.activeElement).toBe(screen.getByLabelText("Current focus"));
    expect(screen.getByText("Write tests")).toBeTruthy();
    expect(screen.getByText("Ship feature")).toBeTruthy();
    expect(screen.queryByText("Hidden task")).toBeNull();
    expect(
      (screen.getByRole("checkbox", { name: /Complete task: Write tests/ }) as HTMLInputElement)
        .checked,
    ).toBe(false);
    expect(
      (screen.getByRole("checkbox", { name: /Reopen task: Ship feature/ }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect((screen.getByLabelText("Handoff notes") as HTMLTextAreaElement).value).toBe(
      "handoff 😀",
    );
    expect((screen.getByLabelText("Reference notes") as HTMLTextAreaElement).value).toBe(
      "reference text",
    );
  });

  it("adds trimmed tasks by Enter, clears and refocuses input, and blocks whitespace", () => {
    render(<Harness />);
    const add = screen.getByLabelText("Add a Notes task") as HTMLInputElement;

    fireEvent.change(add, { target: { value: "  New task  " } });
    fireEvent.keyDown(add, { key: "Enter", code: "Enter" });
    fireEvent.submit(add.closest("form")!);

    expect(screen.getByText("New task")).toBeTruthy();
    expect(add.value).toBe("");
    expect(document.activeElement).toBe(add);
    fireEvent.change(add, { target: { value: "   " } });
    expect((screen.getByRole("button", { name: "Add task" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("toggles through a native checkbox with the correct accessible state and name", () => {
    render(<Harness />);
    const checkbox = screen.getByRole("checkbox", {
      name: "Complete task: Write tests",
    }) as HTMLInputElement;

    fireEvent.click(checkbox);

    const checked = screen.getByRole("checkbox", {
      name: "Reopen task: Write tests",
    }) as HTMLInputElement;
    expect(checked.checked).toBe(true);
  });

  it("saves edits by Enter, cancels by Escape, blocks blanks, and restores Edit focus", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Edit task: Write tests" }));
    let input = screen.getByLabelText("Edit task: Write tests") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  Better tests  " } });
    fireEvent.submit(input.closest("form")!);
    expect(screen.getByText("Better tests")).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Edit task: Better tests" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit task: Better tests" }));
    input = screen.getByLabelText("Edit task: Better tests") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.getByText("Better tests")).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Edit task: Better tests" }),
    );
  });

  it("soft-archives, announces, removes the row, and focuses Add task", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Archive task: Write tests" }));

    expect(screen.queryByText("Write tests")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Archived task: Write tests");
    expect(document.activeElement).toBe(screen.getByLabelText("Add a Notes task"));
  });

  it("reveals archived history on demand and restores a task to Next", () => {
    render(<Harness />);
    const toggle = screen.getByRole("button", { name: "Show archived tasks (1)" });

    expect(screen.queryByText("Hidden task")).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);

    expect(screen.getByText("Hidden task")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide archived tasks (1)" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore task: Hidden task" }));

    expect(screen.getByText("Hidden task")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restore task: Hidden task" })).toBeNull();
    expect(screen.getByRole("button", { name: "Hide archived tasks (0)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Archive task: Hidden task" })).toBeTruthy();
  });

  it("forwards distinct Now, Handoff, and Reference values", () => {
    const onCurrentFocus = vi.fn();
    const onHandoff = vi.fn();
    const onReference = vi.fn();
    render(
      <Harness onCurrentFocus={onCurrentFocus} onHandoff={onHandoff} onReference={onReference} />,
    );
    const currentFocus = "Fix cross-window sync 😀";
    const handoff = "handoff\nمرحبا 😀";
    const reference = "reference\n日本語 ✨";

    fireEvent.change(screen.getByLabelText("Current focus"), {
      target: { value: currentFocus },
    });
    fireEvent.change(screen.getByLabelText("Handoff notes"), { target: { value: handoff } });
    fireEvent.change(screen.getByLabelText("Reference notes"), { target: { value: reference } });

    expect(onCurrentFocus).toHaveBeenCalledWith(currentFocus);
    expect(onHandoff).toHaveBeenCalledWith(handoff);
    expect(onReference).toHaveBeenCalledWith(reference);
    expect(onCurrentFocus).not.toHaveBeenCalledWith(handoff);
    expect(onHandoff).not.toHaveBeenCalledWith(reference);
  });

  it("uses labelled sections and no routine alerts", () => {
    render(<Harness />);

    expect(screen.getByRole("heading", { name: "Now" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Next" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Handoff" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Reference" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Done / Archive" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
