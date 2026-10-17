import { useSyncExternalStore } from "react";

/**
 * How much this window animates. The single source for every animation in the
 * app — CSS loops (via `<html data-motion>` + `--loop-play-state`), the critter
 * floor, rAF scenery, spinners and live clocks — so a background window can't
 * keep one subsystem running after another was paused.
 *
 * - `full`: the window the user is looking at (visible and focused).
 * - `still`: visible but not focused (side-by-side windows). Decorative loops
 *   rest in a still pose; status text, timers and new content keep updating.
 * - `off`: hidden (minimised, another Space, fully covered). Nothing ticks;
 *   clocks catch up the moment the window is shown again.
 */
export type MotionLevel = "full" | "still" | "off";

/** The current level, from page visibility and window focus. */
export function readMotionLevel(): MotionLevel {
  if (document.hidden) return "off";
  return document.hasFocus() ? "full" : "still";
}

/**
 * Call `onChange` whenever this window's motion level changes. Returns the
 * unsubscribe. A blur that keeps the level (already hidden) is not reported.
 */
export function subscribeMotion(onChange: (level: MotionLevel) => void): () => void {
  let last = readMotionLevel();
  const check = (): void => {
    const next = readMotionLevel();
    if (next === last) return;
    last = next;
    onChange(next);
  };
  window.addEventListener("focus", check);
  window.addEventListener("blur", check);
  document.addEventListener("visibilitychange", check);
  return () => {
    window.removeEventListener("focus", check);
    window.removeEventListener("blur", check);
    document.removeEventListener("visibilitychange", check);
  };
}

/** React view of the motion level; re-renders only when it changes. */
export function useMotionLevel(): MotionLevel {
  return useSyncExternalStore(subscribeMotion, readMotionLevel);
}

/**
 * Mirror the level onto `<html data-motion>` so stylesheets can follow it
 * (see `--loop-play-state` in App.css). Call once per window, before the
 * first render. Returns the unsubscribe.
 */
export function installMotionAttribute(root: HTMLElement = document.documentElement): () => void {
  root.dataset.motion = readMotionLevel();
  return subscribeMotion((level) => {
    root.dataset.motion = level;
  });
}
