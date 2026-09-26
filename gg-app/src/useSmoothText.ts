import { useEffect, useRef, useState } from "react";

/**
 * Paces streamed text so the PAINT rhythm stops being the NETWORK rhythm.
 *
 * Deltas arrive in bursts (200 characters in one flush, then five), which is
 * what makes a naive stream read as a lurching typewriter. This reveals text
 * toward the incoming target on every animation frame instead, spending
 * `DRAIN_MS` on whatever backlog exists: a burst simply reveals slightly
 * faster until it has caught up. Same total duration, even cadence.
 *
 * Port of the approach in assistant-ui's `useSmooth` (MIT), trimmed to what
 * this app needs.
 */

/** Target time to drain the unrevealed backlog. Bigger = more lag, smoother. */
const DRAIN_MS = 250;
/** Slowest reveal rate — the floor that keeps a 3-character backlog moving. */
const MAX_CHAR_INTERVAL_MS = 5;
/**
 * Minimum gap between React commits. The reveal advances every frame, but
 * committing re-runs `marked.lexer` over the whole message, so committing at
 * 30fps rather than 60 halves that cost; the per-word fade-in covers the gap.
 */
const COMMIT_MS = 33;
/**
 * How long after the last delta a row still counts as animating. Covers the
 * reveal draining plus the last word's fade, after which the word-span
 * wrappers are dropped from the DOM.
 */
const SETTLE_MS = 700;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export interface SmoothText {
  /** The prefix revealed so far — render this, not the raw text. */
  text: string;
  /** True while text is still arriving/revealing: gates the word fade-in. */
  animating: boolean;
}

interface Reveal {
  /** What is on screen. */
  current: string;
  /** What has arrived and is still to be revealed. */
  target: string;
  raf: number;
  lastFrame: number;
  lastCommit: number;
  settle: number;
}

/** One frame of the reveal; re-arms itself until `current` catches `target`. */
function advance(a: Reveal, commit: (text: string) => void): void {
  const now = performance.now();
  let budget = now - a.lastFrame;
  const remaining = a.target.length - a.current.length;
  const perChar = Math.min(MAX_CHAR_INTERVAL_MS, DRAIN_MS / Math.max(remaining, 1));
  let add = 0;
  while (budget >= perChar && add < remaining) {
    add++;
    budget -= perChar;
  }
  a.raf = add === remaining ? 0 : requestAnimationFrame(() => advance(a, commit));
  if (add === 0) return;
  a.current = a.target.slice(0, a.current.length + add);
  a.lastFrame = now - budget;
  // The catch-up frame always commits, so the tail of a reply can never be
  // left unpainted by the commit throttle.
  if (add === remaining || now - a.lastCommit >= COMMIT_MS) {
    a.lastCommit = now;
    commit(a.current);
  }
}

/**
 * Returns the smoothly-revealed prefix of `text`.
 *
 * The text present on the FIRST render commits immediately — resumed history
 * and finished replies must never animate. Only later growth is paced, and
 * text that stops being an extension of what is on screen (a discarded draft,
 * a replaced message) snaps instead of rewinding.
 */
export function useSmoothText(text: string): SmoothText {
  const [revealed, setRevealed] = useState(text);
  const [animating, setAnimating] = useState(false);
  const anim = useRef<Reveal>({
    current: text,
    target: text,
    raf: 0,
    lastFrame: 0,
    lastCommit: 0,
    settle: 0,
  });

  useEffect(() => {
    const a = anim.current;
    if (a.target === text) return;
    // Not an extension of what is on screen (draft discarded, message
    // replaced) — or motion is unwanted. Snap; rewinding would look broken.
    if (prefersReducedMotion() || !text.startsWith(a.current)) {
      if (a.raf) cancelAnimationFrame(a.raf);
      a.raf = 0;
      a.current = text;
      a.target = text;
      setRevealed(text);
      return;
    }
    a.target = text;
    setAnimating(true);
    clearTimeout(a.settle);
    a.settle = window.setTimeout(() => setAnimating(false), SETTLE_MS);
    if (a.raf === 0) {
      a.lastFrame = performance.now();
      advance(a, setRevealed);
    }
  }, [text]);

  useEffect(() => {
    const a = anim.current;
    return () => {
      if (a.raf) cancelAnimationFrame(a.raf);
      clearTimeout(a.settle);
    };
  }, []);

  return { text: revealed, animating };
}
