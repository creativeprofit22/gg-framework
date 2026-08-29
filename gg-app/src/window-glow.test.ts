import { describe, expect, it } from "vitest";
import { glowPlacement, glowStateFor, glowVars } from "./window-glow";

describe("glowPlacement", () => {
  it("is stable for a given window, so the glow does not jump on reload", () => {
    expect(glowPlacement("project-3")).toEqual(glowPlacement("project-3"));
  });

  it("differs between windows, so a tiled grid is not rubber-stamped", () => {
    const labels = ["main", "project-1", "project-2", "project-3", "project-4", "project-5"];
    const seen = new Set(labels.map((l) => JSON.stringify(glowPlacement(l))));
    expect(seen.size).toBe(labels.length);
  });

  it("keeps the wash off-centre so it never sits behind body text", () => {
    for (const label of ["main", "project-1", "project-2", "project-3", "project-9", "x"]) {
      const p = glowPlacement(label);
      // A centred glow washes out the transcript; a corner reads as light
      // entering the window.
      const offCentre = p.x1 <= 24 || p.x1 >= 76;
      expect(offCentre, `x1=${p.x1} for ${label}`).toBe(true);
    }
  });

  it("puts the second wash in the opposing half so the two never stack", () => {
    for (const label of ["main", "project-1", "project-7"]) {
      const p = glowPlacement(label);
      expect(Math.abs(p.x1 - p.x2)).toBeGreaterThan(50);
      expect(Math.abs(p.y1 - p.y2)).toBeGreaterThan(50);
    }
  });

  it("keeps every value inside its CSS-safe range", () => {
    for (let i = 0; i < 60; i++) {
      const p = glowPlacement(`w-${i}`);
      for (const v of [p.x1, p.y1, p.x2, p.y2]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
      expect(p.size).toBeGreaterThanOrEqual(38);
      expect(p.size).toBeLessThanOrEqual(58);
      // Bounded hue drift: varied, but never out of the palette.
      expect(Math.abs(p.hueShift)).toBeLessThanOrEqual(18);
    }
  });
});

describe("glowVars", () => {
  it("emits the custom properties the stylesheet reads", () => {
    const vars = glowVars(glowPlacement("main"));
    expect(Object.keys(vars).sort()).toEqual([
      "--glow-hue",
      "--glow-size",
      "--glow-x1",
      "--glow-x2",
      "--glow-y1",
      "--glow-y2",
    ]);
    expect(vars["--glow-x1"]).toMatch(/^\d+%$/);
    expect(vars["--glow-hue"]).toMatch(/^-?\d+deg$/);
  });
});

describe("glowStateFor", () => {
  it("pulses while the agent is working", () => {
    expect(glowStateFor(true, false)).toBe("working");
  });

  // A timed revert was wrong: the glow announced "finished", then quietly undid
  // itself while the result was still on screen and still true.
  it("stays done after a run, rather than reverting on a timer", () => {
    expect(glowStateFor(false, true)).toBe("done");
  });

  it("is idle only before anything has run in this window", () => {
    expect(glowStateFor(false, false)).toBe("idle");
  });

  it("lets a new run take over from a finished one", () => {
    expect(glowStateFor(true, true)).toBe("working");
  });
});
