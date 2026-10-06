import { flushSync } from "react-dom";

/**
 * Run a UI update inside a View Transition so the old state can animate out
 * (see the "Exits" block in App.css) while the new state is already live.
 *
 * Falls back to calling `update` directly when the API is missing (older
 * WebKitGTK, jsdom in tests) or the user asked for reduced motion, so callers
 * never depend on the animation for correctness. `flushSync` makes React
 * commit inside the callback; without it the "new" snapshot would be taken
 * before React re-rendered and nothing would appear to change.
 */
export function withViewTransition(update: () => void): void {
  const reduceMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion || typeof document.startViewTransition !== "function") {
    update();
    return;
  }
  const transition = document.startViewTransition(() => flushSync(update));
  // A skipped transition (hidden window, duplicate transition name, a newer
  // transition starting) rejects these promises; the update itself still ran.
  transition.ready.catch(ignoreSkipped);
  transition.finished.catch(ignoreSkipped);
}

function ignoreSkipped(): void {
  // Intentionally empty: skipping only loses the animation, never the update.
}
