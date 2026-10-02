import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

/** Matches --dur-row / --ease-out in App.css. */
const DURATION_MS = 220;
const EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

/**
 * Smoothly animate an element's height across a content swap (e.g. a "Show
 * full output" toggle that replaces a preview with the full content).
 *
 * CSS can't do this: the content itself changes, so there's no height to
 * transition between. Call the returned `capture()` right before the state
 * change; after React lays out the new content, the height animates from the
 * captured value to the new one via the Web Animations API. Measuring only on
 * capture (not every render) keeps streaming rows free of forced layouts, and
 * the animation isn't filled, so nothing lingers afterwards.
 */
export function useAnimatedHeight(
  ref: RefObject<HTMLElement | null>,
  trigger: unknown,
): () => void {
  const captured = useRef<number | null>(null);

  useLayoutEffect(() => {
    const prev = captured.current;
    captured.current = null;
    const el = ref.current;
    if (prev === null || !el || typeof el.animate !== "function") return;
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) return;
    const next = el.getBoundingClientRect().height;
    if (prev === next) return;
    el.animate(
      [
        { height: `${prev}px`, overflow: "hidden" },
        { height: `${next}px`, overflow: "hidden" },
      ],
      { duration: DURATION_MS, easing: EASING },
    );
  }, [ref, trigger]);

  return useCallback(() => {
    const el = ref.current;
    if (el) captured.current = el.getBoundingClientRect().height;
  }, [ref]);
}
