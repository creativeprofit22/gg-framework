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
  startedAt: 1,
  exitCode: null,
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
