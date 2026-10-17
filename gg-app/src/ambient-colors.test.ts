// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { AMBIENT_FALLBACK, parseCssColor, readAmbientColors, rgbaCss } from "./ambient-colors";

describe("parseCssColor", () => {
  it.each([
    ["#0a0a0c", [10 / 255, 10 / 255, 12 / 255]],
    ["  #FCFBFD ", [252 / 255, 251 / 255, 253 / 255]],
    ["#fff", [1, 1, 1]],
    ["rgb(85, 96, 216)", [85 / 255, 96 / 255, 216 / 255]],
    ["rgba(20, 21, 25, 0.5)", [20 / 255, 21 / 255, 25 / 255]],
    ["rgb(176 182 255 / 40%)", [176 / 255, 182 / 255, 1]],
  ] as const)("parses %s", (input, expected) => {
    expect(parseCssColor(input)).toEqual(expected);
  });

  it.each(["", "var(--bg)", "#12345", "rgb(300, 0, 0)", "hsl(0 0% 0%)", "transparent"])(
    "rejects %j",
    (input) => {
      expect(parseCssColor(input)).toBeNull();
    },
  );
});

describe("readAmbientColors", () => {
  it("falls back to the dark family without an element or tokens", () => {
    expect(readAmbientColors(null)).toEqual(AMBIENT_FALLBACK);
    expect(readAmbientColors(document.createElement("div"))).toEqual(AMBIENT_FALLBACK);
  });

  it("reads resolved tokens and falls back per unresolvable token", () => {
    const el = document.createElement("div");
    el.style.setProperty("--ambient-base", "#fcfbfd");
    el.style.setProperty("--ambient-ink", "rgb(184, 178, 219)");
    el.style.setProperty("--ambient-ink-hi", "not-a-colour");
    document.body.append(el);
    expect(readAmbientColors(el)).toEqual({
      base: [252 / 255, 251 / 255, 253 / 255],
      ink: [184 / 255, 178 / 255, 219 / 255],
      inkHi: AMBIENT_FALLBACK.inkHi,
    });
    el.remove();
  });
});

describe("rgbaCss", () => {
  it("formats clamped channels with alpha", () => {
    expect(rgbaCss([10 / 255, 10 / 255, 12 / 255], 0.18)).toBe("rgba(10, 10, 12, 0.18)");
    expect(rgbaCss([1.2, -1, 0.5])).toBe("rgba(255, 0, 128, 1)");
  });
});
