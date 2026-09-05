// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SidecarEvent } from "./agent";
import type { Item } from "./App";
import { useAutopilot } from "./useAutopilot";

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
