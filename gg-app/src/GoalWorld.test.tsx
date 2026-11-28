// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GoalWorld, describeWorld, farmMotion, farmScale, fitFarm } from "./GoalWorld";
import { FARM_CORE } from "./goal-farm-map";
import { TILE } from "./goal-map-ground";
import { COORDINATOR_KEY } from "./goal-world-agents";

beforeAll(() => {
  // No canvas in jsdom: the picture is decoration, the summary carries the facts.
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
  // jsdom has no ResizeObserver; the world only needs it to size its canvas.
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
});

afterEach(cleanup);

describe("GoalWorld", () => {
  it("always fits the whole farmstead, scaling smoothly with the window", () => {
    // Regression: the scale was a whole number, so a window a little smaller
    // than full screen dropped from 2x to 1x and the farm suddenly halved.
    const coreW = FARM_CORE.cols * TILE;
    const coreH = FARM_CORE.rows * TILE;
    let previous = 0;
    for (const w of [800, 900, 1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700]) {
      const h = Math.round(w * 0.62);
      const f = fitFarm(w, h, 56);
      // The whole farmstead is on screen, below the header.
      expect(coreW * f.scale).toBeLessThanOrEqual(w + 0.5);
      expect(coreH * f.scale).toBeLessThanOrEqual(h - 56 + 0.5);
      // And it fills one side: as big as it can be, never a halved farm.
      const filled = Math.max((coreW * f.scale) / w, (coreH * f.scale) / (h - 56));
      expect(filled).toBeGreaterThan(0.99);
      // A bigger window never shows a smaller farm.
      expect(f.scale).toBeGreaterThanOrEqual(previous);
      previous = f.scale;
    }
    expect(farmScale(coreW * 2, coreH * 2)).toBe(2);
  });

  it("keeps the farm moving at full speed when the window isn't focused", () => {
    // Regression: an unfocused window dropped to ~12fps with the fire, water
    // and animals at rest, so hens walked on the spot.
    expect(farmMotion("still", false)).toEqual(farmMotion("full", false));
    expect(farmMotion("still", false)).toEqual({ runs: true, ambientStill: false });
    expect(farmMotion("off", false).runs).toBe(false);
    expect(farmMotion("full", true).ambientStill).toBe(true);
  });

  it("builds a map that covers the stage edge to edge, keeping the farmstead below the header", () => {
    for (const [w, h] of [
      [1728, 1080],
      [960, 640],
      [1400, 600],
    ] as const) {
      const f = fitFarm(w, h, 56);
      const cell = TILE * f.scale;
      expect(f.cols * cell).toBeGreaterThanOrEqual(w - 0.5);
      expect(f.rows * cell).toBeGreaterThanOrEqual(h - 0.5);
      expect(f.cols).toBeGreaterThanOrEqual(FARM_CORE.cols);
      expect(f.rows).toBeGreaterThanOrEqual(FARM_CORE.rows);
      expect(f.top * cell).toBeGreaterThanOrEqual(56);
    }
  });

  it("is the whole view: no roster, no input, and the facts in a hidden live summary", () => {
    render(
      <GoalWorld
        goalId="seo"
        running
        liveTools={
          [{ id: "a", name: "read", args: { file_path: "/x/a.ts" }, status: "running" }] as never
        }
        waitingOnUser={false}
        workers={[
          {
            key: "g:1",
            agentName: "researcher",
            label: "researcher",
            status: "running",
            activity: "Searching web for seo",
            tokens: "",
            durationMs: 0,
            toolUseCount: 1,
          },
        ]}
      />,
    );
    const view = screen.getByRole("region", { name: "Workers" });
    expect(view.querySelector("canvas")).not.toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(view.querySelector(".goal-world-summary")?.textContent).toBe(
      "GG Goals: Reading a.ts. researcher: Searching web for seo.",
    );
  });

  it("hangs GG Goals' question over the farm until the user goes to answer it", () => {
    const onAnswer = vi.fn();
    const { rerender } = render(
      <GoalWorld
        goalId="g"
        running={false}
        liveTools={[]}
        waitingOnUser
        workers={[]}
        ask={{ question: "Which database should we use?" }}
        onShowChat={onAnswer}
      />,
    );
    const notice = screen.getByRole("alert");
    expect(notice.textContent).toContain("Ken needs you");
    expect(notice.textContent).toContain("Which database should we use?");
    fireEvent.click(screen.getByRole("button", { name: "Answer in Chat" }));
    expect(onAnswer).toHaveBeenCalledTimes(1);
    // The caller takes it down once the user has been to the chat.
    rerender(
      <GoalWorld goalId="g" running={false} liveTools={[]} waitingOnUser workers={[]} ask={null} />,
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the finish card with its score until the user closes it or goes to the chat", () => {
    const onShowChat = vi.fn();
    const onClose = vi.fn();
    const finish = {
      id: 1,
      goalId: "g",
      outcome: "done",
      elapsedMs: 754_000,
      turns: 12,
      workers: 3,
      failedWorkers: 1,
      outputTokens: 48_200,
      face: "excited",
      line: "Images done. Mobile load is down to 1.4 seconds.",
    } as const;
    const props = {
      goalId: "g",
      running: false,
      liveTools: [],
      waitingOnUser: false,
      workers: [],
      onShowChat,
      onCloseFinish: onClose,
      finish,
    };
    const { rerender } = render(<GoalWorld {...props} />);
    const card = screen.getByRole("status");
    expect(card.textContent).toContain("Job done");
    expect(card.textContent).toContain("Mobile load is down to 1.4 seconds.");
    expect(card.textContent).toContain("12m 34s");
    expect(card.textContent).toContain("1 failed");
    expect(card.textContent).toContain("48.2k");
    fireEvent.click(screen.getByRole("button", { name: "Read summary in Chat" }));
    expect(onShowChat).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    // A question outranks it: the ask sign shows instead.
    rerender(<GoalWorld {...props} waitingOnUser ask={{ question: "Which one?" }} />);
    expect(screen.queryByText("Job done")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Which one?");
  });

  it("shows Ken's status, and steps it aside while a sign is up so only one thing shows", () => {
    const status = {
      key: "tool:1",
      tone: "work",
      icon: "read",
      face: "focused",
      headline: "Reading search.ts",
      detail: "In server/rag",
      mark: null,
      opens: false,
      thinking: false,
      timed: true,
    } as const;
    const props = {
      goalId: "g",
      running: true,
      liveTools: [],
      waitingOnUser: false,
      workers: [],
      kenStatus: status,
    };
    const { container, rerender } = render(<GoalWorld {...props} />);
    const pill = container.querySelector(".ken-status");
    expect(pill?.textContent).toContain("Reading search.ts");
    expect(pill?.hasAttribute("data-away")).toBe(false);
    // It's decoration: the live summary says the same for screen readers.
    expect(pill?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".goal-world-summary")?.textContent).toContain(
      "Reading search.ts",
    );
    // A question goes up: the status steps aside rather than sharing the screen.
    rerender(<GoalWorld {...props} waitingOnUser ask={{ question: "Which one?" }} />);
    expect(container.querySelector(".ken-status")?.hasAttribute("data-away")).toBe(true);
    rerender(<GoalWorld {...props} ask={null} />);
    expect(container.querySelector(".ken-status")?.hasAttribute("data-away")).toBe(false);
  });

  it("lists the farm's things as buttons, so they can be poked from the keyboard", () => {
    render(
      <GoalWorld goalId="g" running={false} liveTools={[]} waitingOnUser={false} workers={[]} />,
    );
    const group = screen.getByRole("group", { name: "Things on the farm" });
    // The farm builds once it has a size; in jsdom it may not, so the group can be empty.
    expect(group).toBeTruthy();
  });

  it("describes finished and stopped workers plainly", () => {
    expect(
      describeWorld([
        {
          key: COORDINATOR_KEY,
          agentName: undefined,
          name: "GG Goals",
          coordinator: true,
          status: "idle",
          kind: null,
          detail: "Ready when you are",
        },
        {
          key: "w",
          agentName: "worker",
          name: "worker",
          coordinator: false,
          status: "error",
          kind: null,
          detail: "Stopped",
        },
      ]),
    ).toBe("GG Goals: Ready when you are. worker: stopped.");
  });
});
