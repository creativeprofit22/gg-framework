import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { appearance, type Appearance } from "./appearance";
import { toast } from "./toast";

type Theme = Appearance["theme"];
interface NativeAppearanceWindow {
  setTheme(theme: Theme): Promise<void>;
  setBackgroundColor(color: string): Promise<void>;
  /** Remembers the theme so the next native window opens without a flash. */
  rememberTheme(theme: Theme): Promise<void>;
}
export const NATIVE_APPEARANCE_BACKGROUNDS = { dark: "#0f1115", light: "#fcfbfd" } as const;

// One in-flight update and one latest desired value; no unbounded promise chain.
export function createNativeAppearanceSync(target: NativeAppearanceWindow, report: () => void) {
  let desired: Theme | undefined;
  let running = false;
  let stopped = false;
  let lastRequested: Theme | undefined;
  async function drain() {
    running = true;
    try {
      while (!stopped && desired) {
        const theme = desired;
        desired = undefined;
        try {
          await target.setTheme(theme);
          // A newer request replaces the stale background before it is sent.
          if (!stopped && !desired)
            await target.setBackgroundColor(NATIVE_APPEARANCE_BACKGROUNDS[theme]);
        } catch {
          if (!stopped) report();
        }
        if (!stopped && !desired) {
          // Cosmetic startup hint only: a failure never affects this window.
          await target.rememberTheme(theme).catch(() => {
            console.warn("Could not remember the window theme for the next launch.");
          });
        }
      }
    } finally {
      running = false;
    }
  }
  return {
    update(theme: Theme) {
      if (stopped || lastRequested === theme) return;
      lastRequested = theme;
      desired = theme;
      if (!running) void drain();
    },
    stop() {
      stopped = true;
      desired = undefined;
    },
  };
}

export function startNativeAppearance(): () => void {
  if (!isTauri() || (import.meta.env.DEV && window.location.pathname === "/__chat-design-preview"))
    return () => {};
  const target = getCurrentWindow();
  const sync = createNativeAppearanceSync(
    {
      setTheme: (theme) => target.setTheme(theme),
      // Tauri 2.11.5's window setter reads `value`; the installed JS SDK sends
      // `color`, which silently deserializes as None. Hex strings are Rust Color.
      setBackgroundColor: (value) =>
        invoke<void>("plugin:window|set_background_color", { label: target.label, value }),
      rememberTheme: (theme) => invoke<void>("set_window_theme_hint", { theme }),
    },
    () => {
      // No preference rollback: web content remains usable after native failure.
      console.error(
        "Native appearance synchronization failed; window chrome may not match the selected theme.",
      );
      toast(
        "Window appearance could not be updated. The selected theme still applies to content.",
        "error",
      );
    },
  );
  const update = () => sync.update(appearance.getSnapshot().preferences.theme);
  const unsubscribe = appearance.subscribe(update);
  update();
  return () => {
    unsubscribe();
    sync.stop();
  };
}
