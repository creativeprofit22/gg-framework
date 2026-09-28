import { useSyncExternalStore } from "react";

/**
 * Whether the home screen shows its animated background (the dithered waves).
 * On by default; the choice is stored per machine, like the sound setting.
 * Off leaves the plain window background and loads none of the 3D code.
 *
 * Kept as a small external store so every mounted reader updates at once,
 * including other windows (via the `storage` event).
 */
const STORAGE_KEY = "gg-home-background";

function read(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

let enabled = read();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another window changed it.
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== STORAGE_KEY) return;
    enabled = read();
    emit();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function isHomeBackgroundEnabled(): boolean {
  return enabled;
}

export function setHomeBackgroundEnabled(on: boolean): void {
  enabled = on;
  try {
    localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  } catch {
    // Storage unavailable: keep the in-memory choice only.
  }
  emit();
}

export function useHomeBackgroundEnabled(): boolean {
  return useSyncExternalStore(subscribe, isHomeBackgroundEnabled);
}
