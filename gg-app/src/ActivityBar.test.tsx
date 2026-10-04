// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { theme } from "./theme";
import { INITIAL_ACTIVITY } from "./task-activity";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ActivityBar, plainState } from "./ActivityBar";
import type { TaskPhase } from "./task-activity";
import { reduceTaskActivity } from "./task-activity";
import type { SidecarEvent } from "./agent";

const restoredPlan = {
  checkpointId: "checkpoint-1",
  generation: 1,
  planPath: ".gg/plans/plan.md",
  content: "# Plan",
  contentHash: "hash-1",
  state: "pending-review",
  reviewStatus: "ready",
  feedback: null,
};
const restoredAsks = [
  { id: "ask-1", questions: [{ id: "q1", question: "Proceed?", kind: "confirm" }] },
];

const baseProps = {
  running: true,
  tokens: 0,
  doneStatus: null,
  isThinking: false,
  thinkingStartTs: null,
  thinkingAccumMs: 0,
  onCancel: vi.fn(),
};

beforeAll(async () => {
  const { container, unmount } = render(<ActivityBar {...baseProps} />);
  await waitFor(() => expect(container.querySelector("canvas")).toBeTruthy());
  unmount();
});

describe("ActivityBar plan progress", () => {
  it("shows approved-plan progress only while a run is active", () => {
    const { rerender } = render(<ActivityBar {...baseProps} planTotal={3} planDone={2} />);
    expect(screen.getByText("Plan")).toBeTruthy();
    expect(screen.getByText("2/3")).toBeTruthy();

    rerender(<ActivityBar {...baseProps} planTotal={3} planDone={3} />);
    expect(screen.queryByText("Plan")).toBeNull();
    expect(screen.queryByText("3/3")).toBeNull();

    rerender(<ActivityBar {...baseProps} running={false} planTotal={3} planDone={2} />);
    expect(screen.queryByText("Plan")).toBeNull();
  });
});

describe("ActivityBar orb", () => {
  it("keeps the listening orb during reasoning and disappears when idle", () => {
    const { container, rerender } = render(<ActivityBar {...baseProps} isThinking />);
    expect(container.querySelector("canvas")?.getAttribute("aria-label")).toBe("Listening…");
    expect(screen.getByText("Working…").classList.contains("shimmer-text")).toBe(true);

    rerender(<ActivityBar {...baseProps} running={false} />);
    expect(container.querySelector("canvas")).toBeNull();
  });
});

