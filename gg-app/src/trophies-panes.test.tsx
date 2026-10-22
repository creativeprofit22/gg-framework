// @vitest-environment jsdom
// Local Fork: trophies in split panes. Each pane reads trophies through its own
// client, only the earning pane celebrates, and the unlock card files into the
// earning pane's deck key rather than the first one in the document.
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

vi.mock("./trophy-sound", () => ({ playTrophyUnlock: () => () => {} }));

import type { SidecarEvent, Trophy, TrophySnapshot } from "./agent";
import { TrophyUnlock } from "./TrophyUnlock";
import { useTrophies } from "./useTrophies";

const trophy = (over: Partial<Trophy> = {}): Trophy => ({
  id: "slash",
  title: "Shortcut",
  tier: "bronze",
  category: "start",
  description: "What it is.",
  hint: "How to get it.",
  goal: 1,
  current: 1,
  unlockedAt: "2026-10-21T00:00:00.000Z",
  secret: false,
  ...over,
});

const snapshot = (over: Partial<TrophySnapshot> = {}): TrophySnapshot => ({
  trophies: [trophy()],
  categories: [{ id: "start", label: "Getting started" }],
  earned: 1,
  total: 1,
  unlocked: [],
  eventNonce: null,
  ...over,
});

function paneClient(initial: unknown) {
  const listeners = new Set<(e: SidecarEvent) => void>();
  return {
    getTrophies: vi.fn(async () => initial as TrophySnapshot),
    subscribe: vi.fn((fn: (e: SidecarEvent) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }),
    emit: (data: unknown) => {
      for (const fn of listeners) fn({ type: "trophies", data } as SidecarEvent);
    },
  };
}

afterEach(cleanup);

describe("useTrophies (pane-scoped)", () => {
  it("reads through the pane's own client and queues only frames this pane earned", async () => {
    const client = paneClient(snapshot());
    const { result } = renderHook(() => useTrophies(client));
    await waitFor(() => expect(result.current.snapshot?.earned).toBe(1));
    expect(client.getTrophies).toHaveBeenCalledTimes(1);

    act(() => client.emit(snapshot({ unlocked: ["slash"], eventNonce: "n1", origin: false })));
    expect(result.current.queue).toEqual([]);

    act(() => client.emit(snapshot({ unlocked: ["slash"], eventNonce: "n2", origin: true })));
    expect(result.current.queue.map((t) => t.id)).toEqual(["slash"]);
  });

  it("ignores malformed frames instead of rendering them", async () => {
    const client = paneClient({ nope: true });
    const { result } = renderHook(() => useTrophies(client));
    await waitFor(() => expect(client.getTrophies).toHaveBeenCalled());
    act(() => client.emit({ trophies: "bad", unlocked: [], eventNonce: "x", origin: true }));
    expect(result.current.snapshot).toBeNull();
    expect(result.current.queue).toEqual([]);
  });
});

describe("TrophyUnlock without the Web Animations API", () => {
  it("shows the card and files away instead of throwing", async () => {
    const original = Element.prototype.animate;
    // jsdom and some embedded views have no animate(); the unlock used to crash the pane.
    Reflect.deleteProperty(Element.prototype, "animate");
    try {
      const onDone = vi.fn();
      render(
        <TrophyUnlock
          trophy={trophy()}
          snapshot={snapshot()}
          onOpenTrophies={() => {}}
          onDone={onDone}
        />,
      );
      expect(screen.getByRole("status").textContent).toContain("Shortcut");
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    } finally {
      Element.prototype.animate = original;
    }
  });
});

describe("TrophyUnlock in split panes", () => {
  const original = Element.prototype.animate;
  beforeEach(() => {
    vi.useFakeTimers();
    Element.prototype.animate = vi.fn(
      () => ({ finished: Promise.resolve(), cancel: vi.fn() }) as unknown as Animation,
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    Element.prototype.animate = original;
  });

  it("files into the earning pane's trophies key, not the first in the window", async () => {
    const other = document.createElement("div");
    other.innerHTML = '<button data-trophy-key="" id="pane-1-key"></button>';
    const earning = document.createElement("div");
    earning.innerHTML = '<button data-trophy-key="" id="pane-2-key"></button>';
    document.body.append(other, earning);

    render(
      <TrophyUnlock
        trophy={trophy()}
        snapshot={snapshot()}
        onOpenTrophies={() => {}}
        onDone={() => {}}
        keyScope={() => earning}
      />,
    );
    // Let the charge and spin play out so the card goes live, then dismiss it.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(document.querySelector(".tu-wrap[data-flat]")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(document.getElementById("pane-2-key")?.hasAttribute("data-trophy-lit")).toBe(true);
    expect(document.getElementById("pane-1-key")?.hasAttribute("data-trophy-lit")).toBe(false);
    other.remove();
    earning.remove();
  });
});
