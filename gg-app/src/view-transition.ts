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
export function withViewTransition(update: () => void): void;
export function withViewTransition(update: () => void, local: true): ViewTransition | undefined;
export function withViewTransition(update: () => void, local = false): ViewTransition | undefined {
  const root = document.documentElement;
  // React can close a child surface while committing a parent transition.
  // That removal belongs to the existing snapshot, not a second root snapshot.
  if (root.hasAttribute("data-view-transition-update")) {
    update();
    return;
  }
  const reduceMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion || typeof document.startViewTransition !== "function") {
    update();
    return;
  }
  if (local) {
    root.dataset.localTransitions = String(Number(root.dataset.localTransitions ?? 0) + 1);
  }
  const release = (): void => {
    if (!local) return;
    const remaining = Number(root.dataset.localTransitions ?? 1) - 1;
    if (remaining > 0) root.dataset.localTransitions = String(remaining);
    else delete root.dataset.localTransitions;
  };
  let updated = false;
  const commit = (): void => {
    if (updated) return;
    updated = true;
    root.setAttribute("data-view-transition-update", "");
    try {
      flushSync(update);
    } finally {
      root.removeAttribute("data-view-transition-update");
    }
  };
  try {
    const transition = document.startViewTransition(commit);
    transition.ready.catch(ignoreSkipped);
    void settle();
    async function settle(): Promise<void> {
      try {
        await transition.finished;
      } catch {
        // A skipped transition still commits its update.
      } finally {
        release();
      }
    }
    return transition;
  } catch {
    release();
    if (!updated) update();
    return;
  }
}

function ignoreSkipped(): void {
  // Intentionally empty: skipping only loses the animation, never the update.
}
