// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// agent.ts binds to the Tauri window at import; the tasks panel only needs killTask.
vi.mock("./agent", () => ({
  killTask: vi.fn(async () => ({ ok: true })),
  getGitOverview: vi.fn(),
  getGitBranches: vi.fn(),
  switchGitBranch: vi.fn(),
  openUrl: vi.fn(),
  getRadioState: vi.fn(),
  setRadio: vi.fn(),
  setRadioVolume: vi.fn(),
}));
vi.mock("./toast", () => ({ toast: vi.fn() }));

import {
  getGitBranches,
  getGitOverview,
  getRadioState,
  killTask,
  openUrl,
  type AgentState,
  type BackgroundTask,
} from "./agent";
import { useRadio } from "./useRadio";
import { toast } from "./toast";
import { Deck, gitHubOpenTarget, TasksPanel, UNPUSHED_BRANCH_NOTE, type DeckProps } from "./Deck";
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
function deckProps(over: Partial<DeckProps>): DeckProps {
  return {
    paneId: "primary",
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
    trophies: null,
    tools: {},
    ...over,
  };
}

describe("deck Escape across split panes", () => {
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

describe("Open on GitHub", () => {
  const repo = "https://github.com/o/r";
  const branchUrl = "https://github.com/o/r/tree/feat/x";

  it("opens the branch page when GitHub has the branch", () => {
    expect(
      gitHubOpenTarget({
        gitHubRepoUrl: repo,
        gitHubBranchUrl: branchUrl,
        gitHubBranchOnGitHub: true,
      }),
    ).toEqual({ url: branchUrl, note: undefined });
  });

  it("opens the repo home page on the default branch or a detached HEAD", () => {
    // Default branch: GitHub has it, but the engine sends no branch page.
    expect(
      gitHubOpenTarget({ gitHubRepoUrl: repo, gitHubBranchUrl: null, gitHubBranchOnGitHub: true }),
    ).toEqual({ url: repo, note: undefined });
    // Detached HEAD (or unknown, or an older engine): no branch information at all.
    expect(
      gitHubOpenTarget({ gitHubRepoUrl: repo, gitHubBranchUrl: null, gitHubBranchOnGitHub: null }),
    ).toEqual({ url: repo, note: undefined });
    expect(gitHubOpenTarget({ gitHubRepoUrl: repo })).toEqual({ url: repo, note: undefined });
  });

  it("opens the repo home page and says why for a branch not pushed yet", () => {
    expect(
      gitHubOpenTarget({ gitHubRepoUrl: repo, gitHubBranchUrl: null, gitHubBranchOnGitHub: false }),
    ).toEqual({ url: repo, note: UNPUSHED_BRANCH_NOTE });
  });

  it("is hidden without a GitHub repo", () => {
    expect(gitHubOpenTarget(null)).toBeNull();
    expect(gitHubOpenTarget({ gitHubRepoUrl: null, gitHubBranchUrl: branchUrl })).toBeNull();
  });

  it("wires the Git panel button to the target and its tooltip", () => {
    vi.mocked(getRadioState).mockResolvedValue({ stations: [], current: null, volume: 1 });
    vi.mocked(getGitOverview).mockReturnValue(new Promise(() => {}));
    const gitState = (over: Partial<AgentState>) =>
      ({ gitBranch: "feat/x", gitHubRepoUrl: repo, ...over }) as AgentState;

    const { rerender } = render(
      <Deck
        {...deckProps({
          showGit: true,
          panel: "git",
          state: gitState({ gitHubBranchUrl: branchUrl, gitHubBranchOnGitHub: true }),
        })}
      />,
    );
    const button = screen.getByRole("button", { name: "Open on GitHub" });
    expect(button.getAttribute("title")).toBeNull();
    fireEvent.click(button);
    expect(openUrl).toHaveBeenLastCalledWith(branchUrl);

    rerender(
      <Deck
        {...deckProps({
          showGit: true,
          panel: "git",
          state: gitState({ gitHubBranchUrl: null, gitHubBranchOnGitHub: false }),
        })}
      />,
    );
    expect(button.getAttribute("title")).toBe(UNPUSHED_BRANCH_NOTE);
    fireEvent.click(button);
    expect(openUrl).toHaveBeenLastCalledWith(repo);
  });
});

describe("Git panel branch switcher", () => {
  it("opens from the branch name and keeps Escape inside the switcher", async () => {
    vi.mocked(getRadioState).mockResolvedValue({ stations: [], current: null, volume: 1 });
    vi.mocked(getGitOverview).mockReturnValue(new Promise(() => {}));
    vi.mocked(getGitBranches).mockResolvedValue({
      status: "ok",
      current: { name: "feat/x", detached: false, commit: "abc1234" },
      hasCommits: true,
      remote: "origin",
      defaultBranch: { name: "main", source: "remote-head" },
      local: [
        { name: "main", current: false, lastUsedAt: null, upstream: null },
        { name: "feat/x", current: true, lastUsedAt: null, upstream: null },
      ],
      remoteOnly: [],
      localTotal: 2,
      remoteOnlyTotal: 0,
      truncated: false,
    });
    const onPanelChange = vi.fn();
    render(
      <Deck
        {...deckProps({
          showGit: true,
          panel: "git",
          onPanelChange,
          paneId: "pane-2",
          state: { gitBranch: "feat/x" } as AgentState,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "feat/x, switch branch" }));
    await screen.findByRole("listbox", { name: "Branches" });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search or create branch" }), {
      key: "Escape",
    });

    await waitFor(() => expect(screen.queryByRole("listbox", { name: "Branches" })).toBeNull());
    expect(onPanelChange).not.toHaveBeenCalled();
    // The Git panel's branch calls target the pane that rendered it.
    expect(getGitBranches).toHaveBeenCalledWith({ paneId: "pane-2" });
  });
});

describe("Git panel changes list", () => {
  it("re-reads the list when the uncommitted count changes, not on every render", async () => {
    vi.mocked(getRadioState).mockResolvedValue({ stations: [], current: null, volume: 1 });
    vi.mocked(getGitOverview).mockReset();
    vi.mocked(getGitOverview).mockResolvedValue({ pulls: null, issues: null, changes: [] });
    const gitState = (over: Partial<AgentState>) =>
      ({ gitBranch: "main", gitDirtyFileCount: 0, ...over }) as AgentState;
    const deck = (state: AgentState) => (
      <Deck {...deckProps({ showGit: true, panel: "git", state })} />
    );

    const { rerender } = render(deck(gitState({})));
    await waitFor(() => expect(getGitOverview).toHaveBeenCalledTimes(1));

    rerender(deck(gitState({ gitDirtyFileCount: 1 })));
    await waitFor(() => expect(getGitOverview).toHaveBeenCalledTimes(2));

    // A new state object with the same count (other fields changing) must not re-read.
    rerender(deck(gitState({ gitDirtyFileCount: 1, gitHubPRs: 3 })));
    expect(getGitOverview).toHaveBeenCalledTimes(2);
  });
});
