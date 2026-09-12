// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ProjectTask } from "./agent";
import { TasksModal } from "./TasksModal";
import { theme } from "./theme";

afterEach(cleanup);

function taskWithStatus(status: string): ProjectTask {
  return {
    id: "task-1",
    title: "Recover ASR validation",
    prompt: "Complete the validation work",
    status,
    createdAt: "2026-09-04T00:00:00.000Z",
  };
}

describe("TasksModal", () => {
  it("blocks both launch actions when the session is busy", () => {
    const onRun = vi.fn();
    const onRunAll = vi.fn();
    render(
      <TasksModal
        tasks={[taskWithStatus("pending")]}
        running={true}
        onRun={onRun}
        onRunAll={onRunAll}
        onDelete={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const single = screen.getByRole("button", { name: "Run" });
    const all = screen.getByRole("button", { name: "Run all (1)" });
    expect(single).toMatchObject({ disabled: true });
    expect(all).toMatchObject({ disabled: true });
    fireEvent.click(single);
    fireEvent.click(all);
    expect(onRun).not.toHaveBeenCalled();
    expect(onRunAll).not.toHaveBeenCalled();
  });
  it("renders blocked tasks with a clear neutral status", () => {
    render(
      <TasksModal
        tasks={[taskWithStatus("blocked")]}
        running={false}
        onRun={vi.fn()}
        onRunAll={vi.fn()}
        onDelete={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Tasks" })).toBeTruthy();
    const status = screen.getByText("blocked");
    const expected = document.createElement("span");
    expected.style.color = theme.textMuted;
    expect(status.style.color).toBe(expected.style.color);
  });

  it("falls back safely when a future task status is unknown", () => {
    render(
      <TasksModal
        tasks={[taskWithStatus("paused-by-policy")]}
        running={false}
        onRun={vi.fn()}
        onRunAll={vi.fn()}
        onDelete={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const expected = document.createElement("span");
    expected.style.color = theme.textMuted;
    expect(screen.getByText("unknown").style.color).toBe(expected.style.color);
  });

  it("runs pending and blocked tasks automatically without selecting unsafe statuses", () => {
    const onRun = vi.fn();
    const onRunAll = vi.fn();
    const onClose = vi.fn();
    render(
      <TasksModal
        tasks={[
          { ...taskWithStatus("pending"), id: "pending" },
          { ...taskWithStatus("blocked"), id: "blocked" },
          { ...taskWithStatus("in-progress"), id: "running" },
          { ...taskWithStatus("done"), id: "done" },
          { ...taskWithStatus("paused-by-policy"), id: "unknown" },
        ]}
        running={false}
        onRun={onRun}
        onRunAll={onRunAll}
        onDelete={vi.fn()}
        onClose={onClose}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Tasks" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByText("pending")).toBeTruthy();
    expect(screen.getByText("blocked")).toBeTruthy();
    expect(screen.getByText("running")).toBeTruthy();
    expect(screen.getByText("done")).toBeTruthy();
    expect(screen.getByText("unknown")).toBeTruthy();

    const runButtons = screen.getAllByRole("button", { name: "Run" });
    expect(runButtons).toHaveLength(3);
    fireEvent.click(runButtons[0]!);
    expect(onRun).toHaveBeenCalledWith("pending");
    fireEvent.click(screen.getByRole("button", { name: "Run all (2)" }));
    expect(onRunAll).toHaveBeenCalledOnce();

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