describe("ActivityBar task outcomes", () => {
  it("shows earlier workspace warnings separately without relabelling the current answer", () => {
    const activity = {
      ...INITIAL_ACTIVITY,
      phase: "done" as const,
      label: "Response ready",
      startedAt: 6,
      endedAt: 1000,
      workspaceWarning: "Earlier checks failed",
    };
    const { container, rerender } = render(
      <ActivityBar {...baseProps} running={false} activity={activity} />,
    );
    expect(screen.getByRole("status").textContent).toContain("Answer ready. GG.");
    expect(screen.getByText("Earlier checks failed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel agent run" })).toBeNull();
    const label = container.querySelector(".activity-label-reveal");
    rerender(
      <ActivityBar {...baseProps} running={false} activity={{ ...activity, tokens: 1000 }} />,
    );
    expect(container.querySelector(".activity-label-reveal")).toBe(label);
    expect(screen.getByText("Earlier checks failed")).toBeTruthy();
  });
  it("does not show the previous success while a new request is starting", () => {
    const { container } = render(
      <ActivityBar
        {...baseProps}
        running={true}
        activity={{
          ...INITIAL_ACTIVITY,
          phase: "done",
          endedAt: 1000,
          label: "Done · checks passed",
        }}
      />,
    );
    expect(screen.getByText("Starting…")).toBeTruthy();
    expect(screen.queryByText("Checks passed")).toBeNull();
    expect(container.querySelector("canvas")).toBeTruthy();
    expect(container.querySelector(".activity-meta")).toBeNull();
  });

  it("shows a failed stop in red without pretending the run has stopped", () => {
    const { container } = render(
      <ActivityBar
        {...baseProps}
        activity={{
          ...INITIAL_ACTIVITY,
          phase: "working",
          label: "Cancellation failed · task still running",
        }}
      />,
    );
    expect(screen.getByText("Stop failed").style.getPropertyValue("--shimmer-base")).toBe(
      theme.error,
    );
    expect(container.querySelector("canvas")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Cancel agent run" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it.each([
    ["done", "Done · checks passed", "Checks passed. Nice.", theme.success],
    ["failed", "Checks failed", "Checks hit a snag", theme.error],
    ["failed", "Task failed", "Run hit a snag", theme.error],
    ["unverified", "Changed · verification incomplete", "Checks still needed", theme.warning],
    ["attention", "Your decision needed", "Your call from here", theme.warning],
    ["stopped", "Stopped · unfinished", "Stopped. Not finished", theme.warning],
  ] as const)("pairs %s color with a readable status", (phase, label, compact, color) => {
    render(
      <ActivityBar
        {...baseProps}
        running={false}
        activity={{ ...INITIAL_ACTIVITY, phase, label }}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain(compact);
    const expected = document.createElement("span");
    expected.style.color = color;
    expect(screen.getByText(compact).style.color).toBe(expected.style.color);
  });

  it("reveals changed labels without restarting the orb or replaying on usage updates", () => {
    const activity = { ...INITIAL_ACTIVITY, phase: "working" as const, label: "Thinking…" };
    const { container, rerender } = render(<ActivityBar {...baseProps} activity={activity} />);
    const region = screen.getByRole("status");
    const orb = container.querySelector("canvas");
    const thinking = container.querySelector(".activity-label-reveal");
    rerender(<ActivityBar {...baseProps} activity={{ ...activity, tokens: 100 }} />);
    expect(container.querySelector(".activity-label-reveal")).toBe(thinking);
    expect(container.querySelector("canvas")).toBe(orb);

    rerender(
      <ActivityBar {...baseProps} activity={{ ...activity, label: "Writing a response…" }} />,
    );
    const writing = container.querySelector(".activity-label-reveal");
    expect(writing).not.toBe(thinking);
    expect(writing?.textContent).toBe("Writing…");
    expect(container.querySelector("canvas")).toBe(orb);
    expect(screen.getByRole("status")).toBe(region);

    rerender(
      <ActivityBar
        {...baseProps}
        running={false}
        activity={{ ...activity, phase: "done", label: "Done · checks passed" }}
      />,
    );
    expect(container.querySelector(".activity-label-reveal")).not.toBe(writing);
    expect(region.textContent).toContain("Checks passed");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("keeps the orb and shimmer while Ken reviews without an active builder", () => {
    const { container } = render(
      <ActivityBar
        {...baseProps}
        running={false}
        activity={{
          ...INITIAL_ACTIVITY,
          phase: "reviewing",
          label: "Ken reviewing…",
          startedAt: 100,
        }}
      />,
    );
    expect(container.querySelector("canvas")).toBeTruthy();
    expect(screen.getByText("Ken reviewing…").classList.contains("shimmer-text")).toBe(true);
    expect(screen.queryByText("Response ready")).toBeNull();
  });
  it("shows a compact outcome and metrics without a details panel", () => {
    const { container } = render(
      <ActivityBar
        {...baseProps}
        running={false}
        doneStatus="Brewed a response in 32s"
        activity={{
          ...INITIAL_ACTIVITY,
          phase: "unverified",
          label: "Changed · verification incomplete",
          detail: "Run the missing tests before using the changes.",
          startedAt: 1000,
          endedAt: 33000,
          tokens: 1300,
        }}
      />,
    );
    expect(screen.queryByText(/Brewed/)).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Checks need another look");
    expect(screen.getByRole("status").textContent).not.toContain("tokens");
    expect(container.querySelector(".activity-meta")?.textContent).toBe("32s · 1.3k tok");
    expect(container.querySelector("canvas")).toBeNull();
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
    expect(screen.queryByText("Run the missing tests before using the changes.")).toBeNull();
    expect(container.querySelector(".activity-details")).toBeNull();
  });
  it("stops animation while waiting for a decision but keeps cancellation available", () => {
    const { container } = render(
      <ActivityBar
        {...baseProps}
        activity={{
          ...INITIAL_ACTIVITY,
          phase: "attention",
          label: "Your decision needed",
          detail: "Answer in chat.",
        }}
      />,
    );
    expect(container.querySelector("canvas")).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel agent run" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Your call from here");
  });
});

/** Text a screen reader announces: skips aria-hidden subtrees. */
function accessibleText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node instanceof Element && node.getAttribute("aria-hidden") === "true") return "";
  return Array.from(node.childNodes).map(accessibleText).join("");
}
const announced = (): string =>
  accessibleText(screen.getByRole("status")).replace(/\s+/g, " ").trim();

