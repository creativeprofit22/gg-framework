import { useEffect, useState } from "react";

/**
 * Light / dark appearance. The choice is per machine (localStorage, which every
 * window shares), so flipping it in one window flips them all: the others hear
 * the `storage` event. "auto" follows macOS (or Windows) appearance live.
 *
 * Applied as `<html data-theme="light|dark">`; App.css keys every colour token
 * off that attribute.
 */
export type ColorSchemePref = "light" | "dark" | "auto";
export type ColorScheme = "light" | "dark";

const KEY = "gg-color-scheme";
const CHANGE = "gg-color-scheme-change";
// Before this setting existed the app was dark only, so dark stays the default
// rather than surprising anyone whose Mac is set to light.
const DEFAULT_PREF: ColorSchemePref = "dark";

function isPref(value: unknown): value is ColorSchemePref {
  return value === "light" || value === "dark" || value === "auto";
}

export function readColorSchemePref(
  storage: Pick<Storage, "getItem"> = localStorage,
): ColorSchemePref {
  try {
    const stored = storage.getItem(KEY);
    return isPref(stored) ? stored : DEFAULT_PREF;
  } catch {
    return DEFAULT_PREF;
  }
}

export function resolveColorScheme(pref: ColorSchemePref, systemDark: boolean): ColorScheme {
  if (pref === "auto") return systemDark ? "dark" : "light";
  return pref;
}

function systemQuery(): MediaQueryList | null {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;
}

function apply(pref: ColorSchemePref): void {
  const scheme = resolveColorScheme(pref, systemQuery()?.matches ?? true);
  document.documentElement.dataset.theme = scheme;
  document.documentElement.style.colorScheme = scheme;
}

export function setColorSchemePref(pref: ColorSchemePref): void {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    // Storage can be unavailable (private mode); the change still applies here.
  }
  apply(pref);
  window.dispatchEvent(new Event(CHANGE));
  // Local Fork: the Appearance preference is the one theme setting. Route the
  // choice through it so data-appearance-theme (liquid glass) follows too.
  const scheme = resolveColorScheme(pref, systemQuery()?.matches ?? true);
  void import("./appearance").then(({ appearance }) => appearance.update({ theme: scheme }));
}

/**
 * Set `data-theme` before the first paint and keep it current: system changes
 * (for "auto") and changes made in another window. Call once per window.
 */
export function installColorScheme(): void {
  // Local Fork: appearance.start() (main.tsx, earlier) already set data-theme
  // from the Appearance preference before first paint. Re-applying the legacy
  // gg-color-scheme key here would override it and split the theme in two, so
  // this only keeps other windows' pickers in step.
  window.addEventListener("storage", (event) => {
    if (event.key === KEY) window.dispatchEvent(new Event(CHANGE));
  });
}

/** The stored preference, kept current across windows. */
export function useColorSchemePref(): ColorSchemePref {
  const [pref, setPref] = useState(readColorSchemePref);
  useEffect(() => {
    const sync = (): void => setPref(readColorSchemePref());
    window.addEventListener(CHANGE, sync);
    return () => window.removeEventListener(CHANGE, sync);
  }, []);
  return pref;
}
