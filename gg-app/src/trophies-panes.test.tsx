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
import { Activity } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sound = vi.hoisted(() => ({ play: vi.fn(() => () => {}) }));
vi.mock("./trophy-sound", () => ({ playTrophyUnlock: sound.play }));

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

// By design (AgentPane dock comment): while a Goal's Workers view is open the
// chat Activity is hidden, so a trophy earned then waits in the queue and plays
// on return to chat. Rendering the full AgentPane with a goal needs the ~400
// lines of mocks in AgentPane.test.tsx, so this mirrors the dock's wiring
// instead: the same `<Activity mode={goalWorldOpen ? "hidden" : "visible"}>`
// around `trophies.queue[0] && <TrophyUnlock … onDone={trophies.shift} />`.
describe("TrophyUnlock while the Goal Workers view is open", () => {
  function Dock({
    client,
    goalWorldOpen,
  }: {
    client: ReturnType<typeof paneClient>;
    goalWorldOpen: boolean;
  }) {
    const trophies = useTrophies(client);
    return (
      <>
        <span data-testid="queued">{trophies.queue.length}</span>
        <Activity mode={goalWorldOpen ? "hidden" : "visible"}>
          <div className="dock">
            {trophies.queue[0] && (
              <TrophyUnlock
                key={trophies.queue[0].id}
                trophy={trophies.queue[0]}
                snapshot={trophies.snapshot}
                onOpenTrophies={() => {}}
                onDone={trophies.shift}
              />
            )}
          </div>
        </Activity>
      </>
    );
  }

  /** The card is on screen: mounted and not inside a subtree Activity hid. */
  const visibleCard = (): Element | null => {
    const card = document.querySelector(".trophy-unlock");
    for (let el: Element | null = card; el; el = el.parentElement) {
      if (el instanceof HTMLElement && el.style.display === "none") return null;
    }
    return card;
  };

  const original = Element.prototype.animate;
  beforeEach(() => {
    sound.play.mockClear();
    Element.prototype.animate = vi.fn(
      () => ({ finished: Promise.resolve(), cancel: vi.fn() }) as unknown as Animation,
    );
  });
  afterEach(() => {
    Element.prototype.animate = original;
  });

  it("keeps the earned trophy queued and silent, then plays it on return to chat", async () => {
    const client = paneClient(snapshot());
    const view = render(<Dock client={client} goalWorldOpen />);
    await waitFor(() => expect(client.getTrophies).toHaveBeenCalled());

    act(() => client.emit(snapshot({ unlocked: ["slash"], eventNonce: "w1", origin: true })));
    expect(screen.getByTestId("queued").textContent).toBe("1");
    expect(visibleCard()).toBeNull();
    expect(sound.play).not.toHaveBeenCalled();

    view.rerender(<Dock client={client} goalWorldOpen={false} />);
    await waitFor(() => expect(visibleCard()).not.toBeNull());
    expect(screen.getByRole("status").textContent).toContain("Shortcut");
    expect(sound.play).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("queued").textContent).toBe("1");
  });
});
