// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WorkspaceHeaderActions, type GoalView } from "./WorkspaceHeaderActions";
import { EMPTY_TALLY, tallyGoal, type GoalTally } from "./goal-progress";

vi.mock("./RadioButton", () => ({ RadioButton: () => <button>Radio</button> }));
vi.mock("./WindowLayoutButton", () => ({ WindowLayoutButton: () => <button>Windows</button> }));
vi.mock("./RankBadge", () => ({ RankBadge: () => null }));
vi.mock("./AutopilotToggle", () => ({ AutopilotToggle: () => <button>Autopilot</button> }));

function renderActions(
  isGoal: boolean,
  needsGitInit = false,
  goalView: GoalView | null = null,
  onGoalViewChange = vi.fn(),
  goalNeedsAnswer = false,
  goalTally: GoalTally | null = null,
  goal: {
    state?: "running" | "paused" | "stopped";
    onPause?: (paused: boolean) => void;
    onSettings?: () => void;
  } = {},
): void {
  render(
    <WorkspaceHeaderActions
      workspaceMode="code"
      isGoal={isGoal}
      goalView={goalView}
      onGoalViewChange={onGoalViewChange}
      goalNeedsAnswer={goalNeedsAnswer}
      goalTally={goalTally}
      goalState={goal.state}
      onGoalPauseChange={goal.onPause}
      onOpenGoalSettings={goal.onSettings}
      progress={null}
      rankCelebrateNonce={null}
      xpChips={[]}
      onOpenScorecard={vi.fn()}
      windowFocused
      running={false}
      autopilot={false}
      autopilotReviewing={false}
      onAutopilotChange={vi.fn()}
      onNewSession={vi.fn()}
      onOpenNotes={vi.fn()}
      onOpenMemories={vi.fn()}
      projectTasks={[]}
      onOpenTasks={vi.fn()}
      showChecklist={false}
      onOpenChecklist={vi.fn()}
      onArrange={vi.fn()}
      needsGitInit={needsGitInit}
      onInitGit={vi.fn()}
      commitCommand="commit"
      hasCommit
      onCommit={vi.fn()}
    />,
  );
}

afterEach(cleanup);

describe("WorkspaceHeaderActions", () => {
  it("keeps only Radio, Windows and commit in a Goal window", () => {
    // A goal folder is not a git repo; commit still shows, Initialize Git never does.
    renderActions(true, true);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Radio",
      "Windows",
      "/commit",
    ]);
  });

  it("switches a started goal between Chat and Workers", () => {
    const change = vi.fn();
    renderActions(true, false, "workers", change);
    const group = screen.getByRole("group", { name: "Goal view" });
    expect(group.textContent).toBe("ChatWorkers");
    expect(screen.getByRole("button", { name: "Workers" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(change).toHaveBeenLastCalledWith("chat");
  });

  it("flags Chat while a question waits there, but not when Chat is open", () => {
    renderActions(true, false, "workers", vi.fn(), true);
    const chat = screen.getByRole("button", { name: "Chat, a question is waiting for you" });
    expect(chat.getAttribute("data-attention")).toBe("true");
    cleanup();
    renderActions(true, false, "chat", vi.fn(), true);
    expect(screen.getByRole("button", { name: "Chat" }).getAttribute("data-attention")).toBeNull();
  });

  it("shows how many workers are working, and the tasks done and failed, right of the level", () => {
    const tally = tallyGoal(EMPTY_TALLY, [
      { key: "a", phase: "working" },
      { key: "b", phase: "working" },
      { key: "c", phase: "done" },
    ]);
    renderActions(true, false, "workers", vi.fn(), false, tally);
    const status = screen.getByRole("status", { name: "2 working · 1 done" });
    expect(status.textContent).toBe("2 working1 done");
    // On the left with the level badge, not among the right-hand actions.
    expect(status.closest(".picker-head-actions")).toBeNull();
    expect(status.previousElementSibling?.className).toBe("rank-badge-wrap");
    cleanup();
    // Failed tasks only show once there are any.
    const failed = tallyGoal(tally, [
      { key: "a", phase: "failed" },
      { key: "b", phase: "done" },
      { key: "c", phase: "done" },
    ]);
    renderActions(true, false, "chat", vi.fn(), false, failed);
    expect(screen.getByRole("status", { name: "0 working · 2 done · 1 failed" })).toBeTruthy();
  });

  it("pauses and resumes a started goal, and opens its settings", () => {
    const onPause = vi.fn();
    const onSettings = vi.fn();
    renderActions(true, false, "workers", vi.fn(), false, null, {
      state: "running",
      onPause,
      onSettings,
    });
    fireEvent.click(screen.getByRole("button", { name: "Pause the goal" }));
    expect(onPause).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Goal settings" }));
    expect(onSettings).toHaveBeenCalledOnce();
    cleanup();

    renderActions(true, false, "workers", vi.fn(), false, null, { state: "paused", onPause });
    const resume = screen.getByRole("button", { name: "Resume the goal" });
    expect(resume.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(resume);
    expect(onPause).toHaveBeenLastCalledWith(false);
    cleanup();

    // Finished, stopped or cut off: never a Pause for a goal doing nothing.
    renderActions(true, false, "workers", vi.fn(), false, null, { state: "stopped", onPause });
    expect(screen.queryByRole("button", { name: "Pause the goal" })).toBeNull();
    const carryOn = screen.getByRole("button", { name: "Not running. Carry the goal on" });
    expect(carryOn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(carryOn);
    expect(onPause).toHaveBeenLastCalledWith(false);
  });

  it("has no view switch before the goal starts", () => {
    renderActions(true);
    expect(screen.queryByRole("group", { name: "Goal view" })).toBeNull();
  });

  it("still shows the full project toolset in a code window", () => {
    renderActions(false);
    const labels = screen.getAllByRole("button").map((b) => b.textContent);
    for (const label of ["Autopilot", "New", "Notes", "Tasks", "Checklist", "/commit"]) {
      expect(labels).toContain(label);
    }
  });
});
