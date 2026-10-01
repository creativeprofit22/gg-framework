// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CritterFloor, collectFloorAgents, type CritterGroup } from "./CritterFloor";
import type { SubAgentLine } from "./SubAgentFeed";

// jsdom has no Web Animations API; the floor only needs the calls to exist.
beforeAll(() => {
  const fakeAnimation = (): Animation =>
    ({
      finished: Promise.resolve(),
      cancel: () => undefined,
      onfinish: null,
    }) as unknown as Animation;
  Element.prototype.animate = vi.fn(fakeAnimation) as unknown as Element["animate"];
  Element.prototype.getAnimations = vi.fn(() => []) as unknown as Element["getAnimations"];
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function line(
  id: string,
  status: SubAgentLine["status"],
  extra?: Partial<SubAgentLine>,
): SubAgentLine {
  return {
    toolCallId: id,
    agentName: "researcher",
    status,
    activities: [],
    toolUseCount: 0,
    tokenUsage: { input: 0, output: 0 },
    ...extra,
  };
}

const group = (id: number, agents: SubAgentLine[], aborted?: boolean): CritterGroup => ({
  id,
  agents,
  ...(aborted === undefined ? {} : { aborted }),
});

function lane(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>(".critter-lane");
  if (!el) throw new Error("lane missing");
  return el;
}
const critters = (container: HTMLElement): number => container.querySelectorAll(".critter").length;

describe("collectFloorAgents", () => {
  it("flattens groups, keys by group + call id, and marks aborted runners interrupted", () => {
    const agents = collectFloorAgents([
      group(1, [line("a", "done", { durationMs: 1000 })]),
      group(2, [line("a", "running", { activities: ["Read x", "Grep y"] })], true),
    ]);
    expect(agents.map((a) => [a.key, a.status, a.activity])).toEqual([
      ["1:a", "done", undefined],
      ["2:a", "interrupted", "Grep y"],
    ]);
    expect(agents[0]?.label).toBe("researcher");
  });
});

describe("CritterFloor", () => {
  it("summons a critter for a running agent, then teleports it out when done", async () => {
    const { container, rerender } = render(<CritterFloor groups={[]} />);
    expect(lane(container).classList.contains("open")).toBe(false);

    const running = group(1, [line("a", "running")]);
    rerender(<CritterFloor groups={[running]} />);
    expect(lane(container).classList.contains("open")).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(critters(container)).toBe(1);
    expect(lane(container).getAttribute("aria-hidden")).toBe("true");

    rerender(<CritterFloor groups={[group(1, [line("a", "done")])]} />);
    expect(container.querySelector(".critter.leaving")).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(critters(container)).toBe(0);
    expect(lane(container).classList.contains("open")).toBe(false);
  });

  it("teleports out a background agent that finishes as idle, and tips a failed one over", async () => {
    const { container, rerender } = render(
      <CritterFloor groups={[group(1, [line("a", "running"), line("b", "running")])]} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(critters(container)).toBe(2);

    rerender(<CritterFloor groups={[group(1, [line("a", "idle"), line("b", "error")])]} />);
    expect(container.querySelector(".critter.leaving .critter-badge-ok")).not.toBeNull();
    expect(container.querySelector(".critter.fallen .critter-badge-err")).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(critters(container)).toBe(0);
    expect(lane(container).classList.contains("open")).toBe(false);
  });

  it("summons an idle agent back when a follow-up sets it running again", async () => {
    const { container, rerender } = render(
      <CritterFloor groups={[group(1, [line("a", "running")])]} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    rerender(<CritterFloor groups={[group(1, [line("a", "idle")])]} />);
    // The follow-up lands while it is still waving goodbye.
    rerender(<CritterFloor groups={[group(1, [line("a", "running")])]} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(critters(container)).toBe(1);
    expect(container.querySelector(".critter.leaving")).toBeNull();
  });

  it("never summons agents that were already finished (resumed history)", async () => {
    const { container } = render(
      <CritterFloor
        groups={[group(1, [line("a", "done"), line("b", "error"), line("c", "idle")])]}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(critters(container)).toBe(0);
    expect(lane(container).classList.contains("open")).toBe(false);
  });

  it("removes critters whose agents disappear (session switch) and cleans up on unmount", async () => {
    const { container, rerender, unmount } = render(
      <CritterFloor groups={[group(1, [line("a", "running")])]} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(critters(container)).toBe(1);
    rerender(<CritterFloor groups={[]} />);
    expect(critters(container)).toBe(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
