import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import { prefersReducedMotion } from "./transcript-motion";

/** Equal to `--dur-row` / `--ease-out` in App.css; scripts/motion-tokens.test.mjs enforces it. */
const DURATION_MS = 220;
const EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

// Computed height is in local CSS pixels, including a running WAAPI height,
// unlike viewport DOMRects under CSS zoom. It also respects box-sizing.
function height(el: HTMLElement): number {
  const value = parseFloat(getComputedStyle(el).height);
  return Number.isFinite(value) ? value : el.offsetHeight;
}

/** Capture before changing content. Owns one reversible animation; no held
 * frames or inline styles survive completion, deactivation or unmount.
 * A content commit during motion retargets from the currently visible height. */
export function useAnimatedHeight(
  ref: RefObject<HTMLElement | null>,
  trigger: unknown,
  content?: unknown,
): () => void {
  const captured = useRef<number | null>(null);
  const active = useRef<Animation | null>(null);
  const natural = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Completion events can arrive after a React commit. A finished animation
    // no longer covers the new intrinsic layout, so use its saved destination.
    const moving =
      active.current &&
      active.current.playState !== "finished" &&
      active.current.playState !== "idle";
    const prev = captured.current ?? (moving ? height(el) : natural.current);
    captured.current = null;
    const old = active.current;
    active.current = null;
    old?.cancel();
    const next = height(el);
    natural.current = next;
    if (
      prev === null ||
      prefersReducedMotion() ||
      typeof el.animate !== "function" ||
      prev === next
    )
      return;
    const animation = el.animate(
      [
        { height: `${prev}px`, overflow: "hidden" },
        { height: `${next}px`, overflow: "hidden" },
      ],
      { duration: DURATION_MS, easing: EASING },
    );
    active.current = animation;
    const release = () => {
      if (active.current === animation) active.current = null;
    };
    animation.onfinish = release;
    animation.oncancel = release;
  }, [ref, trigger, content]);

  useLayoutEffect(
    () => () => {
      active.current?.cancel();
      active.current = null;
      captured.current = null;
      natural.current = null;
    },
    [],
  );

  return useCallback(() => {
    const el = ref.current;
    if (el) captured.current = height(el);
  }, [ref]);
}
