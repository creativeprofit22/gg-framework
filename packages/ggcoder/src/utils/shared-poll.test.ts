import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSharedPolls, startIntervalPoll, type Poller } from "./shared-poll.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** A poller whose publishes the test drives by hand. */
function manualPolls() {
  const started: { key: string; publish: (n: number) => void; poller: Poller }[] = [];
  const polls = createSharedPolls<number>((key, publish) => {
    const poller = { refresh: vi.fn(), stop: vi.fn() };
    started.push({ key, publish, poller });
    return poller;
  });
  return { polls, started };
}

describe("createSharedPolls", () => {
  it("runs one poller for windows on the same repo and fans each value out", () => {
    const { polls, started } = manualPolls();
    const a = vi.fn();
    const b = vi.fn();
    polls.subscribe("/repo", a);
    polls.subscribe("/repo", b);
    expect(started).toHaveLength(1);

    started[0]?.publish(3);
    expect(a).toHaveBeenCalledWith(3);
    expect(b).toHaveBeenCalledWith(3);
  });

  it("keeps different repos on separate pollers", () => {
    const { polls, started } = manualPolls();
    polls.subscribe("/one", vi.fn());
    polls.subscribe("/two", vi.fn());
    expect(started.map((s) => s.key)).toEqual(["/one", "/two"]);
  });

  it("hands a late subscriber the last value without waiting for the next poll", async () => {
    const { polls, started } = manualPolls();
    polls.subscribe("/repo", vi.fn());
    started[0]?.publish(7);
    const late = vi.fn();
    polls.subscribe("/repo", late);
    expect(late).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(late).toHaveBeenCalledWith(7);
  });

  it("stops the poller only when the last subscriber leaves", () => {
    const { polls, started } = manualPolls();
    const a = polls.subscribe("/repo", vi.fn());
    const b = polls.subscribe("/repo", vi.fn());
    a.unsubscribe();
    a.unsubscribe();
    expect(started[0]?.poller.stop).not.toHaveBeenCalled();
    b.unsubscribe();
    expect(started[0]?.poller.stop).toHaveBeenCalledTimes(1);
    expect(polls.size()).toBe(0);

    // Re-opening the repo starts a fresh poller; the stopped one can't publish into it.
    const c = vi.fn();
    polls.subscribe("/repo", c);
    expect(started).toHaveLength(2);
    started[0]?.publish(1);
    expect(c).not.toHaveBeenCalled();
  });

  it("stops calling a subscriber that left, and its refresh becomes a no-op", () => {
    const { polls, started } = manualPolls();
    const gone = vi.fn();
    const stay = polls.subscribe("/repo", vi.fn());
    const left = polls.subscribe("/repo", gone);
    left.unsubscribe();
    started[0]?.publish(2);
    expect(gone).not.toHaveBeenCalled();
    left.refresh();
    expect(started[0]?.poller.refresh).not.toHaveBeenCalled();
    stay.refresh();
    expect(started[0]?.poller.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("startIntervalPoll", () => {
  it("checks once per tick no matter how many windows share it", async () => {
    const fetch = vi.fn(async () => 4);
    const polls = createSharedPolls<number>((_key, publish) =>
      startIntervalPoll({ fetch, publish, firstDelayMs: 2000, intervalMs: 60_000 }),
    );
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) polls.subscribe("owner/repo", (n) => seen.push(n));

    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([4, 4, 4]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("folds a refresh into a check already in flight and keeps values on failure", async () => {
    let release: (n: number | null) => void = () => undefined;
    const fetch = vi.fn(
      () =>
        new Promise<number | null>((resolve) => {
          release = resolve;
        }),
    );
    const publish = vi.fn();
    const poller = startIntervalPoll({ fetch, publish, firstDelayMs: 10, intervalMs: 1000 });
    void poller.refresh();
    void poller.refresh();
    expect(fetch).toHaveBeenCalledTimes(1);
    release(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(publish).not.toHaveBeenCalled();
    poller.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
