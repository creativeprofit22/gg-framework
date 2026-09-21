// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePaneSwapViewState, type PaneSwapViewState } from "./usePaneSwapViewState";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function fixture(pinned = false) {
  const { container } = render(<><div data-testid="scroll"><p data-swap-row="1">A long paragraph for reading</p></div><textarea defaultValue="unfinished draft" /></>);
  const scroll = container.querySelector("div")!;
  const input = container.querySelector("textarea")!;
  Object.defineProperties(scroll, { scrollHeight: { value: 1000, configurable: true }, clientHeight: { value: 200 } });
  scroll.scrollTop = 100;
  const pin = { current: pinned };
  let state: PaneSwapViewState | null = null;
  const register = (_id: string, next: PaneSwapViewState | null) => { state = next; };
  const refs = { scrollRef: { current: scroll }, inputRef: { current: input } };
  const hook = renderHook(() => usePaneSwapViewState({ paneId: "a", ...refs, stickToBottomRef: pin, register }));
  return { scroll, input, pin, hook, capture: () => state!.capture(), getState: () => state };
}
describe("pane-local swap view state", () => {
  it("retains drafts, caret and bottom-pin streaming intent without focusing", () => {
    const f = fixture(true); f.input.setSelectionRange(2, 7, "backward");
    const restore = f.capture();
    Object.defineProperty(f.scroll, "scrollHeight", { value: 1200 });
    act(restore);
    expect(f.scroll.scrollTop).toBe(1000); expect(f.pin.current).toBe(true);
    expect(f.input.value).toBe("unfinished draft");
    expect([f.input.selectionStart, f.input.selectionEnd, f.input.selectionDirection]).toEqual([2, 7, "backward"]);
    expect(document.activeElement).not.toBe(f.input);
    expect(f.hook.result.current.ignoreRestoredScroll()).toBe(true);
  });
  it("uses a visible character anchor through reflow, retaining unpinned intent", () => {
    const f = fixture();
    let reflow = 0;
    vi.spyOn(f.scroll.querySelector("p")!, "getBoundingClientRect").mockReturnValue({ top: -30, bottom: 400, width: 200, height: 430 } as DOMRect);
    const descriptor = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
    Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: function(this: Range) {
      const top = this.startOffset * 10 - 30 + reflow;
      const bottom = this.endOffset * 10 - 30 + reflow;
      return { top, bottom, width: 8, height: bottom - top };
    } });
    try {
      const restore = f.capture(); reflow = 60; act(restore);
      expect(f.scroll.scrollTop).toBe(160); expect(f.pin.current).toBe(false);
    } finally {
      if (descriptor) Object.defineProperty(Range.prototype, "getBoundingClientRect", descriptor);
      else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
    }
  });
  it.each(["offscreen", "hidden"])("does not anchor a later %s row across a missing-anchor gap", (kind) => {
    const f = fixture();
    vi.spyOn(f.scroll, "getBoundingClientRect").mockReturnValue({ top: 0, bottom: 200 } as DOMRect);
    const row = f.scroll.querySelector("p")!;
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue({ top: 300, bottom: 500, width: 200, height: 200 } as DOMRect);
    if (kind === "hidden") {
      row.style.visibility = "hidden";
      vi.mocked(row.getBoundingClientRect).mockReturnValue({ top: 10, bottom: 100, width: 200, height: 90 } as DOMRect);
    }
    const descriptor = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
    let top = 300;
    Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => ({ top, bottom: top + 20, width: 100, height: 20 }) });
    try {
      const restore = f.capture(); top += 120; act(restore);
      expect(f.scroll.scrollTop).toBe(100);
    } finally {
      if (descriptor) Object.defineProperty(Range.prototype, "getBoundingClientRect", descriptor);
      else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
    }
  });
  it("falls back to a clamped offset and ignores superseded or user-cancelled restores", () => {
    const f = fixture();
    f.scroll.querySelector("p")!.remove();
    const stale = f.capture(); const current = f.capture();
    f.scroll.scrollTop = 250; act(stale); expect(f.scroll.scrollTop).toBe(250);
    act(current); expect(f.scroll.scrollTop).toBe(100);
    const cancelled = f.capture(); fireEvent.wheel(f.scroll); f.scroll.scrollTop = 300;
    act(cancelled); expect(f.scroll.scrollTop).toBe(300);
    f.hook.unmount(); expect(f.getState()).toBeNull();
  });
});
