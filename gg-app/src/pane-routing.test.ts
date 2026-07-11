import { describe, expect, it, vi } from "vitest";
import {
  PRIMARY_PANE_ID,
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

  it("routes arbitrary auxiliary panes only to their exact IDs", () => {
    expect(matchesPaneEvent(event("pane-2", "b"), "pane-2")).toBe(true);
    expect(matchesPaneEvent(event("pane-3", "c"), "pane-2")).toBe(false);
    expect(matchesPaneEvent(event(PRIMARY_PANE_ID, "a"), "pane-3")).toBe(false);
  });

  it("accepts an untagged legacy event only for primary", () => {
    expect(matchesPaneEvent(event(undefined, "legacy"), PRIMARY_PANE_ID)).toBe(true);
    expect(matchesPaneEvent(event(undefined, "legacy"), "pane-b")).toBe(false);
  });

  it("preserves isolation and order for interleaved arbitrary pane events", () => {
    const fanout = createPaneEventFanout<TestEvent>();
    const primary: string[] = [];
    const pane2: string[] = [];
    const pane3: string[] = [];
    fanout.subscribe(PRIMARY_PANE_ID, (value) => primary.push(value.data));
    fanout.subscribe("pane-2", (value) => pane2.push(value.data));
    fanout.subscribe("pane-3", (value) => pane3.push(value.data));

    fanout.dispatch(event(PRIMARY_PANE_ID, "a1"));
    fanout.dispatch(event("pane-3", "c1"));
    fanout.dispatch(event("pane-2", "b1"));
    fanout.dispatch(event("pane-3", "c2"));
    fanout.dispatch(event(PRIMARY_PANE_ID, "a2"));

    expect(primary).toEqual(["a1", "a2"]);
    expect(pane2).toEqual(["b1"]);
    expect(pane3).toEqual(["c1", "c2"]);
  });

  it("rejects stale tagged events while retaining primary legacy compatibility", () => {
    const fanout = createPaneEventFanout<TestEvent>();
    const paneBListener = vi.fn();
    const primaryListener = vi.fn();
    fanout.subscribe("pane-3", paneBListener, "session-new");
    fanout.subscribe(PRIMARY_PANE_ID, primaryListener, "primary-session");

    fanout.dispatch(event("pane-3", "stale", "session-old"));
    fanout.dispatch(event("pane-3", "missing-session"));
    fanout.dispatch(event("pane-3", "current", "session-new"));
    fanout.dispatch(event(undefined, "legacy"));

    expect(paneBListener).toHaveBeenCalledTimes(1);
    expect(paneBListener).toHaveBeenCalledWith(event("pane-3", "current", "session-new"));
    expect(primaryListener).toHaveBeenCalledWith(event(undefined, "legacy"));
  });
});
