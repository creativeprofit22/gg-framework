import { describe, expect, it } from "vitest";
import { GLASS_WISPS, sampleGlassWisps } from "./glass-wisps";

describe("glass wisps", () => {
  it("is a pure function of absolute time", () => {
    expect(sampleGlassWisps(3.25)).toEqual(sampleGlassWisps(3.25));
    expect(sampleGlassWisps(3.25)).not.toEqual(sampleGlassWisps(3.5));
  });

  it("loops without a seam and treats non-finite time as zero", () => {
    expect(sampleGlassWisps(GLASS_WISPS.wrapSeconds + 7)).toEqual(sampleGlassWisps(7));
    expect(sampleGlassWisps(-1)).toEqual(sampleGlassWisps(GLASS_WISPS.wrapSeconds - 1));
    expect(sampleGlassWisps(Number.NaN)).toEqual(sampleGlassWisps(0));
    expect(sampleGlassWisps(Number.POSITIVE_INFINITY)).toEqual(sampleGlassWisps(0));
  });

  it("keeps every ribbon closed and inside the lamp body", () => {
    for (const t of [0, 1, 2.3, 5.3, 60, 119.9]) {
      for (const ribbon of sampleGlassWisps(t)) {
        const numbers = ribbon.d.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
        expect(numbers.length).toBe(26);
        expect(numbers.slice(0, 2)).toEqual(numbers.slice(-2));
        // Bezier curves stay inside their control hull; the body radius is 100.
        for (const value of numbers) expect(Math.abs(value)).toBeLessThan(115);
      }
    }
  });

  it("trades opacity between the far and near passes within the authored budget", () => {
    for (const t of [0, 1.7, 4, 6.2]) {
      for (const ribbon of sampleGlassWisps(t)) {
        expect(ribbon.far[0]).toBe(0);
        expect(ribbon.near[3]).toBe(0);
        for (const stop of [1, 2] as const) {
          const base = GLASS_WISPS.baselineOpacities[stop];
          expect(ribbon.near[stop]).toBeGreaterThanOrEqual(base * GLASS_WISPS.minWeight - 1e-9);
          expect(ribbon.near[stop]).toBeLessThanOrEqual(base * GLASS_WISPS.maxWeight + 1e-9);
          expect(ribbon.far[stop] + ribbon.near[stop]).toBeLessThanOrEqual(base + 1e-9);
        }
      }
    }
  });
});
