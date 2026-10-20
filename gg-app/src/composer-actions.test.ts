import { describe, expect, it } from "vitest";
import {
  COMPOSER_ACTION_STORAGE_KEY,
  DIAL_RADIUS,
  dialLayout,
  dialShift,
  missingSequenceCommands,
  readComposerAction,
  writeComposerAction,
} from "./composer-actions";

describe("composer actions", () => {
  it("reads only a known saved action, falling back to Opportunities", () => {
    const store = (value: string | null) => ({ getItem: () => value });
    expect(readComposerAction(store("post-check"))).toBe("post-check");
    expect(readComposerAction(store("rm -rf"))).toBe("opportunities");
    expect(readComposerAction(store(null))).toBe("opportunities");
    expect(readComposerAction(null)).toBe("opportunities");
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
    };
    expect(readComposerAction(throwing)).toBe("opportunities");
  });

  it("saves the choice and survives unavailable storage", () => {
    const saved = new Map<string, string>();
    writeComposerAction({ setItem: (key, value) => saved.set(key, value) }, "post-check");
    expect(saved.get(COMPOSER_ACTION_STORAGE_KEY)).toBe("post-check");
    expect(() =>
      writeComposerAction(
        {
          setItem: () => {
            throw new Error("full");
          },
        },
        "opportunities",
      ),
    ).not.toThrow();
  });

  it("lists sequence commands the project lacks, matching names and aliases", () => {
    const available = [
      { name: "trace", aliases: [] },
      { name: "Contract-Check", aliases: ["contract"] },
    ];
    expect(missingSequenceCommands(["/trace", "/parity", "/contract"], available)).toEqual([
      "/parity",
    ]);
  });

  it("fans options over the top of the hub, symmetric and evenly spaced", () => {
    expect(dialLayout(0)).toEqual([]);
    expect(dialLayout(1)).toEqual([{ x: 0, y: -DIAL_RADIUS }]);
    const two = dialLayout(2);
    expect(two[0]?.x).toBeCloseTo(-(two[1]?.x ?? 0));
    expect(two[0]?.y).toBeCloseTo(two[1]?.y ?? 0);
    for (const count of [2, 3, 4, 6]) {
      const points = dialLayout(count);
      expect(points).toHaveLength(count);
      // Every petal sits above the hub, ordered left to right.
      for (const point of points) expect(point.y).toBeLessThan(0);
      const xs = points.map((point) => point.x);
      expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    }
  });

  it("nudges the dial inside its bounds only when a petal would leave them", () => {
    const points = [
      { x: -30, y: -50 },
      { x: 30, y: -50 },
    ];
    expect(dialShift(200, points, 0, 400, 20)).toBe(0);
    expect(dialShift(40, points, 0, 400, 20)).toBe(10);
    expect(dialShift(370, points, 0, 400, 20)).toBe(-20);
    // Wider than the bounds: nothing sensible to do, leave it centred.
    expect(dialShift(50, points, 0, 60, 20)).toBe(0);
  });
});
