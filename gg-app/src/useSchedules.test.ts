// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TICK_MS, useSchedules } from "./useSchedules";
import type { ParsedSchedule } from "./scheduleCommand";

const MIN = 60_000;

function parsed(over: Partial<ParsedSchedule> = {}): ParsedSchedule {
  return { prompt: "check the railway logs", intervalMs: 15 * MIN, runCount: null, ...over };
}

/** Advance the fake clock inside act(), so the ticker's state lands. */
function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useSchedules", () => {
  it("does not fire before the first interval elapses", () => {
    const onFire = vi.fn();
    const { result } = renderHook(() => useSchedules({ queuedPrompts: [], onFire }));
    act(() => {
      result.current.addSchedule(parsed());
    });

    advance(15 * MIN - 1000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("fires at the interval", () => {
    const onFire = vi.fn();
    const { result } = renderHook(() => useSchedules({ queuedPrompts: [], onFire }));
    act(() => {
      result.current.addSchedule(parsed());
    });

    advance(15 * MIN);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire).toHaveBeenCalledWith("check the railway logs");
  });

  it("keeps firing on cadence when the count is null", () => {
    const onFire = vi.fn();
    const { result } = renderHook(() => useSchedules({ queuedPrompts: [], onFire }));
    act(() => {
      result.current.addSchedule(parsed());
    });

    advance(15 * MIN);
    expect(onFire).toHaveBeenCalledTimes(1);
    advance(15 * MIN);
    expect(onFire).toHaveBeenCalledTimes(2);
    advance(15 * MIN);
    expect(onFire).toHaveBeenCalledTimes(3);
    // Still listed: an open-ended schedule never retires itself.
    expect(result.current.schedules).toHaveLength(1);
  });

  it("counts completed runs", () => {
    const onFire = vi.fn();
    const { result } = renderHook(() => useSchedules({ queuedPrompts: [], onFire }));
    act(() => {
      result.current.addSchedule(parsed());
    });

    advance(15 * MIN);
    expect(result.current.schedules[0]?.runsCompleted).toBe(1);
    advance(15 * MIN);
    expect(result.current.schedules[0]?.runsCompleted).toBe(2);
  });

  it("stops at runCount and drops off the list", () => {
    const onFire = vi.fn();
    const { result } = renderHook(() => useSchedules({ queuedPrompts: [], onFire }));
    act(() => {
      result.current.addSchedule(parsed({ runCount: 3 }));
    });

    advance(15 * MIN);
    advance(15 * MIN);
    expect(onFire).toHaveBeenCalledTimes(2);
    expect(result.current.schedules).toHaveLength(1);

    advance(15 * MIN);
    expect(onFire).toHaveBeenCalledTimes(3);
    expect(result.current.schedules).toHaveLength(0);

    // Well past the next boundary: a retired schedule must not fire again.
    advance(60 * MIN);
    expect(onFire).toHaveBeenCalledTimes(3);
  });

  it("fires exactly once for a count of 1", () => {
    const onFire = vi.fn();
    const { result } = renderHook(() => useSchedules({ queuedPrompts: [], onFire }));
    act(() => {
      result.current.addSchedule(parsed({ runCount: 1 }));
    });

    advance(15 * MIN);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(result.current.schedules).toHaveLength(0);
  });

  describe("queueing rather than dropping", () => {
    it("still fires while the agent is working, so the send path can queue it", () => {
      // The prompt is not lost just because a run is in flight: submitText
      // queues it as steering for the next turn boundary.
      const onFire = vi.fn();
      const { result } = renderHook(() => useSchedules({ queuedPrompts: [], onFire }));
      act(() => {
        result.current.addSchedule(parsed());
      });

      advance(15 * MIN);
      expect(onFire).toHaveBeenCalledTimes(1);
      expect(result.current.schedules[0]?.runsCompleted).toBe(1);
    });

    it("does not queue a duplicate while its own copy is still pending", () => {
      const onFire = vi.fn();
      const { result, rerender } = renderHook(
        ({ queuedPrompts }) => useSchedules({ queuedPrompts, onFire }),
        { initialProps: { queuedPrompts: [] as string[] } },
      );
      act(() => {
        result.current.addSchedule(parsed({ prompt: "check logs" }));
      });

      advance(15 * MIN);
      expect(onFire).toHaveBeenCalledTimes(1);

      // The agent has not consumed it yet.
      rerender({ queuedPrompts: ["check logs"] });
      advance(15 * MIN);
      advance(15 * MIN);
      expect(onFire).toHaveBeenCalledTimes(1);
      // Nothing was sent, so the completed count must not move.
      expect(result.current.schedules[0]?.runsCompleted).toBe(1);
    });

    it("fires again once the agent consumes the queued copy", () => {
      const onFire = vi.fn();
      const { result, rerender } = renderHook(
        ({ queuedPrompts }) => useSchedules({ queuedPrompts, onFire }),
        { initialProps: { queuedPrompts: [] as string[] } },
      );
      act(() => {
        result.current.addSchedule(parsed({ prompt: "check logs" }));
      });

      advance(15 * MIN);
      rerender({ queuedPrompts: ["check logs"] });
      advance(15 * MIN);
      expect(onFire).toHaveBeenCalledTimes(1);

      // Queue drains: the schedule is free to send again at its next boundary.
      rerender({ queuedPrompts: [] });
      advance(15 * MIN);
      expect(onFire).toHaveBeenCalledTimes(2);
    });

    it("suppresses an immediate duplicate before the queue echo arrives", () => {
      // The queue depth arrives over SSE. Without an optimistic marker the very
      // next tick would read a stale empty queue and fire the same prompt again.
      const onFire = vi.fn();
      const { result } = renderHook(() => useSchedules({ queuedPrompts: [], onFire }));
      act(() => {
        result.current.addSchedule(parsed({ prompt: "check logs", intervalMs: 1 * MIN }));
      });

      advance(1 * MIN);
      expect(onFire).toHaveBeenCalledTimes(1);
      advance(2 * TICK_MS);
      expect(onFire).toHaveBeenCalledTimes(1);
    });

    it("recovers if a fired prompt never reaches the queue", () => {
      // Agent was idle so the prompt ran immediately and never queued. The
      // optimistic marker must expire or the schedule suppresses itself forever.
      const onFire = vi.fn();
      const { result } = renderHook(() => useSchedules({ queuedPrompts: [], onFire }));
      act(() => {
        result.current.addSchedule(parsed({ prompt: "check logs" }));
      });

      advance(15 * MIN);
      expect(onFire).toHaveBeenCalledTimes(1);
      advance(15 * MIN);
      expect(onFire).toHaveBeenCalledTimes(2);
    });

    it("lets two different schedules queue independently", () => {
      const onFire = vi.fn();
      const { result } = renderHook(() => useSchedules({ queuedPrompts: [], onFire }));
      act(() => {
        result.current.addSchedule(parsed({ prompt: "one", intervalMs: 15 * MIN }));
        result.current.addSchedule(parsed({ prompt: "two", intervalMs: 15 * MIN }));
      });

      // Dedupe is per-prompt so neither suppresses the other, but only one send
      // leaves per tick; the peer follows on the next one.
      advance(15 * MIN);
      advance(TICK_MS);
      expect(onFire.mock.calls.map((c) => c[0]).sort()).toEqual(["one", "two"]);
    });
  });

  describe("stopping", () => {
    it("cancels a schedule so it never fires again", () => {
      const onFire = vi.fn();
      const { result } = renderHook(() => useSchedules({ queuedPrompts: [], onFire }));
      let id = "";
      act(() => {
        id = result.current.addSchedule(parsed());
      });

      advance(15 * MIN);
      expect(onFire).toHaveBeenCalledTimes(1);

      act(() => {
        result.current.stopSchedule(id);
      });
      expect(result.current.schedules).toHaveLength(0);

      advance(60 * MIN);
      expect(onFire).toHaveBeenCalledTimes(1);
    });

    it("leaves other schedules running", () => {
      const onFire = vi.fn();
      const { result } = renderHook(() => useSchedules({ queuedPrompts: [], onFire }));
      let first = "";
      act(() => {
        first = result.current.addSchedule(parsed({ prompt: "one" }));
        result.current.addSchedule(parsed({ prompt: "two", intervalMs: 30 * MIN }));
      });
      expect(result.current.schedules).toHaveLength(2);

      act(() => {
        result.current.stopSchedule(first);
      });

      advance(30 * MIN);
      expect(onFire).toHaveBeenCalledTimes(1);
      expect(onFire).toHaveBeenCalledWith("two");
    });
  });

  describe("multiple schedules", () => {
    it("fires each on its own cadence", () => {
      const onFire = vi.fn();
      const { result } = renderHook(() => useSchedules({ queuedPrompts: [], onFire }));
      act(() => {
        result.current.addSchedule(parsed({ prompt: "fast", intervalMs: 15 * MIN }));
        result.current.addSchedule(parsed({ prompt: "slow", intervalMs: 60 * MIN }));
      });

      advance(15 * MIN);
      expect(onFire.mock.calls.map((c) => c[0])).toEqual(["fast"]);

      advance(45 * MIN);
      // Both come due at t=60m. `fast` claims that tick and `slow` holds its
      // past-due slot, going out on the following tick rather than losing it.
      advance(TICK_MS);
      const prompts = onFire.mock.calls.map((c) => c[0]);
      expect(prompts.filter((p) => p === "fast")).toHaveLength(4);
      expect(prompts.filter((p) => p === "slow")).toHaveLength(1);
    });
  });

  describe("concurrency", () => {
    it("sends at most one prompt per tick", () => {
      // The sidecar sets its `running` flag only after an await inside the
      // /prompt handler, so two sends issued in the same tick can both clear its
      // concurrency guard and call session.prompt() on the same session.
      const onFire = vi.fn();
      const { result } = renderHook(() => useSchedules({ queuedPrompts: [], onFire }));
      act(() => {
        result.current.addSchedule(parsed({ prompt: "one", intervalMs: 15 * MIN }));
        result.current.addSchedule(parsed({ prompt: "two", intervalMs: 15 * MIN }));
      });

      advance(15 * MIN);
      expect(onFire).toHaveBeenCalledTimes(1);
      expect(onFire).toHaveBeenCalledWith("one");
    });

    it("gives the held schedule the very next tick, not a whole interval later", () => {
      const onFire = vi.fn();
      const { result } = renderHook(() => useSchedules({ queuedPrompts: [], onFire }));
      act(() => {
        result.current.addSchedule(parsed({ prompt: "one", intervalMs: 15 * MIN }));
        result.current.addSchedule(parsed({ prompt: "two", intervalMs: 15 * MIN }));
      });

      advance(15 * MIN);
      advance(TICK_MS);
      expect(onFire).toHaveBeenCalledTimes(2);
      expect(onFire).toHaveBeenLastCalledWith("two");
    });

    it("does not starve a schedule that always comes due beside another", () => {
      const onFire = vi.fn();
      const { result } = renderHook(() => useSchedules({ queuedPrompts: [], onFire }));
      act(() => {
        result.current.addSchedule(parsed({ prompt: "one", intervalMs: 15 * MIN }));
        result.current.addSchedule(parsed({ prompt: "two", intervalMs: 15 * MIN }));
      });

      for (let i = 0; i < 4; i += 1) {
        advance(15 * MIN);
        advance(TICK_MS);
      }
      const prompts = onFire.mock.calls.map((c) => c[0]);
      expect(prompts.filter((p) => p === "one").length).toBeGreaterThanOrEqual(4);
      expect(prompts.filter((p) => p === "two").length).toBeGreaterThanOrEqual(4);
    });
  });

  it("clears its ticker on unmount", () => {
    const onFire = vi.fn();
    const { result, unmount } = renderHook(() => useSchedules({ queuedPrompts: [], onFire }));
    act(() => {
      result.current.addSchedule(parsed());
    });

    unmount();
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(60 * MIN);
    expect(onFire).not.toHaveBeenCalled();
  });
});
