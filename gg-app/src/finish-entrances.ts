/**
 * Jump every one-shot animation under `roots` to its end.
 *
 * The chat hides behind a Goal's Workers view with `display: none` (React's
 * <Activity>), and showing it again restarts every CSS entrance inside it:
 * the deck's window-open dissolve, a notice sliding open, a label fading in.
 * Nothing new appeared, so those replays read as the input and chat jumping.
 * Called the moment the chat is revealed, this leaves each element where it
 * already was. Looping animations (spinners, blinking) are left running.
 */
export function finishEntrances(roots: ReadonlyArray<Element | null>): void {
  for (const root of roots) {
    if (!root || typeof root.getAnimations !== "function") continue;
    for (const animation of root.getAnimations({ subtree: true })) {
      const iterations = animation.effect?.getTiming().iterations;
      if (iterations === undefined || iterations === Infinity) continue;
      try {
        animation.finish();
      } catch {
        // A zero-length or already-idle animation can refuse; nothing to do.
      }
    }
  }
}
