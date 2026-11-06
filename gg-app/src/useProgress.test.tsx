// @vitest-environment jsdom
import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getProgress,
  subscribe,
  type PaneAgentClient,
  type ProgressSnapshot,
  type SidecarEvent,
} from "./agent";
import { useProgress } from "./useProgress";
import { RankBadge } from "./RankBadge";
import { ScorecardModal } from "./ScorecardModal";

vi.mock("./agent", () => ({ getProgress: vi.fn(), subscribe: vi.fn() }));

const valid: ProgressSnapshot = {
  level: 1,
  rankName: "Tinkerer",
  tier: 1,
  tierName: "Starter",
  tierGlyph: "*",
  effectId: "none",
  xp: 10,
  xpIntoLevel: 10,
  xpForLevel: 303,
  percent: 3,
  streak: { current: 1, best: 1 },
  totals: { prompts: 1, commits: 0, linesShipped: 0, projects: 1 },
  xpBySource: { prompts: 10, commits: 0, streakBonus: 0 },
  memberSince: "2026-07-01T12:00:00Z",
  ladder: [],
  levelUp: null,
  eventNonce: null,
};
let listener: (event: SidecarEvent) => void;
function emit(data: unknown) {
  act(() => listener({ type: "progress", data } as SidecarEvent));
}
const client = { getProgress, subscribe };
function Workspace() {
  const { snapshot, levelUpNonce } = useProgress(client);
  const [open, setOpen] = useState(false);
  return (
    <main>
      <h1>Workspace</h1>
      <output>{levelUpNonce}</output>
      <RankBadge snapshot={snapshot} onClick={() => setOpen(true)} />
      {open && snapshot && <ScorecardModal snapshot={snapshot} onClose={() => setOpen(false)} />}
    </main>
  );
}

