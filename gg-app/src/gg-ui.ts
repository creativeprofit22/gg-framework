import { useSyncExternalStore } from "react";

const STORAGE_KEY = "gg-ui-enabled";
function loadEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}
let enabled = loadEnabled();
const listeners = new Set<() => void>();
function notify(): void {
  for (const listener of listeners) listener();
}
function onStorage(event: StorageEvent): void {
  if (event.key !== STORAGE_KEY && event.key !== null) return;
  const next = loadEnabled();
  if (next === enabled) return;
  enabled = next;
  notify();
}

export function setGgUiEnabled(on: boolean): void {
  if (on === enabled) return;
  enabled = on;
  try {
    localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  } catch {
    // Like the other Effects settings, still work in memory when storage fails.
  }
  notify();
}
function subscribe(callback: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener("storage", onStorage);
  }
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}
function getSnapshot(): boolean {
  return enabled;
}

/** Shared by Settings and every metal decoration; default on, persisted across restarts. */
export function useGgUiEnabled(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
