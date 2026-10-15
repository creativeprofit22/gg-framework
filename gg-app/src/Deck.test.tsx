// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// agent.ts binds to the Tauri window at import; the tasks panel only needs killTask.
vi.mock("./agent", () => ({
  killTask: vi.fn(async () => ({ ok: true })),
  getGitOverview: vi.fn(),
  openUrl: vi.fn(),
  getRadioState: vi.fn(),
  setRadio: vi.fn(),
  setRadioVolume: vi.fn(),
}));
vi.mock("./toast", () => ({ toast: vi.fn() }));

import { getRadioState, killTask, type BackgroundTask } from "./agent";
import { useRadio } from "./useRadio";
import { toast } from "./toast";
import { Deck, TasksPanel, type DeckProps } from "./Deck";
import { formatBackgroundTaskStatus, isBackgroundTaskRunning } from "./background-task-status";

function task(over: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: "t1",
    pid: 101,
    command: "pnpm dev",
    startedAt: Date.now(),
    exitCode: null,
    isRunning: true,
    signal: null,
    stopReason: null,
    completedAt: null,
    ...over,
  };
}

afterEach(cleanup);

// Moved from the Fork's BackgroundTasksButton suite: the Deck's tasks panel
// replaced that footer popover, so its daemon-liveness rules live here now.
describe("Deck TasksPanel", () => {
  it("counts only daemon-live tasks and offers Stop only for them", () => {
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
      task({ id: "bad", command: "failed cmd", isRunning: false, exitCode: 2, completedAt: 2 }),
    ];
    render(<TasksPanel tasks={tasks} onEmpty={vi.fn()} onClose={vi.fn()} />);

    expect(screen.getByText("1 running \u00b7 4 finished")).toBeTruthy();
    expect(screen.getByText("Finished")).toBeTruthy();
    expect(screen.getByText("signal SIGTERM")).toBeTruthy();
    expect(screen.getByText("stopped: no output")).toBeTruthy();
    expect(screen.getByText("Exit 2")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Stop / })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Stop running cmd" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop all" })).toBeNull();
  });

  it("says so when stopping a task fails", async () => {
    vi.mocked(killTask).mockResolvedValueOnce({ ok: false, error: "process not found" });
    render(<TasksPanel tasks={[task()]} onEmpty={vi.fn()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /^Stop / }));

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

describe("deck radio", () => {
  it("survives a failed station read without an unhandled rejection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(getRadioState).mockRejectedValueOnce(new Error("sidecar restarting"));
    const { result } = renderHook(() => useRadio());
    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith("radio state read failed", expect.any(Error)),
    );
    expect(result.current.stations).toEqual([]);
    warn.mockRestore();
  });
});

// Fork: split panes each render a deck, and the Escape listener is
// window-wide. Ungated, the first-mounted deck claims the key, so Escape in
// pane 2 closed pane 1's panel. Only the focused pane's panel may close.
describe("deck Escape across split panes", () => {
  function deckProps(over: Partial<DeckProps>): DeckProps {
    return {
      state: null,
      hydrated: true,
      showGit: false,
      panel: "more",
      onPanelChange: vi.fn(),
      status: null,
      composer: null,
      menu: null,
      running: false,
      contextPct: 0,
      models: [],
      modelsFailed: false,
      onSelectModel: vi.fn(),
      second: null,
      tasks: [],
      schedules: [],
      onStopSchedule: vi.fn(),
      projectHealth: null,
      usageExtras: null,
      progress: null,
      tools: {},
      ...over,
    };
  }

  it("closes the focused pane's panel and leaves the other pane's open", () => {
    vi.mocked(getRadioState).mockResolvedValue({ stations: [], current: null, volume: 1 });
    const focusedChange = vi.fn();
    const otherChange = vi.fn();
    render(
      <>
        <Deck {...deckProps({ focused: false, onPanelChange: otherChange })} />
        <Deck {...deckProps({ focused: true, onPanelChange: focusedChange })} />
      </>,
    );

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(focusedChange).toHaveBeenCalledTimes(1);
    expect(focusedChange).toHaveBeenCalledWith(null);
    expect(otherChange).not.toHaveBeenCalled();
  });
});
