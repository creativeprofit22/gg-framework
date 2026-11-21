// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDeckEscape } from "./deck-escape";

function escape(target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("useDeckEscape", () => {
  // Regression: the handler sat on the deck, but focus is on <body> while a
  // panel is open (WebKit doesn't focus clicked buttons; the composer is inert).
  it("closes the open panel when Escape lands outside the deck", () => {
    const close = vi.fn();
    renderHook(() => useDeckEscape(true, close));

    const event = escape();

    expect(close).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("does nothing while no panel is open, leaving Escape to cancel a run", () => {
    const close = vi.fn();
    renderHook(() => useDeckEscape(false, close));

    const event = escape();

    expect(close).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("leaves the panel open when something inside already handled Escape", () => {
    const close = vi.fn();
    renderHook(() => useDeckEscape(true, close));
    const search = document.body.appendChild(document.createElement("input"));
    search.addEventListener("keydown", (e) => e.preventDefault());

    escape(search);

    expect(close).not.toHaveBeenCalled();
  });

  it("leaves the panel open when a menu inside it stopped Escape", () => {
    const close = vi.fn();
    renderHook(() => useDeckEscape(true, close));
    const onMenuKey = (e: KeyboardEvent): void => e.stopPropagation();
    document.addEventListener("keydown", onMenuKey);

    escape();
    document.removeEventListener("keydown", onMenuKey);

    expect(close).not.toHaveBeenCalled();
  });

  it("stops listening once the panel closes", () => {
    const close = vi.fn();
    const { rerender } = renderHook(({ open }) => useDeckEscape(open, close), {
      initialProps: { open: true },
    });
    rerender({ open: false });

    escape();

    expect(close).not.toHaveBeenCalled();
  });
});
