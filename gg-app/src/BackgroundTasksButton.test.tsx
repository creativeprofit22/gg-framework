// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const killTask = vi.fn();

import { BackgroundTasksButton } from "./BackgroundTasksButton";
import type { BackgroundTask, KillTaskResult } from "./agent";

const runningTask: BackgroundTask = {
  id: "task-1",
  pid: 4242,
  command: "pnpm dev",
  logFile: "/tmp/task-1.log",
  startedAt: 1,
  completedAt: null,
  exitCode: null,
  signal: null,
  isRunning: true,
};

const signalCompletedTask: BackgroundTask = {
  ...runningTask,
  id: "task-2",
  command: "pnpm watch",
  completedAt: 2,
  signal: "SIGTERM",
  isRunning: false,
};

describe("BackgroundTasksButton task termination", () => {
  beforeEach(() => {
    killTask.mockReset();
  });
  afterEach(cleanup);

  it("disables termination while pending and shows the successful backend status", async () => {
    let resolveKill!: (result: KillTaskResult) => void;
    killTask.mockReturnValue(
      new Promise<KillTaskResult>((resolve) => {
        resolveKill = resolve;
      }),
    );

    render(<BackgroundTasksButton tasks={[runningTask]} killTask={killTask} />);
    fireEvent.click(screen.getByRole("button", { name: "Background tasks" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop task: pnpm dev" }));

    const pendingButton = screen.getByRole("button", { name: "Stopping task: pnpm dev" });
    expect((pendingButton as HTMLButtonElement).disabled).toBe(true);
    expect(pendingButton.textContent).toBe("stopping...");

    await act(async () => resolveKill({ ok: true, message: "Process task-1 stopped" }));

    expect((await screen.findByRole("status")).textContent).toBe("Process task-1 stopped");
    expect(screen.getByText("pnpm dev")).toBeTruthy();
    expect(killTask).toHaveBeenCalledWith("task-1");
  });

  it("keeps retained signal completions reachable without a stop affordance", () => {
    render(<BackgroundTasksButton tasks={[signalCompletedTask]} killTask={killTask} />);

    expect(screen.getByRole("button", { name: "Background tasks" }).textContent).toContain(
      "0 running",
    );
    fireEvent.click(screen.getByRole("button", { name: "Background tasks" }));

    expect(screen.getByText("signal SIGTERM")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop task: pnpm watch" })).toBeNull();
  });

  it("renders normal completion codes separately from signal status", () => {
    render(
      <BackgroundTasksButton
        tasks={[{ ...signalCompletedTask, exitCode: 7, signal: null }]}
        killTask={killTask}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Background tasks" }));

    expect(screen.getByText("exit 7")).toBeTruthy();
  });

  it("shows an actionable failure and retains the running task", async () => {
    killTask.mockResolvedValue({
      ok: false,
      message: "Failed to stop process task-1: access denied.",
    });

    render(<BackgroundTasksButton tasks={[runningTask]} killTask={killTask} />);
    fireEvent.click(screen.getByRole("button", { name: "Background tasks" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop task: pnpm dev" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Failed to stop process task-1: access denied.",
    );
    expect(screen.getByText("pnpm dev")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop task: pnpm dev" })).toBeTruthy();
  });
});