describe("ActivityBar plain state", () => {
  it.each([
    ["idle", false, "Idle"],
    ["working", true, "Working"],
    ["reviewing", false, "Working"],
    ["attention", true, "Waiting"],
    ["done", false, "Done"],
    ["unverified", false, "Done"],
    ["failed", false, "Error"],
    ["stopped", false, "Stopped"],
  ] as const)("maps %s to one of six plain states", (phase: TaskPhase, running, expected) => {
    const activity = { ...INITIAL_ACTIVITY, phase };
    expect(plainState({ activity, running, cancelling: false, doneStatus: null })).toBe(expected);
  });

  it("covers cancelling, starting, waiting, failed stops and bare finishes", () => {
    const base = { running: false, cancelling: false, doneStatus: null };
    expect(plainState({ ...base, running: true, cancelling: true })).toBe("Working");
    expect(
      plainState({
        ...base,
        running: true,
        activity: { ...INITIAL_ACTIVITY, phase: "failed", endedAt: 5 },
      }),
    ).toBe("Working");
    expect(
      plainState({
        ...base,
        running: true,
        activity: { ...INITIAL_ACTIVITY, phase: "working", waitingForAnswer: true },
      }),
    ).toBe("Waiting");
    expect(
      plainState({
        ...base,
        running: true,
        activity: {
          ...INITIAL_ACTIVITY,
          phase: "working",
          label: "Cancellation failed · task still running",
        },
      }),
    ).toBe("Error");
    expect(
      plainState({
        ...base,
        running: true,
        activity: { ...INITIAL_ACTIVITY, phase: "working", connectionLost: true },
      }),
    ).toBe("Working");
    expect(plainState({ ...base, doneStatus: "Brewed in 3s" })).toBe("Done");
    expect(plainState(base)).toBe("Idle");
  });

  it.each([
    ["done", "Response ready", "Done · Response ready", theme.success],
    ["unverified", "Verification incomplete", "Done · Verification incomplete", theme.warning],
    ["failed", "Task failed", "Error · Task failed", theme.error],
    ["stopped", "Stopped · unfinished", "Stopped · Unfinished", theme.warning],
    ["done", "Done · checks passed", "Done · Checks passed", theme.success],
    ["attention", "Your decision needed", "Waiting · Your decision needed", theme.warning],
  ] as const)("announces %s plainly in its tone", (phase, label, text, color) => {
    const { container } = render(
      <ActivityBar
        {...baseProps}
        running={false}
        activity={{ ...INITIAL_ACTIVITY, phase, label, startedAt: 1 }}
      />,
    );
    expect(announced()).toBe(text);
    const expected = document.createElement("span");
    expected.style.color = color;
    const word = container.querySelector<HTMLElement>(".statusrow-state");
    expect(word?.style.color).toBe(expected.style.color);
  });

  it.each([
    [
      "a plan after a disconnected run",
      () =>
        reduceTaskActivity(INITIAL_ACTIVITY, { type: "run_start", data: {} } as SidecarEvent, 1),
      { cwd: "/p", running: false, pendingPlanReview: restoredPlan },
      false,
      "Waiting · Plan needs your decision",
    ],
    [
      "a plan in a reopened pane",
      () => INITIAL_ACTIVITY,
      { cwd: "/p", running: false, pendingPlanReview: restoredPlan },
      false,
      "Waiting · Plan needs your decision",
    ],
    [
      "an open question during a live run",
      () =>
        reduceTaskActivity(
          reduceTaskActivity(INITIAL_ACTIVITY, { type: "run_start", data: {} } as SidecarEvent, 1),
          { type: "connection_lost", data: {} } as SidecarEvent,
          2,
        ),
      { cwd: "/p", running: true, pendingAsks: restoredAsks },
      true,
      "Waiting · Your decision needed",
    ],
  ] as const)(
    "announces Waiting for %s restored by a ready snapshot",
    (_, from, data, running, text) => {
      const activity = reduceTaskActivity(from(), { type: "ready", data } as SidecarEvent, 1000);
      expect(plainState({ activity, running, cancelling: false, doneStatus: null })).toBe(
        "Waiting",
      );
      render(<ActivityBar {...baseProps} running={running} activity={activity} />);
      expect(announced()).toBe(text);
      expect(announced()).not.toMatch(/^(Stopped|Idle|Working)\b/);
    },
  );

  it("announces only the state word when idle and the plain label while working", () => {
    const { rerender } = render(<ActivityBar {...baseProps} running={false} />);
    expect(announced()).toBe("Idle");
    rerender(
      <ActivityBar
        {...baseProps}
        activity={{ ...INITIAL_ACTIVITY, phase: "working", label: "Running verification…" }}
      />,
    );
    expect(announced()).toBe("Working · Running verification…");
    expect(screen.getByText("Verifying…")).toBeTruthy();
  });
});

describe("ActivityBar cancellation state", () => {
  it("shows an enabled cancel action during a normal run", () => {
    render(<ActivityBar {...baseProps} />);
    expect(
      (screen.getByRole("button", { name: "Cancel agent run" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    const orb = screen.getByRole("status").querySelector("canvas");
    expect(orb?.getAttribute("aria-hidden")).toBe("true");
    expect(orb?.getAttribute("aria-label")).toBe("Listening…");
    expect(orb?.style.width).toBe("20px");
  });

  it("announces and disables cancellation while awaiting settlement", () => {
    render(<ActivityBar {...baseProps} cancelling />);
    const button = screen.getByRole("button", { name: "Cancellation in progress" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.textContent).toContain("Stopping…");
    expect(screen.getByRole("status")).toBeTruthy();
  });
});
