import { useSyncExternalStore } from "react";

// Home-screen meme GIF layer. Mirrors sounds.ts: a module-level flag persisted
// per-machine in localStorage so the choice survives restarts. Unlike sounds
// (read at play time), the GIF layer must actually MOUNT/UNMOUNT on toggle, so
// this also exposes a tiny subscribe/notify store + a React hook
// (useSyncExternalStore). That lets MemeLayer re-render the instant the setting
// flips — even when the flip happens in the Settings modal, a sibling subtree.
const STORAGE_KEY = "gg-memes-enabled";

function loadEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

let enabled = loadEnabled();

const listeners = new Set<() => void>();

/** Whether the home-screen meme GIFs are currently shown. */
export function isMemesEnabled(): boolean {
  return enabled;
}

/** Toggle the meme GIF layer. Persisted per-machine in localStorage. */
export function setMemesEnabled(on: boolean): void {
  if (on === enabled) return;
  enabled = on;
  try {
    localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  } catch {
    // Storage unavailable — keep the in-memory toggle only.
  }
  for (const fn of listeners) fn();
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

/** React hook that re-renders when the meme GIF setting changes. */
export function useMemesEnabled(): boolean {
  return useSyncExternalStore(subscribe, isMemesEnabled, isMemesEnabled);
}
