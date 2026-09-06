// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SidecarEvent } from "./agent";
import type { Item } from "./App";
import { useAutopilot } from "./useAutopilot";

import { driveAutopilotCycle } from "../../packages/ggcoder/src/core/autopilot-cycle";
import {
  CORPUS_UNVERIFIED_REASON,
  parseAutopilotVerdict,
} from "../../packages/ggcoder/src/core/autopilot-verdict";

const event = (type: string): SidecarEvent => ({ type, data: {} }) as SidecarEvent;

describe("useAutopilot", () => {
  it("keeps ownership until a terminal Autopilot event", () => {
    let items: Item[] = [];
    const hook = renderHook(() =>
      useAutopilot({
        setItems: (update) => {
          items = typeof update === "function" ? update(items) : update;
        },
        nextId: () => items.length + 1,
      }),
    );

    act(() => hook.result.current.handleAutopilotEvent(event("autopilot_review_start")));
    expect(hook.result.current.autopilotReviewing).toBe(true);

    act(() => hook.result.current.handleAutopilotEvent(event("text_delta")));
    expect(hook.result.current.autopilotReviewing).toBe(true);

    act(() => hook.result.current.handleAutopilotEvent(event("autopilot_done")));
    expect(hook.result.current.autopilotReviewing).toBe(false);
  });
});

describe("Autopilot evidence limitation delivery", () => {
  it("carries a parsed warning through the cycle event into the live transcript", async () => {
    let items: Item[] = [];
    let id = 0;
    const { result } = renderHook(() =>
      useAutopilot({
        setItems: (update) => {
          items = typeof update === "function" ? update(items) : update;
        },
        nextId: () => ++id,
      }),
    );
    const unexpected = async () => {
      throw new Error("A limitation must not trigger another run");
    };
    await act(async () =>
      driveAutopilotCycle({
        maxRounds: 1,
        isCancelled: () => false,
        verificationProblem: () => null,
        isPlanMode: () => false,
        planPending: () => false,
        resetReviewer: async () => {},
        review: async () =>
          parseAutopilotVerdict('{"verdict":"ALL_CLEAR","evidenceLimitation":"corpus_unverified"}'),
        reviewPlan: unexpected,
        markPlanReady: unexpected,
        requestPlanRevision: unexpected,
        runPrompt: unexpected,
        onInjected: () => {
          throw new Error("Unexpected repair");
        },
        emit: (event) => {
          result.current.handleAutopilotEvent(event);
        },
      }),
    );
    expect(items).toEqual([
      expect.objectContaining({
        kind: "autopilot",
        phase: "done",
        reason: CORPUS_UNVERIFIED_REASON,
      }),
    ]);
    expect(result.current.autopilotReviewing).toBe(false);
  });
});
