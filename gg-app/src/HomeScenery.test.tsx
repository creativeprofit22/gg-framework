// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomeScenery, withScenery } from "./HomeScenery";
import { CONTENT_HALF_WIDTH, flicker, layoutCampfire, ridgeAt, sunDisc } from "./campfire-scene";
import { BIOMES } from "./critter-terrain";

beforeEach(() => {
  // jsdom has no 2D canvas: the scenery must quietly draw nothing.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("withScenery", () => {
  it("puts the critters on grass in the campfire's clearing, whatever the visit picked", () => {
    for (const biome of BIOMES) {
      expect(withScenery(biome).id).toBe("meadow");
    }
  });
});

describe("HomeScenery", () => {
  it("renders a decorative canvas, hidden from assistive tech, even without 2D canvas", () => {
    const { container } = render(<HomeScenery hour={18.75} />);
    const scenery = container.querySelector<HTMLElement>(".home-scenery");
    expect(scenery?.getAttribute("aria-hidden")).toBe("true");
    expect(scenery?.querySelector("canvas")).not.toBeNull();
  });
});

describe("layoutCampfire", () => {
  it("is the same clearing every time for the same window", () => {
    expect(layoutCampfire(1280, 800)).toEqual(layoutCampfire(1280, 800));
  });

  it("keeps the sky's details above the ridge and the pines at the edges", () => {
    const layout = layoutCampfire(1280, 800);
    for (const star of layout.stars) expect(star.y).toBeLessThan(layout.horizon);
    for (let x = 0; x < layout.width; x += 40) {
      expect(ridgeAt(layout, x)).toBeLessThan(layout.horizon);
    }
    // The middle stays open for the logo and buttons.
    for (const pine of layout.pines) {
      expect(pine.x < layout.width * 0.3 || pine.x > layout.width * 0.7).toBe(true);
    }
  });

  it("sits the owl on a pine at the left, below the top of the window", () => {
    const { owl, width, height } = layoutCampfire(1280, 800);
    expect(owl.x).toBeLessThan(width * 0.2);
    expect(owl.y).toBeGreaterThan(0);
    expect(owl.y).toBeLessThan(height);
  });

  it("sends the embers up from the middle, where the fire is", () => {
    const { embers, width } = layoutCampfire(1280, 800);
    for (const ember of embers) {
      expect(ember.x0).toBeGreaterThan(width * 0.25);
      expect(ember.x0).toBeLessThan(width * 0.75);
    }
  });

  it("stays sane in a tiny window", () => {
    const layout = layoutCampfire(20, 30);
    expect(layout.horizon).toBeGreaterThan(0);
    expect(layout.horizon).toBeLessThan(layout.height);
  });
});

describe("sunDisc", () => {
  it.each([
    [1280, 800],
    [900, 600],
    [1920, 1080],
  ])("never puts the sun behind the logo or buttons in a %ix%i window", (width, height) => {
    const layout = layoutCampfire(width, height);
    for (let minute = 0; minute < 24 * 60; minute += 5) {
      const sun = sunDisc(layout, minute / 60);
      const onScreen = sun.y + sun.r > 0 && sun.elevation > -0.05;
      if (!onScreen) continue;
      expect(Math.abs(sun.x - width / 2)).toBeGreaterThanOrEqual(CONTENT_HALF_WIDTH + sun.r - 0.5);
    }
  });

  it("rises on the left and sets on the right", () => {
    const layout = layoutCampfire(1280, 800);
    expect(sunDisc(layout, 7).x).toBeLessThan(640);
    expect(sunDisc(layout, 18.5).x).toBeGreaterThan(640);
  });
});

describe("flicker", () => {
  it("breathes within a gentle range, never going dark or flaring", () => {
    for (let t = 0; t < 60; t += 0.05) {
      expect(flicker(t)).toBeGreaterThan(0.65);
      expect(flicker(t)).toBeLessThan(1.05);
    }
  });
});
