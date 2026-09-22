// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProgressSnapshot, SidecarEvent } from "./agent";
import { useProgress } from "./useProgress";

const initial: ProgressSnapshot = {
  level: 14,
  rankName: "Compiler",
  tier: 3,
  tierName: "Builder",
  tierGlyph: "*",
  effectId: "none",
  xp: 10000,
  xpIntoLevel: 0,
  xpForLevel: 1000,
  percent: 0,
  streak: { current: 1, best: 1 },
  totals: { prompts: 1, commits: 0, linesShipped: 0, projects: 1 },
  xpBySource: { prompts: 10000, commits: 0, streakBonus: 0 },
  memberSince: "2026-07-01T12:00:00Z",
  ladder: [],
  levelUp: null,
  eventNonce: "initial",
};
const live: ProgressSnapshot = {
  ...initial,
  level: 15,
  rankName: "Operator",
  xp: 11000,
  levelUp: { from: 14, to: 15, rankName: "Operator" },
  eventNonce: "live",
  origin: true,
};

function controlledClient() {
  let resolve!: (value: ProgressSnapshot) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<ProgressSnapshot>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  let listener!: (event: SidecarEvent) => void;
  const unsubscribe = vi.fn();
  return {
    getProgress: () => pending,
    subscribe: (callback: typeof listener) => {
      listener = callback;
      return unsubscribe;
    },
    emit: (data: unknown) => act(() => listener({ type: "progress", data } as SidecarEvent)),
    resolve: async (value = initial) => {
      await act(async () => resolve(value));
    },
    reject: async () => {
      await act(async () => reject(new Error("Unavailable")));
    },
    unsubscribe,
  };
}
afterEach(cleanup);

describe("initial progress request ordering", () => {
  it("initializes from GET before a live event without celebrating the initial nonce", async () => {
    const client = controlledClient();
    const { result } = renderHook(() => useProgress(client));
    await client.resolve({ ...initial, levelUp: { from: 13, to: 14, rankName: "Compiler" } });
    expect(result.current.snapshot?.level).toBe(14);
    expect(result.current.levelUpNonce).toBeNull();
    client.emit(result.current.snapshot);
    expect(result.current.levelUpNonce).toBeNull();
    client.emit(live);
    expect(result.current.snapshot).toEqual(live);
    expect(result.current.levelUpNonce).toBe("live");
    expect(result.current.levelUpOrigin).toBe(true);
  });

  it("keeps live level 15 when the held level 14 GET resolves, without consuming its nonce", async () => {
    const client = controlledClient();
    const { result } = renderHook(() => useProgress(client));
    client.emit(live);
    const celebration = result.current.levelUp;
    await client.resolve();
    expect(result.current.snapshot).toEqual(live);
    expect(result.current.levelUp).toBe(celebration);
    expect(result.current.levelUpNonce).toBe("live");
    client.emit({ ...live, levelUp: { ...live.levelUp! }, origin: false });
    expect(result.current.levelUp).toBe(celebration);
    expect(result.current.levelUpOrigin).toBe(true);
    // Nonces are opaque; an ignored response must not suppress a future event.
    client.emit({ ...live, eventNonce: "initial", origin: false });
    expect(result.current.levelUpNonce).toBe("initial");
    expect(result.current.levelUpOrigin).toBe(false);
    // Recovery can legitimately reduce XP. Only the late initial request is stale.
    client.emit(initial);
    expect(result.current.snapshot).toEqual(initial);
  });

  it("accepts a live event after the initial request rejects", async () => {
    const client = controlledClient();
    const { result } = renderHook(() => useProgress(client));
    await client.reject();
    expect(result.current.snapshot).toBeNull();
    client.emit(live);
    expect(result.current.snapshot).toEqual(live);
    expect(result.current.levelUpNonce).toBe("live");
  });

  it("does not let malformed live data block initial state", async () => {
    const client = controlledClient();
    const { result } = renderHook(() => useProgress(client));
    client.emit({ error: "unavailable" });
    await client.resolve();
    expect(result.current.snapshot).toEqual(initial);
  });

  it("resets ordering on client replacement and ignores the old request and events", async () => {
    const old = controlledClient();
    const current = controlledClient();
    const hook = renderHook(({ client }) => useProgress(client), { initialProps: { client: old } });
    old.emit(live);
    hook.rerender({ client: current });
    await current.resolve();
    expect(hook.result.current.snapshot).toEqual(initial);
    await old.resolve({ ...live, xp: 99999 });
    old.emit(live);
    expect(hook.result.current.snapshot).toEqual(initial);
    expect(old.unsubscribe).toHaveBeenCalledOnce();
  });

  it("clears old progress and celebration state when a replacement client fails", async () => {
    const old = controlledClient();
    const current = controlledClient();
    const hook = renderHook(({ client }) => useProgress(client), { initialProps: { client: old } });
    old.emit(live);
    expect(hook.result.current.levelUpNonce).toBe("live");
    hook.rerender({ client: current });
    const empty = { snapshot: null, levelUp: null, levelUpNonce: null, levelUpOrigin: false };
    expect(hook.result.current).toEqual(empty);
    await current.reject();
    expect(hook.result.current).toEqual(empty);
    current.emit(live);
    expect(hook.result.current.snapshot).toEqual(live);
    expect(hook.result.current.levelUpNonce).toBe("live");
    expect(hook.result.current.levelUpOrigin).toBe(true);
  });

  it("ignores pending responses and events after disposal", async () => {
    const client = controlledClient();
    const hook = renderHook(() => useProgress(client));
    hook.unmount();
    await client.resolve();
    client.emit(live);
    expect(hook.result.current.snapshot).toBeNull();
    expect(hook.result.current.levelUpNonce).toBeNull();
    expect(client.unsubscribe).toHaveBeenCalledOnce();
  });
});
