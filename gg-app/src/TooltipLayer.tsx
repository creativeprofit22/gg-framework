import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * App-wide tooltip for every `title=` attribute.
 *
 * Native `title` tooltips don't show in the macOS webview and look foreign in
 * WebView2, so the app's 125+ `title=` hints were hit-or-miss. Rather than
 * rewrite each call site, this one layer delegates from the document:
 *
 * - While an element is hovered or keyboard-focused, its `title` is moved aside
 *   (so no native tooltip doubles up) and put back when it's released. The text
 *   stays on the element as its accessible description (`aria-describedby`)
 *   or, for icon-only controls, its accessible name.
 * - Hover waits a beat after the pointer moves over a control before showing;
 *   moving straight from one tooltip to the next shows immediately ("warm").
 *   Keyboard focus shows immediately. A control that appears under a resting
 *   cursor stays quiet until the pointer actually moves.
 * - WCAG 1.4.13: dismiss with Escape, the pointer can move onto the tooltip
 *   without losing it, and it stays until the pointer or focus leaves.
 * - Clicking hides it, and it stays hidden until the pointer leaves that control.
 *
 * Positioning is measured, not assumed: the app zooms with CSS `zoom` on
 * <html>, and engines disagree about the coordinate space that puts
 * `getBoundingClientRect` in. So the layer probes how a CSS offset maps to
 * rect space and converts, which holds at any zoom in all three webviews.
 */

const SHOW_DELAY_MS = 450;
/** Moving to another titled control within this window skips the delay. */
const WARM_WINDOW_MS = 300;
const GAP = 6;
const MARGIN = 8;

interface Size {
  width: number;
  height: number;
}
export interface Box extends Size {
  left: number;
  top: number;
}
export interface Placement {
  left: number;
  top: number;
  side: "top" | "bottom";
}

/** Above the anchor when it fits, else below; always clamped inside the viewport. */
export function placeTooltip(anchor: Box, tip: Size, viewport: Size): Placement {
  const fitsAbove = anchor.top - GAP - tip.height >= MARGIN;
  const fitsBelow = anchor.top + anchor.height + GAP + tip.height <= viewport.height - MARGIN;
  const side = fitsAbove || !fitsBelow ? "top" : "bottom";
  const top = side === "top" ? anchor.top - GAP - tip.height : anchor.top + anchor.height + GAP;
  const centred = anchor.left + anchor.width / 2 - tip.width / 2;
  const maxLeft = Math.max(MARGIN, viewport.width - MARGIN - tip.width);
  return {
    left: Math.min(Math.max(centred, MARGIN), maxLeft),
    top: Math.max(MARGIN, top),
    side,
  };
}

interface Active {
  target: Element;
  text: string;
}

/** Everything the layer changed on the element, so release can undo exactly that. */
interface Claim {
  el: Element;
  title: string;
  addedLabel: boolean;
  addedDescribedBy: boolean;
  origin: "pointer" | "focus";
  observer: MutationObserver;
}

function hasOwnText(el: Element): boolean {
  return (el.textContent ?? "").trim() !== "";
}

