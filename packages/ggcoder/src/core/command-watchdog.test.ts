import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCommandWatchdog, type CommandWatchdogFire } from "./command-watchdog.js";

describe("createCommandWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function arm(limits: {
    yieldMs: number | null;
    inactivityMs: number | null;
    hardMs: number | null;
    initialInactivityMs?: number;
  }): { fires: CommandWatchdogFire[]; watchdog: ReturnType<typeof createCommandWatchdog> } {
    const fires: CommandWatchdogFire[] = [];
    const watchdog = createCommandWatchdog({ ...limits, onFire: (fire) => fires.push(fire) });
    return { fires, watchdog };
  }

  it("fires the earliest layer exactly once", () => {
    const { fires } = arm({ yieldMs: 100, inactivityMs: 200, hardMs: 300 });
    vi.advanceTimersByTime(1_000);
    expect(fires).toEqual(["yield"]);
  });

  it("activity re-arms only the inactivity timer", () => {
    const { fires, watchdog } = arm({ yieldMs: null, inactivityMs: 100, hardMs: 250 });
    for (let i = 0; i < 4; i += 1) {
      vi.advanceTimersByTime(60);
      watchdog.noteActivity();
    }
    expect(fires).toEqual([]);
    vi.advanceTimersByTime(20);
    expect(fires).toEqual(["hardTimeout"]);
  });

  it("fires inactive after silence", () => {
    const { fires, watchdog } = arm({ yieldMs: null, inactivityMs: 100, hardMs: null });
    vi.advanceTimersByTime(90);
    watchdog.noteActivity();
    vi.advanceTimersByTime(90);
    expect(fires).toEqual([]);
    vi.advanceTimersByTime(10);
    expect(fires).toEqual(["inactive"]);
  });

  it("uses the initial inactivity budget first, then the full limit", () => {
    const { fires, watchdog } = arm({
      yieldMs: null,
      inactivityMs: 100,
      hardMs: null,
      initialInactivityMs: 30,
    });
    vi.advanceTimersByTime(29);
    watchdog.noteActivity();
    vi.advanceTimersByTime(99);
    expect(fires).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(fires).toEqual(["inactive"]);
  });

  it("null layers never fire", () => {
    const { fires } = arm({ yieldMs: null, inactivityMs: null, hardMs: null });
    vi.advanceTimersByTime(10_000_000);
    expect(fires).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("dispose prevents any later fire and clears timers", () => {
    const { fires, watchdog } = arm({ yieldMs: 100, inactivityMs: 100, hardMs: 100 });
    watchdog.dispose();
    watchdog.noteActivity();
    vi.advanceTimersByTime(1_000);
    expect(fires).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears remaining timers after firing", () => {
    const { fires } = arm({ yieldMs: 10, inactivityMs: 100, hardMs: 100 });
    vi.advanceTimersByTime(10);
    expect(fires).toEqual(["yield"]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
