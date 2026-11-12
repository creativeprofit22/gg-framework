import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppSidecarSessionRouter } from "./app-sidecar-session-router.js";
import {
  createSessionReaper,
  isSessionReapable,
  type IdleSessionSnapshot,
  type ReapableSessionContext,
} from "./app-sidecar-session-reaper.js";

const MINUTE = 60_000;
const TIMEOUT = 30 * MINUTE;

interface FakeSession extends ReapableSessionContext {
  state: IdleSessionSnapshot;
  dispose: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

function fakeSession(overrides: Partial<IdleSessionSnapshot> = {}): FakeSession {
  const state: IdleSessionSnapshot = {
    listeners: 0,
    busy: false,
    waitingOnUser: false,
    holdsLease: false,
    lastActivityAt: Date.now(),
    lastRunSettledAt: null,
    ...overrides,
  };
  return { state, idleSnapshot: () => ({ ...state }), dispose: vi.fn(async () => {}) };
}

function setup(options: { timeoutMs?: () => number; gate?: () => (() => void) | null } = {}) {
  const router = new AppSidecarSessionRouter<FakeSession>();
  const reaped: string[] = [];
  const errors: unknown[] = [];
  const reaper = createSessionReaper({
    router,
    now: () => Date.now(),
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearInterval: (handle) => clearInterval(handle),
    readTimeoutMs: options.timeoutMs ?? (() => TIMEOUT),
    tryAcquireMutation: options.gate ?? (() => () => {}),
    onReaped: (sessionId) => reaped.push(sessionId),
    onError: (_sessionId, error) => errors.push(error),
  });
  return { router, reaper, reaped, errors };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-05T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("isSessionReapable", () => {
  const base = (): IdleSessionSnapshot => ({
    listeners: 0,
    busy: false,
    waitingOnUser: false,
    holdsLease: false,
    lastActivityAt: 0,
    lastRunSettledAt: null,
  });

  it("needs the full quiet timeout and an enabled timeout", () => {
    expect(isSessionReapable(base(), TIMEOUT, TIMEOUT, MINUTE)).toBe(true);
    expect(isSessionReapable(base(), TIMEOUT - 1, TIMEOUT, MINUTE)).toBe(false);
    expect(isSessionReapable(base(), TIMEOUT * 10, 0, MINUTE)).toBe(false);
  });

  it("keeps a session with a listener, work, a waiting question or a lease", () => {
    const later = TIMEOUT * 10;
    expect(isSessionReapable({ ...base(), listeners: 1 }, later, TIMEOUT, MINUTE)).toBe(false);
    expect(isSessionReapable({ ...base(), busy: true }, later, TIMEOUT, MINUTE)).toBe(false);
    expect(isSessionReapable({ ...base(), waitingOnUser: true }, later, TIMEOUT, MINUTE)).toBe(
      false,
    );
    expect(isSessionReapable({ ...base(), holdsLease: true }, later, TIMEOUT, MINUTE)).toBe(false);
  });

  it("applies the grace period after a run ends even with a short timeout", () => {
    const snapshot = { ...base(), lastRunSettledAt: 0 };
    expect(isSessionReapable(snapshot, 30_000, 1_000, MINUTE)).toBe(false);
    expect(isSessionReapable(snapshot, MINUTE, 1_000, MINUTE)).toBe(true);
  });
});

describe("createSessionReaper", () => {
  it("frees an abandoned session through the shared dispose path, and a later DELETE is quiet", async () => {
    const { router, reaper, reaped } = setup();
    const abandoned = fakeSession();
    router.add("abandoned", abandoned);
    reaper.start();

    await vi.advanceTimersByTimeAsync(TIMEOUT - MINUTE);
    expect(abandoned.dispose).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(reaped).toEqual(["abandoned"]);
    expect(abandoned.dispose).toHaveBeenCalledOnce();
    expect(router.get("abandoned")).toBeUndefined();

    await expect(router.deleteAndDispose("abandoned")).resolves.toBe(false);
    expect(abandoned.dispose).toHaveBeenCalledOnce();
    reaper.stop();
  });

  it("keeps an open but quiet pane with a listener for hours", async () => {
    const { router, reaper } = setup();
    const open = fakeSession({ listeners: 1 });
    router.add("open", open);
    reaper.start();

    await vi.advanceTimersByTimeAsync(6 * 60 * MINUTE);
    expect(open.dispose).not.toHaveBeenCalled();
    expect(router.get("open")).toBe(open);
    reaper.stop();
  });

  it("keeps a pane whose listener drops and comes back inside the window", async () => {
    const { router, reaper } = setup();
    const pane = fakeSession({ listeners: 1 });
    router.add("pane", pane);
    reaper.start();

    await vi.advanceTimersByTimeAsync(2 * 60 * MINUTE);
    // A disconnect (window reload, daemon hiccup) counts as activity and resets the quiet clock.
    pane.state.listeners = 0;
    pane.state.lastActivityAt = Date.now();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    pane.state.listeners = 1;
    pane.state.lastActivityAt = Date.now();
    await vi.advanceTimersByTimeAsync(2 * 60 * MINUTE);

    expect(pane.dispose).not.toHaveBeenCalled();
    reaper.stop();
  });

  it("keeps sessions with an active run, a pending question or plan review, or a lease", async () => {
    const { router, reaper } = setup();
    const running = fakeSession({ busy: true });
    const asking = fakeSession({ waitingOnUser: true });
    const leased = fakeSession({ holdsLease: true });
    router.add("running", running);
    router.add("asking", asking);
    router.add("leased", leased);
    reaper.start();

    await vi.advanceTimersByTimeAsync(3 * TIMEOUT);
    for (const session of [running, asking, leased]) {
      expect(session.dispose).not.toHaveBeenCalled();
    }
    reaper.stop();
  });

  it("waits out the grace period after a run ends with a short timeout", async () => {
    const { router, reaper, reaped } = setup({ timeoutMs: () => 1_000 });
    const session = fakeSession({ lastRunSettledAt: Date.now() });
    router.add("settled", session);

    vi.setSystemTime(Date.now() + 30_000);
    await expect(reaper.tick()).resolves.toEqual([]);

    vi.setSystemTime(Date.now() + 30_000);
    await expect(reaper.tick()).resolves.toEqual(["settled"]);
    expect(reaped).toEqual(["settled"]);
  });

  it("re-checks at the moment of closing", async () => {
    const { router, reaper } = setup();
    const first = fakeSession();
    const second = fakeSession();
    // While the first session is being freed, the second one wakes up.
    first.dispose.mockImplementation(async () => {
      second.state.listeners = 1;
    });
    router.add("a-first", first);
    router.add("b-second", second);

    vi.setSystemTime(Date.now() + TIMEOUT);
    await expect(reaper.tick()).resolves.toEqual(["a-first"]);
    expect(second.dispose).not.toHaveBeenCalled();
    expect(router.get("b-second")).toBe(second);
  });

  it("does nothing when the timeout is 0, and picks up a changed setting", async () => {
    let minutes = 0;
    const { router, reaper } = setup({ timeoutMs: () => minutes * MINUTE });
    const session = fakeSession();
    router.add("idle", session);
    reaper.start();

    await vi.advanceTimersByTimeAsync(5 * TIMEOUT);
    expect(session.dispose).not.toHaveBeenCalled();

    minutes = 30;
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(session.dispose).toHaveBeenCalledOnce();
    reaper.stop();
  });

  it("unrefs its timer and stop() clears it", () => {
    const handle = { unref: vi.fn() };
    const clear = vi.fn();
    const reaper = createSessionReaper({
      router: new AppSidecarSessionRouter<FakeSession>(),
      now: () => Date.now(),
      setInterval: () => handle,
      clearInterval: clear,
      readTimeoutMs: () => TIMEOUT,
      tryAcquireMutation: () => () => {},
    });
    reaper.start();
    reaper.start();
    expect(handle.unref).toHaveBeenCalledOnce();
    reaper.stop();
    expect(clear).toHaveBeenCalledWith(handle);
    reaper.stop();
    expect(clear).toHaveBeenCalledOnce();
  });

  it("skips the scan while the daemon is reloading and releases the gate after a scan", async () => {
    let reloading = true;
    const release = vi.fn();
    const { router, reaper } = setup({ gate: () => (reloading ? null : release) });
    const session = fakeSession();
    router.add("idle", session);
    vi.setSystemTime(Date.now() + TIMEOUT);

    await expect(reaper.tick()).resolves.toEqual([]);
    expect(session.dispose).not.toHaveBeenCalled();

    reloading = false;
    await expect(reaper.tick()).resolves.toEqual(["idle"]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not overlap ticks and reports a failed disposal", async () => {
    const { router, reaper, errors } = setup();
    let finish: () => void = () => {};
    const slow = fakeSession();
    slow.dispose.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const broken = fakeSession();
    broken.dispose.mockRejectedValue(new Error("dispose failed"));
    router.add("a-slow", slow);
    router.add("b-broken", broken);
    vi.setSystemTime(Date.now() + TIMEOUT);

    const firstTick = reaper.tick();
    const secondTick = reaper.tick();
    expect(secondTick).toBe(firstTick);
    await vi.advanceTimersByTimeAsync(0);
    finish();
    await expect(firstTick).resolves.toEqual(["a-slow", "b-broken"]);
    expect(slow.dispose).toHaveBeenCalledOnce();
    expect(errors).toHaveLength(1);
  });
});
