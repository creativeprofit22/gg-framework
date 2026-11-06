import { createContext, useContext } from "react";
import darkTheme from "./dark.json" with { type: "json" };
import lightTheme from "./light.json" with { type: "json" };
import darkAnsiTheme from "./dark-ansi.json" with { type: "json" };
import lightAnsiTheme from "./light-ansi.json" with { type: "json" };
import darkDaltonizedTheme from "./dark-daltonized.json" with { type: "json" };
import lightDaltonizedTheme from "./light-daltonized.json" with { type: "json" };

export type Theme = typeof darkTheme;

export type ThemeName =
  "dark" | "light" | "dark-ansi" | "light-ansi" | "dark-daltonized" | "light-daltonized";

export function loadTheme(name: ThemeName): Theme {
  switch (name) {
    case "light":
      return lightTheme;
    case "dark-ansi":
      return darkAnsiTheme;
    case "light-ansi":
      return lightAnsiTheme;
    case "dark-daltonized":
      return darkDaltonizedTheme;
    case "light-daltonized":
      return lightDaltonizedTheme;
    default:
      return darkTheme;
  }
}

export const ThemeContext = createContext<Theme>(darkTheme);

/** Callback to switch theme at runtime. Null when not inside ThemeProvider. */
export const SetThemeContext = createContext<((name: ThemeName) => void) | null>(null);

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

/** Returns a function to switch themes at runtime. Returns null if not available. */
export function useSetTheme(): ((name: ThemeName) => void) | null {
  return useContext(SetThemeContext);
}