export function TooltipLayer(): React.ReactElement | null {
  const [active, setActive] = useState<Active | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const tipId = useId();

  useEffect(() => {
    let claim: Claim | null = null;
    let pending: ReturnType<typeof setTimeout> | undefined;
    let shown = false;
    let lastHiddenAt = -Infinity;
    let keyboard = false;
    /** The control just clicked: no tooltip again until the pointer leaves it. */
    let suppressed: Element | null = null;

    const clearPending = (): void => {
      if (pending !== undefined) clearTimeout(pending);
      pending = undefined;
    };

    const release = (): void => {
      clearPending();
      if (!claim) return;
      const c = claim;
      claim = null;
      c.observer.disconnect();
      // If React re-set the title meanwhile, its value wins over the stash.
      if (!c.el.hasAttribute("title")) c.el.setAttribute("title", c.title);
      if (c.addedLabel) c.el.removeAttribute("aria-label");
      if (c.addedDescribedBy) c.el.removeAttribute("aria-describedby");
    };

    const hide = (): void => {
      release();
      if (shown) lastHiddenAt = Date.now();
      shown = false;
      setActive(null);
    };

    const show = (): void => {
      if (!claim) return;
      shown = true;
      setActive({ target: claim.el, text: claim.title });
    };

    const begin = (el: Element, origin: Claim["origin"]): void => {
      if (claim?.el === el) return;
      const title = el.getAttribute("title") ?? "";
      const warm = shown || Date.now() - lastHiddenAt < WARM_WINDOW_MS;
      hide();
      if (title.trim() === "") return;

      el.removeAttribute("title");
      const needsName =
        !el.hasAttribute("aria-label") && !el.hasAttribute("aria-labelledby") && !hasOwnText(el);
      if (needsName) el.setAttribute("aria-label", title);
      const addedDescribedBy = !needsName && !el.hasAttribute("aria-describedby");
      if (addedDescribedBy) el.setAttribute("aria-describedby", tipId);

      // React re-rendering a changed `title` puts the attribute back; adopt the
      // new text and take it aside again so the native tooltip never shows.
      const observer = new MutationObserver(() => {
        if (!claim || claim.el !== el) return;
        const next = el.getAttribute("title");
        if (next === null) return;
        claim.title = next;
        el.removeAttribute("title");
        if (shown) setActive({ target: el, text: next });
      });
      observer.observe(el, { attributes: true, attributeFilter: ["title"] });

      claim = { el, title, addedLabel: needsName, addedDescribedBy, origin, observer };
      if (origin === "focus" || warm) show();
      // A cold hover waits for real movement (onPointerMove starts the delay).
      // Browsers also fire pointerover when the page changes under a still
      // cursor, e.g. a new view mounting a button where the pointer happens to
      // rest, and a hint popping up unasked there reads as a glitch.
    };

    const onPointerMove = (e: PointerEvent): void => {
      if (e.pointerType === "touch") return;
      if (claim?.origin !== "pointer" || shown || pending !== undefined) return;
      pending = setTimeout(show, SHOW_DELAY_MS);
    };

    const onPointerOver = (e: PointerEvent): void => {
      if (e.pointerType === "touch") return;
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;
      if (claim?.el.contains(target)) return;
      // Hoverable: moving onto the tooltip itself keeps it open.
      if (tipRef.current?.contains(target)) return;
      if (suppressed?.contains(target)) return;
      suppressed = null;
      const el = target.closest("[title]");
      if (el) begin(el, "pointer");
      // Pointer drift over untitled space shouldn't cancel a keyboard tooltip.
      else if (claim?.origin !== "focus") hide();
    };

    const onPointerOut = (e: PointerEvent): void => {
      // Left the window entirely.
      if (e.relatedTarget === null && claim?.origin === "pointer") hide();
    };

    const onPointerDown = (): void => {
      keyboard = false;
      suppressed = claim?.el ?? null;
      hide();
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      keyboard = true;
      if (e.key !== "Escape" || !claim) return;
      // A keyboard tooltip eats its Escape so dismissing it doesn't also close
      // the surrounding modal. A hover tooltip lets it through: Escape there
      // is usually aimed at the app (cancel a run), not the hint.
      if (claim.origin === "focus" && shown) e.stopPropagation();
      hide();
    };

    const onFocusIn = (e: FocusEvent): void => {
      if (!keyboard || !(e.target instanceof Element)) return;
      const el = e.target.closest("[title]") ?? (claim?.el.contains(e.target) ? claim.el : null);
      if (el) begin(el, "focus");
      else if (claim?.origin === "focus") hide();
    };

    const onFocusOut = (e: FocusEvent): void => {
      if (claim?.origin !== "focus") return;
      const next = e.relatedTarget;
      if (next instanceof Node && claim.el.contains(next)) return;
      hide();
    };

    // The anchor can vanish under the tooltip (a row re-renders, a menu closes).
    const onDomChange = (): void => {
      if (claim && !claim.el.isConnected) hide();
    };
    const tree = new MutationObserver(onDomChange);
    tree.observe(document.body, { childList: true, subtree: true });

    document.addEventListener("pointerover", onPointerOver);
    document.addEventListener("pointermove", onPointerMove, { passive: true });
    document.addEventListener("pointerout", onPointerOut);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      tree.disconnect();
      document.removeEventListener("pointerover", onPointerOver);
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerout", onPointerOut);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
      release();
    };
  }, [tipId]);

  useLayoutEffect(() => {
    const tip = tipRef.current;
    if (!active || !tip) return;
    const s = tip.style;
    const at = (left: string, top: string, right: string, bottom: string): DOMRect => {
      s.left = left;
      s.top = top;
      s.right = right;
      s.bottom = bottom;
      return tip.getBoundingClientRect();
    };
    // Where CSS (0,0) lands, how 100 CSS px maps to rect space, and where the
    // viewport's far edges are: all in the same space as the anchor's rect.
    const origin = at("0px", "0px", "auto", "auto");
    const probe = at("100px", "100px", "auto", "auto");
    const corner = at("auto", "auto", "0px", "0px");
    const scaleX = (probe.left - origin.left) / 100 || 1;
    const scaleY = (probe.top - origin.top) / 100 || 1;
    const place = placeTooltip(
      active.target.getBoundingClientRect(),
      { width: corner.width, height: corner.height },
      { width: corner.right - origin.left, height: corner.bottom - origin.top },
    );
    at(
      `${(place.left - origin.left) / scaleX}px`,
      `${(place.top - origin.top) / scaleY}px`,
      "auto",
      "auto",
    );
    // Set before first paint so the entrance moves away from the anchor.
    tip.dataset.side = place.side;
  }, [active]);

  if (!active) return null;
  return createPortal(
    <div ref={tipRef} id={tipId} className="gg-tooltip" role="tooltip">
      {active.text}
    </div>,
    document.body,
  );
}
