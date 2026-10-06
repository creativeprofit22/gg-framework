import { describe, expect, it } from "vitest";
import {
  BIOMES,
  DECOR_COLS,
  GROUND_COLS,
  MAX_PARTICLES,
  TERRAIN_FLOOR_ROW,
  TERRAIN_ROWS,
  groundRows,
  particleCount,
  pickBiome,
  propLayer,
  renderTerrain,
  weatherParticles,
} from "./critter-terrain";

const each = BIOMES.map((b) => [b.id, b] as const);
const FLOOR = TERRAIN_ROWS - TERRAIN_FLOOR_ROW;

describe("terrain biomes", () => {
  it("offers meadow, beach, desert, space and snow", () => {
    expect(BIOMES.map((b) => b.id)).toEqual(["meadow", "beach", "desert", "space", "snow"]);
  });

  it.each(each)("%s: every cell of ground, props and travelers has a colour", (_id, biome) => {
    expect(biome.layers).toHaveLength(FLOOR);
    const ground = groundRows(biome);
    expect(ground).toHaveLength(TERRAIN_ROWS);
    expect(ground.every((row) => row.length === GROUND_COLS)).toBe(true);
    const stamps = [...biome.decor, ...(biome.travelers ?? [])].map((p) => p.stamp);
    for (const ch of [...ground.join(""), ...stamps.flat().join("")]) {
      if (ch !== ".") expect(biome.palette[ch], `${biome.id} missing "${ch}"`).toBeDefined();
    }
  });

  it.each(each)("%s: solid ground from the floor down, open air above it", (_id, biome) => {
    const ground = groundRows(biome);
    ground.slice(TERRAIN_FLOOR_ROW).forEach((row) => expect(row).not.toContain("."));
    ground
      .slice(0, TERRAIN_FLOOR_ROW - 1)
      .forEach((row) => expect(row).toBe(".".repeat(GROUND_COLS)));
  });

  it.each(each)("%s: props fit the strip, sunk ones stay inside the ground", (_id, biome) => {
    for (const p of biome.decor) {
      const width = Math.max(...p.stamp.map((line) => line.length));
      expect(p.x + width).toBeLessThanOrEqual(DECOR_COLS);
      // Sunk props move with the land, so they must not poke out below it.
      expect(FLOOR + p.lift).toBeGreaterThanOrEqual(0);
    }
  });

  it.each(each)("%s: has something moving while it's out", (_id, biome) => {
    const moving =
      biome.decor.some((p) => p.motion !== null) ||
      biome.weather !== undefined ||
      (biome.travelers ?? []).length > 0;
    expect(moving).toBe(true);
  });

  it("snow falls rather than hanging in the air", () => {
    const snow = BIOMES.find((b) => b.id === "snow");
    expect(snow?.weather?.kind).toBe("snow");
    // No single white cells parked in the sky any more.
    expect(snow?.decor.filter((p) => p.lift > 0)).toEqual([]);
  });

  it("renders the same art every time, props ordered left to right", () => {
    for (const biome of BIOMES) {
      const art = renderTerrain(biome);
      expect(art).toEqual(renderTerrain(biome));
      const xs = art.props.map((p) => p.x);
      expect(xs).toEqual([...xs].sort((a, b) => a - b));
      expect(art.props.every((p) => p.url.startsWith("data:image/svg+xml"))).toBe(true);
    }
  });

  it("puts props on the right layer for how they enter", () => {
    expect(propLayer(-1)).toBe("sunk");
    expect(propLayer(0)).toBe("ground");
    expect(propLayer(6)).toBe("sky");
  });
});

describe("weather", () => {
  const snow = BIOMES.find((b) => b.id === "snow");
  if (!snow) throw new Error("no snow biome");

  it("scales with the lane's width, within limits", () => {
    expect(particleCount(snow, 0)).toBe(0);
    expect(particleCount(snow, 50)).toBe(3);
    expect(particleCount(snow, 800)).toBeGreaterThan(particleCount(snow, 400));
    expect(particleCount(snow, 100_000)).toBe(MAX_PARTICLES);
  });

  it("is seeded, and a wider lane only adds particles at the end", () => {
    const few = weatherParticles(snow, 10);
    expect(weatherParticles(snow, 10)).toEqual(few);
    expect(weatherParticles(snow, 20).slice(0, 10)).toEqual(few);
  });

  it("starts every particle part-way through its loop, inside the lane", () => {
    for (const p of weatherParticles(snow, 40)) {
      expect(p.delay).toBeLessThanOrEqual(0);
      expect(-p.delay).toBeLessThanOrEqual(p.duration);
      expect(p.left).toBeGreaterThanOrEqual(0);
      expect(p.left).toBeLessThanOrEqual(100);
      expect(snow.weather?.colors).toContain(p.color);
    }
  });
});

describe("pickBiome", () => {
  it("can land on any biome", () => {
    const seen = new Set(
      BIOMES.map((_b, i) => pickBiome(null, () => (i + 0.5) / BIOMES.length).id),
    );
    expect(seen.size).toBe(BIOMES.length);
  });

  it("never repeats the previous visit's biome", () => {
    for (const previous of BIOMES) {
      for (const roll of [0, 0.25, 0.5, 0.75, 0.999]) {
        expect(pickBiome(previous.id, () => roll).id).not.toBe(previous.id);
      }
    }
  });

  it("ignores an unknown remembered biome", () => {
    expect(BIOMES).toContain(pickBiome("volcano", () => 0.4));
  });
});
