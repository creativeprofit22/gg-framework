import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./sounds", () => ({ playSound: vi.fn() }));

import { dismissToast, pauseToast, resumeToast, subscribeToasts, toast, type Toast } from "./toast";

function current(): Toast[] {
  let snapshot: Toast[] = [];
  subscribeToasts((t) => {
    snapshot = t;
  })();
  return snapshot;
}

describe("toast bus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    for (const t of current()) dismissToast(t.id);
    vi.useRealTimers();
  });

  it("auto-dismisses info toasts after the default duration", () => {
    const id = toast("Saved", "success");
    vi.advanceTimersByTime(3999);
    expect(current().map((t) => t.id)).toContain(id);
    vi.advanceTimersByTime(1);
    expect(current().map((t) => t.id)).not.toContain(id);
  });

  it("keeps errors until dismissed unless a duration is given", () => {
    const sticky = toast("Install failed", "error");
    const timed = toast("Retry failed", "error", 1000);
    vi.advanceTimersByTime(60_000);
    const ids = current().map((t) => t.id);
    expect(ids).toContain(sticky);
    expect(ids).not.toContain(timed);
  });

  it("holds the countdown while paused and resumes with the time left", () => {
    const id = toast("Heads up", "warning");
    vi.advanceTimersByTime(3000);
    pauseToast(id);
    vi.advanceTimersByTime(10_000);
    expect(current().map((t) => t.id)).toContain(id);
    resumeToast(id);
    vi.advanceTimersByTime(999);
    expect(current().map((t) => t.id)).toContain(id);
    vi.advanceTimersByTime(1);
    expect(current().map((t) => t.id)).not.toContain(id);
  });
});
