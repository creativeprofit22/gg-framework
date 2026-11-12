/** localStorage key: the last update version the ready sound played for. */
export const ANNOUNCED_UPDATE_KEY = "gg-update-announced";

/**
 * Play the update-ready sound once per version, per machine. Every window (and
 * both update hooks in one window) polls on its own, and they share
 * localStorage, so the first one to see a version claims it and the rest stay
 * quiet. Returns whether it played.
 */
export function announceUpdate(
  version: string,
  storage: Pick<Storage, "getItem" | "setItem"> | null,
  play: () => void,
): boolean {
  try {
    if (storage?.getItem(ANNOUNCED_UPDATE_KEY) === version) return false;
    storage?.setItem(ANNOUNCED_UPDATE_KEY, version);
  } catch {
    // Storage unavailable: still announce, just without the dedupe.
  }
  play();
  return true;
}
