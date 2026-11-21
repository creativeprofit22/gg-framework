// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import windowThemeSource from "../src-tauri/src/window_theme.rs?raw";
import { NATIVE_APPEARANCE_BACKGROUNDS } from "./appearance-native";

// The native first-paint background must equal the colour the frontend applies,
// or new windows open in one shade and jump to another (a visible startup flash).
function nativeBackgroundHex(theme: "Dark" | "Light"): string {
  const pattern = new RegExp(
    String.raw`WindowTheme::${theme}\s*=>\s*(?:tauri::window::)?Color\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*255\s*\)`,
    "g",
  );
  const matches = [...windowThemeSource.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one opaque Color(r, g, b, 255) for WindowTheme::${theme} in window_theme.rs, found ${matches.length}. Update this test if WindowTheme::background() was refactored.`,
    );
  }
  const [, ...channels] = matches[0] ?? [];
  return `#${channels
    .map((channel) => {
      const value = Number(channel);
      if (!Number.isInteger(value) || value > 255) throw new Error(`Invalid channel ${channel}`);
      return value.toString(16).padStart(2, "0");
    })
    .join("")}`;
}

describe("native window background colours", () => {
  it.each([
    ["Dark", "dark"],
    ["Light", "light"],
  ] as const)("Rust WindowTheme::%s matches the frontend %s background", (rust, frontend) => {
    expect(nativeBackgroundHex(rust)).toBe(NATIVE_APPEARANCE_BACKGROUNDS[frontend].toLowerCase());
  });
});
