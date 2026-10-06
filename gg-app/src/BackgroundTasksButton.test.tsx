// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// agent.ts binds to the Tauri window at import; the button only needs killTask.
vi.mock("./agent", () => ({ killTask: vi.fn(async () => ({ ok: true })) }));
vi.mock("./toast", () => ({ toast: vi.fn() }));

import { killTask, type BackgroundTask } from "./agent";
import { toast } from "./toast";
import { BackgroundTasksButton } from "./BackgroundTasksButton";
import { formatBackgroundTaskStatus, isBackgroundTaskRunning } from "./background-task-status";

function task(over: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: "t1",
    pid: 101,
    command: "pnpm dev",
    startedAt: 1,
    exitCode: null,
    isRunning: true,
    signal: null,
    stopReason: null,
    completedAt: null,
    ...over,
  };
}

afterEach(cleanup);

describe("BackgroundTasksButton", () => {
  it("counts only daemon-live tasks and offers kill only for them", () => {
    const tasks = [
      task({ id: "run", command: "running cmd", pid: 11 }),
      task({ id: "ok", command: "exited cmd", isRunning: false, exitCode: 0, completedAt: 2 }),
      task({
        id: "sig",
        command: "killed cmd",
        isRunning: false,
        exitCode: null,
        signal: "SIGTERM",
        completedAt: 2,
      }),
      task({
        id: "idle",
        command: "silent cmd",
        isRunning: false,
        exitCode: null,
        signal: "SIGTERM",
        stopReason: "inactive",
        completedAt: 2,
      }),
    ];
    render(<BackgroundTasksButton tasks={tasks} />);

    const button = screen.getByRole("button", { name: /background task/ });
    expect(button.textContent).toContain("1 background task");
    expect(button.textContent).not.toContain("tasks");

    fireEvent.click(button);
    expect(screen.getByText("pid 11")).toBeTruthy();
    expect(screen.getByText("exit 0")).toBeTruthy();
    expect(screen.getByText("signal SIGTERM")).toBeTruthy();
    expect(screen.getByText("stopped: no output")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "kill" })).toHaveLength(1);
  });

  it("says so when stopping a task fails", async () => {
    vi.mocked(killTask).mockResolvedValueOnce({ ok: false, error: "process not found" });
    render(<BackgroundTasksButton tasks={[task()]} />);

    fireEvent.click(screen.getByRole("button", { name: /background task/ }));
    fireEvent.click(screen.getByRole("button", { name: "kill" }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("Couldn't stop the task: process not found", "error"),
    );
  });
});

describe("background task status", () => {
  it("labels a hard-limit stop", () => {
    expect(
      formatBackgroundTaskStatus(
        task({ isRunning: false, signal: "SIGTERM", stopReason: "timedOut" }),
      ),
    ).toBe("stopped: time limit");
  });

  it("falls back to the exit code when an older daemon omits isRunning", () => {
    const legacy: BackgroundTask = { id: "l", pid: 5, command: "x", startedAt: 1, exitCode: null };
    expect(isBackgroundTaskRunning(legacy)).toBe(true);
    expect(isBackgroundTaskRunning({ ...legacy, exitCode: 1 })).toBe(false);
  });
});
