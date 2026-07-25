// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import type { Dispatch, SetStateAction } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Item } from "./App";
import type { SidecarEvent } from "./agent";
import { useAutopilot } from "./useAutopilot";

const terminalEvents: SidecarEvent[] = [
  { type: "autopilot_done", data: {} },
  { type: "autopilot_ignored", data: {} },
  { type: "autopilot_human", data: { reason: "needs a decision" } },
  { type: "autopilot_capped", data: {} },
  { type: "autopilot_error", data: { message: "review failed" } },
  { type: "run_end", data: { cancelled: true } },
];

function setup() {
  const setItems = vi.fn() as Dispatch<SetStateAction<Item[]>>;
  let id = 0;
  return renderHook(() => useAutopilot({ setItems, nextId: () => ++id }));
}

describe("useAutopilot active review state", () => {
  it("starts reviewing on autopilot_review_start", () => {
    const hook = setup();

    act(() =>
      hook.result.current.handleAutopilotEvent({ type: "autopilot_review_start", data: {} }),
    );

    expect(hook.result.current.autopilotReviewing).toBe(true);
  });

  it.each(terminalEvents)("returns to inactive on $type", (terminalEvent) => {
    const hook = setup();
    act(() =>
      hook.result.current.handleAutopilotEvent({ type: "autopilot_review_start", data: {} }),
    );
    expect(hook.result.current.autopilotReviewing).toBe(true);

    act(() => hook.result.current.handleAutopilotEvent(terminalEvent));

    expect(hook.result.current.autopilotReviewing).toBe(false);
  });
});