beforeEach(() => {
  vi.mocked(subscribe).mockImplementation((callback) => {
    listener = callback;
    return vi.fn();
  });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("pane-owned progress", () => {
  it("does not celebrate the initial nonce or accept a disposed client's fetch/events", async () => {
    let resolveInitial!: (snapshot: ProgressSnapshot) => void;
    let oldListener!: (event: SidecarEvent) => void;
    const unsubscribe = vi.fn();
    const oldClient = {
      getProgress: () =>
        new Promise<ProgressSnapshot>((resolve) => {
          resolveInitial = resolve;
        }),
      subscribe: (callback: (event: SidecarEvent) => void) => {
        oldListener = callback;
        return unsubscribe;
      },
    };
    let currentListener!: (event: SidecarEvent) => void;
    const initial = {
      ...valid,
      eventNonce: "initial",
      levelUp: { from: 1, to: 2, rankName: "Tinkerer" },
    };
    const currentClient = {
      getProgress: async () => initial,
      subscribe: (callback: (event: SidecarEvent) => void) => {
        currentListener = callback;
        return vi.fn();
      },
    };
    const hook = renderHook(({ client }) => useProgress(client), {
      initialProps: { client: oldClient },
    });
    hook.rerender({ client: currentClient });
    await waitFor(() => expect(hook.result.current.snapshot).toEqual(initial));
    act(() => currentListener({ type: "progress", data: initial }));
    expect(hook.result.current.levelUpNonce).toBeNull();
    await act(async () => {
      resolveInitial({ ...valid, xp: 999 });
      oldListener({ type: "progress", data: { ...valid, xp: 888 } });
    });
    expect(hook.result.current.snapshot).toEqual(initial);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it.each([false, true])("keeps origin and nonce effects local (reverse=%s)", async (reverse) => {
    const callbacks = new Map<string, (event: SidecarEvent) => void>();
    const clients = ["primary", "secondary"].map(
      (paneId) =>
        ({
          paneId,
          getProgress: vi.fn().mockResolvedValue(valid),
          subscribe: vi.fn((callback: (event: SidecarEvent) => void) => {
            callbacks.set(paneId, callback);
            return () => {
              callbacks.delete(paneId);
            };
          }),
        }) satisfies Pick<PaneAgentClient, "paneId" | "getProgress" | "subscribe">,
    );
    const hooks = clients.map((pane) => renderHook(() => useProgress(pane)));
    await waitFor(() =>
      hooks.forEach((hook) => expect(hook.result.current.snapshot).toEqual(valid)),
    );
    for (const owner of ["secondary", "primary"]) {
      const award = {
        ...valid,
        xp: owner === "secondary" ? 20 : 30,
        levelUp: { from: 1, to: 2, rankName: "Tinkerer" },
        eventNonce: owner,
      };
      const ordered = reverse ? [...clients].reverse() : clients;
      for (const pane of ordered) {
        act(() =>
          callbacks.get(pane.paneId)!({
            type: "progress",
            data: { ...award, origin: pane.paneId === owner },
          }),
        );
      }
      hooks.forEach((hook, index) => {
        expect(hook.result.current.snapshot?.xp).toBe(award.xp);
        expect(hook.result.current.snapshot?.origin).toBe(clients[index].paneId === owner);
        expect(hook.result.current.levelUpNonce).toBe(owner);
        expect(hook.result.current.levelUpOrigin).toBe(clients[index].paneId === owner);
      });
      const celebrations = hooks.map((hook) => hook.result.current.levelUp);
      act(() =>
        clients.forEach((pane) =>
          callbacks.get(pane.paneId)!({
            type: "progress",
            data: { ...award, origin: pane.paneId === owner },
          }),
        ),
      );
      hooks.forEach((hook, index) => expect(hook.result.current.levelUp).toBe(celebrations[index]));
    }
    hooks.forEach((hook) => hook.unmount());
    expect(callbacks.size).toBe(0);
    expect(getProgress).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });
});

describe("progress boundary and workspace recovery", () => {
  it.each([
    { error: "unauthorized" },
    { error: "forbidden" },
    { error: "internal error" },
    {},
    null,
    { ...valid, streak: undefined },
    { ...valid, totals: { prompts: 1 } },
    { ...valid, levelUp: { to: 2 } },
    { ...valid, ladder: [null] },
  ])("keeps malformed initial data hidden and recovers: %j", async (data) => {
    vi.mocked(getProgress).mockResolvedValue(data as ProgressSnapshot);
    render(<Workspace />);
    await act(async () => {});
    expect(screen.queryByRole("button")).toBeNull();
    fireEvent.click(screen.getByRole("heading", { name: "Workspace" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    emit(valid);
    fireEvent.click(screen.getByRole("button", { name: /Tinkerer/ }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Workspace" })).toBeTruthy();
  });

  it("preserves valid data through malformed frames, including while the scorecard is open", async () => {
    vi.mocked(getProgress).mockResolvedValue(valid);
    render(<Workspace />);
    fireEvent.click(await screen.findByRole("button", { name: /Tinkerer/ }));
    for (const data of [
      { error: "unauthorized" },
      { ...valid, streak: null },
      { ...valid, totals: {} },
      null,
    ])
      emit(data);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Workspace" })).toBeTruthy();
    expect(screen.getByTitle(/Level 1/)).toBeTruthy();
    emit({
      ...valid,
      level: 2,
      levelUp: { from: 1, to: 2, rankName: "Tinkerer" },
      eventNonce: "recovered",
      origin: true,
    });
    expect(screen.getByTitle(/Level 2/)).toBeTruthy();
    expect(screen.getByText("recovered")).toBeTruthy();
  });

  it.each([401, 403, 500])(
    "recovers from a rejected HTTP %i request without a zero-XP fallback",
    async (status) => {
      vi.mocked(getProgress).mockRejectedValue(
        new Error(`Progress request failed (HTTP ${status})`),
      );
      render(<Workspace />);
      await act(async () => {});
      expect(screen.queryByRole("button")).toBeNull();
      emit(valid);
      await waitFor(() =>
        expect(screen.getByTitle("Tinkerer — Level 1 · 10 lifetime XP")).toBeTruthy(),
      );
    },
  );
});
