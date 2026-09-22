import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import { appearance } from "./appearance";

export interface PaneSwapViewState {
  capture: () => () => void;
}
export type RegisterPaneSwapViewState = (paneId: string, state: PaneSwapViewState | null) => void;
interface Options {
  paneId: string;
  scrollRef: RefObject<HTMLDivElement | null>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  stickToBottomRef: RefObject<boolean>;
  register?: RegisterPaneSwapViewState;
}

/** The attribute is an eligibility marker; the keyed DOM node owns identity.
 * Walk only intersecting rows at swap time, never on streaming updates. */
function readingAnchor(
  container: HTMLElement,
): { range: Range | null; node: Node; offset: number } | null {
  const viewport = container.getBoundingClientRect();
  const top = viewport.top + container.clientTop;
  const bottom = top + container.clientHeight;
  const intersects = (rect: DOMRect) =>
    rect.width > 0 && rect.height > 0 && rect.bottom > top && rect.top < bottom;
  for (const row of container.querySelectorAll<HTMLElement>("[data-swap-row]")) {
    const rect = row.getBoundingClientRect();
    if (!intersects(rect) || getComputedStyle(row).visibility !== "visible") continue;
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const length = node.textContent?.length ?? 0;
      if (
        !length ||
        !node.parentElement ||
        getComputedStyle(node.parentElement).visibility !== "visible"
      )
        continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      if (!intersects(range.getBoundingClientRect())) continue;
      let low = 0;
      let high = length - 1;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        range.setStart(node, mid);
        range.setEnd(node, mid + 1);
        if (range.getBoundingClientRect().bottom <= top) low = mid + 1;
        else high = mid;
      }
      range.setStart(node, low);
      range.setEnd(node, low + 1);
      const character = range.getBoundingClientRect();
      if (intersects(character)) return { range, node, offset: character.top - viewport.top };
    }
    // Image-only rows have no text range. Use the same element box on restore,
    // rather than a contents Range whose geometry differs from its host.
    if (row.querySelector("img"))
      return { range: null, node: row, offset: rect.top - viewport.top };
  }
  return null;
}

export function usePaneSwapViewState({
  paneId,
  scrollRef,
  inputRef,
  stickToBottomRef,
  register,
}: Options) {
  const generation = useRef(0);
  const restoredScroll = useRef<number | null>(null);
  const ignoreRestoredScroll = useCallback(() => {
    const expected = restoredScroll.current;
    restoredScroll.current = null;
    return expected !== null && Math.abs((scrollRef.current?.scrollTop ?? -1) - expected) < 1;
  }, [scrollRef]);
  useLayoutEffect(() => {
    const cancel = () => {
      generation.current++;
      restoredScroll.current = null;
    };
    const scroller = scrollRef.current;
    scroller?.addEventListener("wheel", cancel, { passive: true });
    scroller?.addEventListener("pointerdown", cancel);
    const capture = () => {
      const current = ++generation.current;
      const el = scrollRef.current;
      const input = inputRef.current;
      const pinned = stickToBottomRef.current;
      const scrollTop = el?.scrollTop ?? 0;
      const anchor = el && !pinned ? readingAnchor(el) : null;
      const selection = input
        ? {
            value: input.value,
            start: input.selectionStart,
            end: input.selectionEnd,
            direction: input.selectionDirection,
          }
        : null;
      // DOM ranges and textarea selection survive host movement; never move focus here.
      return () => {
        if (generation.current !== current || !el?.isConnected || scrollRef.current !== el) return;
        let target = scrollTop;
        if (pinned) target = el.scrollHeight - el.clientHeight;
        else if (anchor?.node.isConnected && el.contains(anchor.node)) {
          const rect =
            anchor.range?.getBoundingClientRect() ??
            (anchor.node as Element).getBoundingClientRect();
          if (
            rect.width > 0 &&
            rect.height > 0 &&
            (!anchor.range ||
              (!anchor.range.collapsed && anchor.range.startContainer === anchor.node)) &&
            getComputedStyle(
              anchor.node instanceof Element ? anchor.node : anchor.node.parentElement!,
            ).visibility === "visible"
          ) {
            target = el.scrollTop + rect.top - el.getBoundingClientRect().top - anchor.offset;
          }
        }
        el.scrollTop = Math.max(0, Math.min(target, el.scrollHeight - el.clientHeight));
        restoredScroll.current = el.scrollTop;
        stickToBottomRef.current = pinned;
        if (
          input?.isConnected &&
          selection &&
          input.value === selection.value &&
          input.selectionStart === selection.start &&
          input.selectionEnd === selection.end
        ) {
          input.setSelectionRange(selection.start, selection.end, selection.direction);
        }
      };
    };
    register?.(paneId, { capture });
    const stopAppearanceCapture = appearance.beforeApply(capture);
    return () => {
      stopAppearanceCapture();
      cancel();
      register?.(paneId, null);
      scroller?.removeEventListener("wheel", cancel);
      scroller?.removeEventListener("pointerdown", cancel);
    };
  }, [paneId, scrollRef, inputRef, stickToBottomRef, register]);
  return { ignoreRestoredScroll };
}
