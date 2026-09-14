// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { useSmoothText } from "./useSmoothText";

// The reveal runs on requestAnimationFrame and reads performance.now(); fake
// timers drive both, so a "frame" here is just advancing time.
const frames = async (ms: number): Promise<void> => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
};

describe("useSmoothText", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("commits the text present on first render immediately", () => {
    // Resumed history and finished replies must never re-animate.
    const { result } = renderHook(() => useSmoothText("already finished"));
    expect(result.current.text).toBe("already finished");
    expect(result.current.animating).toBe(false);
  });

  it("reveals growth gradually, then catches up fully", async () => {
    const { result, rerender } = renderHook(({ text }) => useSmoothText(text), {
      initialProps: { text: "" },
    });

    rerender({ text: "hello world, this is a streamed sentence" });
    // Long enough for a couple of frames past the 33ms commit throttle.
    await frames(80);
    expect(result.current.animating).toBe(true);
    // Part of the burst is on screen, but not all of it.
    expect(result.current.text.length).toBeGreaterThan(0);
    expect(result.current.text.length).toBeLessThan(39);
    expect("hello world, this is a streamed sentence".startsWith(result.current.text)).toBe(true);

    await frames(500);
    expect(result.current.text).toBe("hello world, this is a streamed sentence");
  });

  it("stops animating once the stream settles", async () => {
    const { result, rerender } = renderHook(({ text }) => useSmoothText(text), {
      initialProps: { text: "" },
    });
    rerender({ text: "done" });
    await frames(100);
    expect(result.current.animating).toBe(true);
    await frames(1000);
    expect(result.current.animating).toBe(false);
  });

  it("snaps when the text is replaced rather than extended", async () => {
    const { result, rerender } = renderHook(({ text }) => useSmoothText(text), {
      initialProps: { text: "" },
    });
    rerender({ text: "an unreviewed draft" });
    await frames(500);
    // A discarded draft replaced by the reviewed final answer: rewinding
    // character by character would look broken, so it lands whole.
    rerender({ text: "the reviewed answer" });
    await frames(16);
    expect(result.current.text).toBe("the reviewed answer");
  });
});
