import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * Escape closes the open deck panel, wherever focus is.
 *
 * A key handler on the deck itself only heard Escape while focus was inside
 * it, and it almost never is: WebKit doesn't focus a button on click, and the
 * composer goes inert while a panel is open, so the keystroke lands on <body>
 * and the panel's "esc" hint did nothing.
 *
 * Listens on `window` in the bubble phase, so it runs after everything nearer
 * the target. Anything that already handled this Escape (a dropdown or popover
 * inside the panel stops it; the model search, or a modal on top, marks it
 * handled) keeps the panel open. It never cancels a run: that lives only on
 * the composer's own Escape, and the composer is inert while a panel is open.
 */
export function useDeckEscape(open: boolean, close: () => void): void {
  const closeRef = useRef(close);
  useLayoutEffect(() => {
    closeRef.current = close;
  }, [close]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
}
