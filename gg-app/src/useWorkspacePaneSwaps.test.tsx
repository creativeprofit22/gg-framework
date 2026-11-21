// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useCallback, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspacePaneSwaps, PANE_SWAP_HELP_ID } from "./useWorkspacePaneSwaps";
import { swapWorkspacePanes } from "./workspace-swaps";
import type { WorkspaceLayout } from "./workspace-layout";
import { PaneSwapButton } from "./PaneSwapButton";
const initial: WorkspaceLayout = {
  version: 9,
  panes: { a: null, b: null, c: null },
  focusedPaneId: "a",
  root: {
    type: "split",
    direction: "horizontal",
    ratio: 33,
    size: { type: "ratio", value: 33 },
    first: { type: "leaf", paneId: "a" },
    second: {
      type: "split",
      direction: "horizontal",
      ratio: 50,
      size: { type: "ratio", value: 50 },
      first: { type: "leaf", paneId: "b" },
      second: { type: "leaf", paneId: "c" },
    },
  },
};
const label = (id: string) => id;
function Harness({
  race,
  closing = new Set<string>(),
  capture,
}: {
  race?: "missing-button" | "missing-hosts" | "other-focus" | "modal" | "rejected";
  closing?: Set<string>;
  capture?: () => () => void;
} = {}) {
  const closingPaneIdsRef = useRef(closing);
  const [layout, setLayout] = useState(initial);
  const layoutRef = useRef(layout);
  const gridRef = useRef<HTMLDivElement>(null);
  const focusPane = useCallback((id: string) => {
    layoutRef.current = { ...layoutRef.current, focusedPaneId: id };
    setLayout(layoutRef.current);
  }, []);
  const commit = useCallback(
    (a: string, b: string, size: { width: number; height: number }) => {
      if (race === "rejected") return null;
      const next = swapWorkspacePanes(layoutRef.current, a, b, size);
      if (next === layoutRef.current) return null;
      layoutRef.current = next;
      setLayout(next);
      if (race === "other-focus")
        document.querySelector<HTMLButtonElement>("[data-outside]")?.focus();
      return next;
    },
    [race],
  );
  const swaps = useWorkspacePaneSwaps({
    layout,
    layoutRef,
    gridRef,
    closingPaneIdsRef,
    focusPane,
    commit,
    label,
  });
  if (capture) for (const id of Object.keys(layout.panes)) swaps.registerViewState(id, { capture });
  const committed = layout.root !== initial.root;
  return (
    <>
      <button data-outside>outside</button>
      {committed && race === "modal" && (
        <div role="dialog" aria-label="Independent dialog">
          <input aria-label="Modal input" autoFocus />
        </div>
      )}
      <div ref={gridRef} tabIndex={-1} aria-label="Workspace" data-focused={layout.focusedPaneId}>
        {Object.keys(layout.panes).map((id) => {
          if (committed && race === "missing-hosts" && id !== "c") return null;
          const row = swaps.rows.get(id);
          return (
            <section
              key={id}
              data-pane-id={id}
              tabIndex={-1}
              ref={(el) => swaps.registerHost(id, el)}
            >
              <input aria-label={id} />
              {row?.available &&
                row.middleId !== id &&
                !(committed && race === "missing-button" && id === "b") && (
                  <PaneSwapButton
                    paneId={id}
                    label={id}
                    helpId={PANE_SWAP_HELP_ID}
                    buttonRef={(el) => swaps.registerButton(id, el)}
                    onSwap={swaps.swap}
                  />
                )}
            </section>
          );
        })}
      </div>
      <div role="status">{swaps.announcement}</div>
    </>
  );
}
let animate: ReturnType<typeof vi.fn>;
let effects: { cancel: ReturnType<typeof vi.fn>; onfinish: null | (() => void) }[];
let preference: EventTarget & { matches: boolean };
beforeEach(() => {
  effects = [];
  animate = vi.fn(() => {
    const effect = { cancel: vi.fn(), onfinish: null };
    effects.push(effect);
    return effect;
  });
  vi.stubGlobal("matchMedia", () => preference);
  preference = Object.assign(new EventTarget(), { matches: false });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 1500,
    height: 800,
    left: 0,
    top: 0,
  } as DOMRect);
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "animate");
});
describe("swap coordinator", () => {
  it.each(["a", "b"])(
    "rejects a stale action when %s starts closing without capturing views or cancelling motion",
    (id) => {
      const closing = new Set<string>();
      const capture = vi.fn(() => vi.fn());
      render(<Harness closing={closing} capture={capture} />);
      fireEvent.click(screen.getByRole("button", { name: "Swap with middle: a" }));
      capture.mockClear();
      closing.add(id); // Live ref changes before rendered controls catch up.
      fireEvent.click(screen.getByRole("button", { name: "Swap with middle: b" }));
      expect(screen.getByRole("status").textContent).toBe(
        "Swap unavailable while a pane is closing.",
      );
      expect(capture).not.toHaveBeenCalled();
      expect(animate).toHaveBeenCalledTimes(2);
      expect(effects.every((effect) => effect.cancel.mock.calls.length === 0)).toBe(true);
      expect(screen.getByRole("button", { name: "Swap with middle: b" })).toBeTruthy();
    },
  );
  it("explains an authoritative commit refusal without consuming the shortcut", () => {
    render(<Harness race="rejected" />);
    const input = screen.getByRole("textbox", { name: "a" });
    act(() => input.focus());
    expect(
      fireEvent.keyDown(input, { key: "ArrowLeft", ctrlKey: true, altKey: true, shiftKey: true }),
    ).toBe(true);
    expect(screen.getByRole("status").textContent).toBe(
      "Swap unavailable. Try again when the panes are ready.",
    );
    expect(animate).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
  });
  it("animates only two hosts for 160 ms, cancels interrupted work, never focuses on completion", () => {
    render(<Harness />);
    const first = screen.getByRole("button", { name: "Swap with middle: a" });
    act(() => first.focus());
    fireEvent.click(first);
    expect(animate).toHaveBeenCalledTimes(2);
    expect(animate.mock.calls[0][1]).toEqual({
      duration: 160,
      easing: "cubic-bezier(0, 0, 0.58, 1)",
    });
    const destination = screen.getByRole("button", { name: "Swap with middle: b" });
    expect(document.activeElement).toBe(destination);
    const oldCompletion = effects[0].onfinish!;
    fireEvent.click(destination);
    expect(effects[0].cancel).toHaveBeenCalled();
    expect(animate).toHaveBeenCalledTimes(4);
    const outside = screen.getByRole("button", { name: "outside" });
    act(() => outside.focus());
    act(() => {
      oldCompletion();
      effects[2].onfinish!();
    });
    expect(document.activeElement).toBe(outside);
  });
  it("snaps for reduced motion and cancels effects when the preference changes", () => {
    render(<Harness />);
    preference.matches = true;
    fireEvent.click(screen.getByRole("button", { name: "Swap with middle: a" }));
    expect(animate).not.toHaveBeenCalled();
    preference.matches = false;
    fireEvent.click(screen.getByRole("button", { name: "Swap with middle: b" }));
    expect(animate).toHaveBeenCalledTimes(2);
    act(() => {
      preference.matches = true;
      preference.dispatchEvent(new Event("change"));
    });
    expect(effects.every((e) => e.cancel.mock.calls.length === 1)).toBe(true);
  });
  it.each(["missing-button", "missing-hosts"] as const)(
    "uses a nonsequential fallback for %s",
    (race) => {
      render(<Harness race={race} />);
      const first = screen.getByRole("button", { name: "Swap with middle: a" });
      act(() => first.focus());
      fireEvent.click(first);
      const expected =
        race === "missing-button"
          ? document.querySelector('[data-pane-id="a"]')
          : screen.getByLabelText("Workspace");
      expect(document.activeElement).toBe(expected);
      expect(expected?.getAttribute("tabindex")).toBe("-1");
      expect(screen.getByLabelText("Workspace").getAttribute("data-focused")).toBe("a");
    },
  );
  it.each(["other-focus", "modal"] as const)(
    "does not override %s acquired during the transaction",
    (race) => {
      render(<Harness race={race} />);
      const first = screen.getByRole("button", { name: "Swap with middle: a" });
      act(() => first.focus());
      fireEvent.click(first);
      expect(document.activeElement).toBe(
        race === "modal"
          ? screen.getByRole("textbox", { name: "Modal input" })
          : screen.getByRole("button", { name: "outside" }),
      );
    },
  );
  it("hands off shortcut focus when its initiating swap button disappears", () => {
    render(<Harness />);
    const first = screen.getByRole("button", { name: "Swap with middle: a" });
    act(() => first.focus());
    fireEvent.keyDown(first, { key: "ArrowLeft", ctrlKey: true, altKey: true, shiftKey: true });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Swap with middle: b" }),
    );
  });
  it("keeps keyboard feedback across handoff, clearing it on independent focus or pointer input", () => {
    render(<Harness />);
    const first = screen.getByRole("button", { name: "Swap with middle: a" });
    act(() => first.focus());
    fireEvent.click(first, { detail: 0 });
    const destination = screen.getByRole("button", { name: "Swap with middle: b" });
    expect(destination.hasAttribute("data-swap-keyboard-focus")).toBe(true);
    act(() => screen.getByRole("button", { name: "outside" }).focus());
    expect(destination.hasAttribute("data-swap-keyboard-focus")).toBe(false);
    act(() => destination.focus());
    fireEvent.click(destination, { detail: 0 });
    const returned = screen.getByRole("button", { name: "Swap with middle: a" });
    expect(returned.hasAttribute("data-swap-keyboard-focus")).toBe(true);
    fireEvent.pointerDown(returned);
    expect(returned.hasAttribute("data-swap-keyboard-focus")).toBe(false);
    fireEvent.click(returned, { detail: 1 });
    expect(
      screen
        .getByRole("button", { name: "Swap with middle: b" })
        .hasAttribute("data-swap-keyboard-focus"),
    ).toBe(false);
  });
  it("cancels visual work on resize, hidden windows and unmount", () => {
    const result = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Swap with middle: a" }));
    fireEvent(window, new Event("resize"));
    expect(effects[0].cancel).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Swap with middle: b" }));
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    expect(effects[2].cancel).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
    result.unmount();
    expect(effects.every((effect) => effect.onfinish === null)).toBe(true);
  });
  it("excludes outside focus, open menus, AltGraph and already handled events", () => {
    render(<Harness />);
    const chord = () =>
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "ArrowLeft",
        ctrlKey: true,
        altKey: true,
        shiftKey: true,
      });
    const outside = screen.getByRole("button", { name: "outside" });
    act(() => outside.focus());
    fireEvent(outside, chord());
    const input = screen.getByRole("textbox", { name: "a" });
    act(() => input.focus());
    const handled = chord();
    handled.preventDefault();
    fireEvent(input, handled);
    const altGraph = chord();
    Object.defineProperty(altGraph, "getModifierState", { value: () => true });
    fireEvent(input, altGraph);
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.append(menu);
    fireEvent(input, chord());
    menu.removeAttribute("role");
    menu.className = "slash-menu";
    fireEvent(input, chord());
    menu.remove();
    expect(animate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Swap with middle: a" })).toBeTruthy();
  });
});
