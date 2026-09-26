// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ProjectTask } from "./agent";
import { TasksModal } from "./TasksModal";
import { theme } from "./theme";

afterEach(cleanup);

const TITLE = "Recover ASR validation";

function taskWithStatus(status: string): ProjectTask {
  return {
    id: "task-1",
    title: TITLE,
    prompt: "Complete the validation work",
    status,
    createdAt: "2026-09-04T00:00:00.000Z",
  };
}

/** Flush the microtask that resolves a settled action promise. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function renderModal(
  tasks: ProjectTask[],
  overrides: Partial<React.ComponentProps<typeof TasksModal>> = {},
): ReturnType<typeof render> {
  const props: React.ComponentProps<typeof TasksModal> = {
    tasks,
    running: false,
    onRun: vi.fn(),
    onRunAll: vi.fn(),
    onDelete: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  return render(<TasksModal {...props} />);
}

describe("TasksModal", () => {
  it("blocks both launch actions when the session is busy", () => {
    const onRun = vi.fn();
    const onRunAll = vi.fn();
    renderModal([taskWithStatus("pending")], { running: true, onRun, onRunAll });
    const single = screen.getByRole("button", { name: `Run: ${TITLE}` });
    const all = screen.getByRole("button", { name: "Run all (1)" });
    expect(single).toMatchObject({ disabled: true });
    expect(all).toMatchObject({ disabled: true });
    fireEvent.click(single);
    fireEvent.click(all);
    expect(onRun).not.toHaveBeenCalled();
    expect(onRunAll).not.toHaveBeenCalled();
  });

  it("renders blocked tasks with a clear neutral status", () => {
    renderModal([taskWithStatus("blocked")]);

    expect(screen.getByRole("dialog", { name: "Tasks" })).toBeTruthy();
    const status = screen.getByText("blocked");
    const expected = document.createElement("span");
    expected.style.color = theme.textMuted;
    expect(status.style.color).toBe(expected.style.color);
  });

  it("falls back safely when a future task status is unknown", () => {
    renderModal([taskWithStatus("paused-by-policy")]);

    const expected = document.createElement("span");
    expected.style.color = theme.textMuted;
    expect(screen.getByText("unknown").style.color).toBe(expected.style.color);
  });

  it("runs pending and blocked tasks automatically without selecting unsafe statuses", async () => {
    const onRun = vi.fn();
    const onRunAll = vi.fn();
    const onClose = vi.fn();
    renderModal(
      [
        { ...taskWithStatus("pending"), id: "pending", title: "Pending task" },
        { ...taskWithStatus("blocked"), id: "blocked", title: "Blocked task" },
        { ...taskWithStatus("in-progress"), id: "running", title: "Running task" },
        { ...taskWithStatus("done"), id: "done", title: "Done task" },
        { ...taskWithStatus("paused-by-policy"), id: "unknown", title: "Unknown task" },
      ],
      { onRun, onRunAll, onClose },
    );

    const dialog = screen.getByRole("dialog", { name: "Tasks" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByText("pending")).toBeTruthy();
    expect(screen.getByText("blocked")).toBeTruthy();
    expect(screen.getByText("running")).toBeTruthy();
    expect(screen.getByText("done")).toBeTruthy();
    expect(screen.getByText("unknown")).toBeTruthy();

    // Eligibility is unchanged: pending, blocked and in-progress stay manually
    // runnable; only the wording reflects what the run actually is.
    expect(screen.getByRole("button", { name: "Run: Pending task" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry: Blocked task" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run again: Running task" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /^(Run|Retry|Run again): Done task$/u }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^(Run|Retry|Run again): Unknown task$/u }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Run: Pending task" }));
    expect(onRun).toHaveBeenCalledWith("pending");
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Run all (2)" }));
    expect(onRunAll).toHaveBeenCalledOnce();
    await settle();

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("opens a task's full prompt and returns focus to its row", async () => {
    const prompt = "Line one of a very long prompt.\n".repeat(40);
    renderModal([{ ...taskWithStatus("pending"), prompt }]);

    const titleButton = screen.getByRole("button", { name: `Inspect task: ${TITLE}` });
    fireEvent.click(titleButton);

    expect(screen.getByRole("heading", { name: TITLE })).toBeTruthy();
    expect(screen.getByText(prompt.trim().split("\n")[0]!, { exact: false })).toBeTruthy();
    expect(screen.getByText(/Added/u)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Back to tasks/u }));

    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: `Inspect task: ${TITLE}` }),
      ),
    );
  });

  it("explains an empty prompt instead of showing a blank box", () => {
    renderModal([{ ...taskWithStatus("pending"), prompt: "" }]);

    fireEvent.click(screen.getByRole("button", { name: `Inspect task: ${TITLE}` }));

    const note = screen.getByText(/no separate prompt/u);
    expect(note.textContent).toContain("title");
    const expected = document.createElement("p");
    expected.style.color = theme.textMuted;
    expect(note.style.color).toBe(expected.style.color);
    expect(document.querySelector(".tasks-detail-prompt")).toBeNull();
  });

  it("explains why the last run blocked in the detail panel only", () => {
    renderModal([
      {
        ...taskWithStatus("blocked"),
        lastOutcome: { reason: "plan-mode", at: "2026-09-05T00:00:00.000Z" },
      },
    ]);
    // The list row stays unchanged.
    expect(screen.queryByText(/Last run stopped/u)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: `Inspect task: ${TITLE}` }));

    const line = screen.getByText(/Last run stopped: the session was in plan mode/u);
    expect(line.closest(".tasks-detail-meta")).not.toBeNull();
    const expected = document.createElement("span");
    expected.style.color = theme.textMuted;
    expect(line.style.color).toBe(expected.style.color);
  });

  it.each([
    ["no recorded outcome", undefined],
    ["an unknown future reason", { reason: "paused-by-policy", at: "2026-09-05T00:00:00.000Z" }],
  ])("shows no outcome line for %s", (_name, lastOutcome) => {
    renderModal([{ ...taskWithStatus("blocked"), lastOutcome }]);
    fireEvent.click(screen.getByRole("button", { name: `Inspect task: ${TITLE}` }));
    expect(screen.queryByText(/Last run stopped/u)).toBeNull();
    expect(screen.queryByTestId("tasks-last-outcome")).toBeNull();
  });

  it("explains a missing prompt field on a legacy record", () => {
    // A hand-edited/legacy record can reach the UI without `prompt` at all: the
    // store only backfills it from `text` when `text` exists.
    const { prompt: _omitted, ...legacy } = taskWithStatus("pending");
    renderModal([legacy as ProjectTask]);

    fireEvent.click(screen.getByRole("button", { name: `Inspect task: ${TITLE}` }));

    expect(screen.getByText(/no separate prompt/u).textContent).toContain("title");
    expect(document.querySelector(".tasks-detail-prompt")).toBeNull();
  });

  it("keeps one action pending and refuses a duplicate dispatch", async () => {
    const onRun = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    renderModal([taskWithStatus("pending")], { onRun });

    const run = screen.getByRole("button", { name: `Run: ${TITLE}` });
    fireEvent.click(run);
    await waitFor(() => expect(screen.getByText("Starting…")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: `Run: ${TITLE}` }));
    fireEvent.click(screen.getByRole("button", { name: "Run all (1)" }));

    expect(onRun).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Run all (1)" })).toMatchObject({ disabled: true });
  });

  it("shows a run failure inline without losing the task", async () => {
    const onRun = vi.fn().mockRejectedValue(new Error("task cannot start"));
    renderModal([taskWithStatus("pending")], { onRun });

    fireEvent.click(screen.getByRole("button", { name: `Run: ${TITLE}` }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("task cannot start"));
    expect(screen.getByRole("button", { name: `Inspect task: ${TITLE}` })).toBeTruthy();
  });

  it("asks before deleting and leaves the task untouched on cancel", async () => {
    const onDelete = vi.fn();
    renderModal([taskWithStatus("pending")], { onDelete });

    fireEvent.click(screen.getByRole("button", { name: `Delete task: ${TITLE}` }));

    const confirmation = screen.getByRole("alertdialog");
    expect(confirmation.textContent).toContain("cannot be undone");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep task" })),
    );

    fireEvent.click(screen.getByRole("button", { name: "Keep task" }));

    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("button", { name: `Inspect task: ${TITLE}` })).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: `Delete task: ${TITLE}` }),
      ),
    );
  });

  it("warns that deleting a running task does not stop the run", () => {
    const RUNNING_SENTENCE =
      "This task is running now, and deleting it does not stop the run in progress.";

    renderModal([taskWithStatus("in-progress")]);
    fireEvent.click(screen.getByRole("button", { name: `Delete task: ${TITLE}` }));
    expect(screen.getByRole("alertdialog").textContent).toContain(RUNNING_SENTENCE);

    cleanup();

    renderModal([taskWithStatus("pending")]);
    fireEvent.click(screen.getByRole("button", { name: `Delete task: ${TITLE}` }));
    const confirmation = screen.getByRole("alertdialog");
    expect(confirmation.textContent).toContain("cannot be undone");
    expect(confirmation.textContent).not.toContain(RUNNING_SENTENCE);
  });

  it("keeps the task and explains a failed deletion", async () => {
    const onDelete = vi.fn().mockRejectedValue(new Error("task delete refused"));
    renderModal([taskWithStatus("pending")], { onDelete });

    fireEvent.click(screen.getByRole("button", { name: `Delete task: ${TITLE}` }));
    fireEvent.click(screen.getByRole("button", { name: "Delete task" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("task delete refused"));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByRole("button", { name: `Inspect task: ${TITLE}` })).toBeTruthy();
  });

  it("moves focus to a surviving task after a successful deletion", async () => {
    const first = { ...taskWithStatus("pending"), id: "first", title: "First task" };
    const second = { ...taskWithStatus("pending"), id: "second", title: "Second task" };
    const onDelete = vi.fn().mockResolvedValue(undefined);
    const view = renderModal([first, second], { onDelete });

    fireEvent.click(screen.getByRole("button", { name: "Delete task: First task" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete task" }));

    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("first"));
    view.rerender(
      <TasksModal
        tasks={[second]}
        running={false}
        onRun={vi.fn()}
        onRunAll={vi.fn()}
        onDelete={onDelete}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Inspect task: Second task" }),
      ),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("returns to the list when the inspected task disappears", async () => {
    const task = taskWithStatus("pending");
    const view = renderModal([task]);

    fireEvent.click(screen.getByRole("button", { name: `Inspect task: ${TITLE}` }));
    expect(screen.getByRole("heading", { name: TITLE })).toBeTruthy();

    view.rerender(
      <TasksModal
        tasks={[]}
        running={false}
        onRun={vi.fn()}
        onRunAll={vi.fn()}
        onDelete={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByText(/No tasks yet/u)).toBeTruthy();
  });

  it("explains an empty list instead of showing bare actions", () => {
    renderModal([]);

    expect(screen.getByText(/No tasks yet/u)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Run all/u })).toBeNull();
  });
});
