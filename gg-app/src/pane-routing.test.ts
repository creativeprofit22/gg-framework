import { describe, expect, it, vi } from "vitest";
import {
  PRIMARY_PANE_ID,
  SECONDARY_PANE_ID,
  createPaneEventFanout,
  matchesPaneEvent,
  type PaneTaggedEvent,
} from "./pane-routing";

interface TestEvent extends PaneTaggedEvent {
  type: string;
  data: string;
}

const event = (paneId: string | undefined, data: string, sessionId?: string): TestEvent => ({
  type: "delta",
  data,
  ...(paneId === undefined ? {} : { paneId }),
  ...(sessionId === undefined ? {} : { sessionId }),
});

describe("pane event routing", () => {
  it("routes primary events only to primary", () => {
    expect(matchesPaneEvent(event(PRIMARY_PANE_ID, "a"), PRIMARY_PANE_ID)).toBe(true);
    expect(matchesPaneEvent(event("pane-b", "b"), PRIMARY_PANE_ID)).toBe(false);
  });

  it("routes the fixed secondary pane only to its exact ID", () => {
    expect(SECONDARY_PANE_ID).toBe("secondary");
    expect(matchesPaneEvent(event(SECONDARY_PANE_ID, "b"), SECONDARY_PANE_ID)).toBe(true);
    expect(matchesPaneEvent(event(PRIMARY_PANE_ID, "a"), SECONDARY_PANE_ID)).toBe(false);
  });

  it("accepts an untagged legacy event only for primary", () => {
    expect(matchesPaneEvent(event(undefined, "legacy"), PRIMARY_PANE_ID)).toBe(true);
    expect(matchesPaneEvent(event(undefined, "legacy"), "pane-b")).toBe(false);
  });

  it("preserves independent order for interleaved pane events", () => {
    const fanout = createPaneEventFanout<TestEvent>();
    const primary: string[] = [];
    const paneB: string[] = [];
    fanout.subscribe(PRIMARY_PANE_ID, (value) => primary.push(value.data));
    fanout.subscribe(SECONDARY_PANE_ID, (value) => paneB.push(value.data));

    fanout.dispatch(event(PRIMARY_PANE_ID, "a1"));
    fanout.dispatch(event(SECONDARY_PANE_ID, "b1"));
    fanout.dispatch(event(PRIMARY_PANE_ID, "a2"));
    fanout.dispatch(event(SECONDARY_PANE_ID, "b2"));

    expect(primary).toEqual(["a1", "a2"]);
    expect(paneB).toEqual(["b1", "b2"]);
  });

  it("rejects stale tagged events while retaining primary legacy compatibility", () => {
    const fanout = createPaneEventFanout<TestEvent>();
    const paneBListener = vi.fn();
    const primaryListener = vi.fn();
    fanout.subscribe(SECONDARY_PANE_ID, paneBListener, "session-new");
    fanout.subscribe(PRIMARY_PANE_ID, primaryListener, "primary-session");

    fanout.dispatch(event(SECONDARY_PANE_ID, "stale", "session-old"));
    fanout.dispatch(event(SECONDARY_PANE_ID, "missing-session"));
    fanout.dispatch(event(SECONDARY_PANE_ID, "current", "session-new"));
    fanout.dispatch(event(undefined, "legacy"));

    expect(paneBListener).toHaveBeenCalledTimes(1);
    expect(paneBListener).toHaveBeenCalledWith(event(SECONDARY_PANE_ID, "current", "session-new"));
    expect(primaryListener).toHaveBeenCalledWith(event(undefined, "legacy"));
  });
});
