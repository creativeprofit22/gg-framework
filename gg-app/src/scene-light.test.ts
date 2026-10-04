import { describe, expect, it } from "vitest";
import {
  MOMENTS,
  SUNRISE_HOUR,
  SUNSET_HOUR,
  groundFilter,
  hourOf,
  lightAt,
  moonAt,
  skyAt,
  sunAt,
  wrapHour,
  type Rgb,
} from "./scene-light";

/** WCAG relative luminance, 0 (black) to 1 (white). */
function luminance([r, g, b]: Rgb): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

const contrast = (a: Rgb, b: Rgb): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
};

const WHITE: Rgb = [255, 255, 255];
const EVERY_QUARTER_HOUR = Array.from({ length: 96 }, (_, i) => i / 4);
const moment = (id: (typeof MOMENTS)[number]["id"]): number =>
  MOMENTS.find((m) => m.id === id)?.hour ?? 0;

describe("lightAt", () => {
  it("keeps the sky behind the logo and buttons dark enough for white text at every hour", () => {
    // The home content sits within the top ~85% of the sky.
    for (const hour of EVERY_QUARTER_HOUR) {
      const light = lightAt(hour);
      expect(contrast(WHITE, skyAt(light, 0))).toBeGreaterThanOrEqual(7);
      for (const v of [0.3, 0.55, 0.7, 0.85]) {
        expect(contrast(WHITE, skyAt(light, v))).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("burns the fire low in the morning, out by day, and full after dark", () => {
    expect(lightAt(moment("dawn")).fire).toBeGreaterThan(0);
    expect(lightAt(moment("dawn")).fire).toBeLessThan(0.5);
    expect(lightAt(moment("day")).fire).toBe(0);
    expect(lightAt(moment("golden")).fire).toBeGreaterThan(0.4);
    expect(lightAt(moment("dusk")).fire).toBe(1);
    expect(lightAt(moment("night")).fire).toBe(1);
  });

  it("gives each part of the day its own details", () => {
    const dawn = lightAt(moment("dawn"));
    const day = lightAt(moment("day"));
    const dusk = lightAt(moment("dusk"));
    const night = lightAt(moment("night"));
    // Morning fire: mist in the trees and smoke off the coals.
    expect(dawn.mistLevel).toBe(1);
    expect(dawn.smokeLevel).toBe(1);
    // Afternoon: sunbeams with pollen in them, no stars.
    expect(day.beams).toBe(1);
    expect(day.pollen).toBe(1);
    expect(day.stars).toBe(0);
    // Blue hour: fireflies and bats. Deep night: the owl and every star.
    expect(dusk.fireflies).toBe(1);
    expect(dusk.bats).toBe(1);
    expect(night.owl).toBe(1);
    expect(night.stars).toBe(1);
  });

  it("changes smoothly, with no jump between neighbouring minutes", () => {
    for (let minute = 0; minute < 24 * 60; minute++) {
      const a = lightAt(minute / 60);
      const b = lightAt((minute + 1) / 60);
      for (let c = 0; c < 3; c++) {
        expect(Math.abs((a.skyLow[c] ?? 0) - (b.skyLow[c] ?? 0))).toBeLessThan(3);
      }
      expect(Math.abs(a.fire - b.fire)).toBeLessThan(0.03);
    }
  });

  it("wraps past midnight", () => {
    expect(lightAt(25)).toEqual(lightAt(1));
    expect(lightAt(-1)).toEqual(lightAt(23));
    expect(wrapHour(24)).toBe(0);
  });
});

describe("sunAt / moonAt", () => {
  it("puts the sun on the horizon at sunrise and sunset, highest at midday", () => {
    expect(sunAt(SUNRISE_HOUR).elevation).toBeCloseTo(0);
    expect(sunAt(SUNSET_HOUR).elevation).toBeCloseTo(0);
    expect(sunAt((SUNRISE_HOUR + SUNSET_HOUR) / 2).elevation).toBeCloseTo(1);
    expect(sunAt(SUNRISE_HOUR).x).toBeLessThan(sunAt(SUNSET_HOUR).x);
  });

  it("sinks the sun out of sight at night and raises the moon", () => {
    expect(sunAt(0).elevation).toBe(-1);
    expect(moonAt(0).elevation).toBeGreaterThan(0.5);
    expect(moonAt(12).elevation).toBeLessThan(0);
  });
});

describe("groundFilter", () => {
  it("dims the ground at night and leaves it near full light by day", () => {
    expect(groundFilter(lightAt(2))).toContain("brightness(0.62)");
    expect(groundFilter(lightAt(12))).toContain("brightness(0.94)");
  });
});

describe("hourOf", () => {
  it("reads a fractional local hour", () => {
    expect(hourOf(new Date(2026, 9, 3, 14, 30, 0))).toBe(14.5);
  });
});
