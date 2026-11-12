import { describe, expect, it } from "vitest";
import { composeMap } from "./goal-map-compose";
import { TILE } from "./goal-map-ground";
import { MAP_COLS, MAP_ROWS, MOCKUPS } from "./goal-map-mockups";
import { E, PixelBuffer } from "./goal-map-pixels";
import { lean } from "./goal-map-props";

describe("top-down goal map mockups", () => {
  it("has every world, the first at the standard map size", () => {
    expect(MOCKUPS.map((m) => m.id)).toEqual([
      "1-homestead",
      "2-village",
      "3-hillside",
      "3b-cozy-hillside",
      "6-farmstead",
      "4-harbour",
      "5-workshop",
    ]);
    // The original five share the standard map size.
    const homestead = MOCKUPS[0]?.build();
    expect(homestead && [homestead.grid.cols, homestead.grid.rows]).toEqual([MAP_COLS, MAP_ROWS]);
  });

  // One world per test: painting all of them in one ran past the time limit
  // on the slower Windows CI runner.
  it.each(MOCKUPS.map((m) => [m.id, m] as const))("paints %s at its map size", (_id, m) => {
    const scene = m.build();
    const buf = composeMap(scene);
    expect([buf.width, buf.height]).toEqual([scene.grid.cols * TILE, scene.grid.rows * TILE]);
  });

  it("paints the same world the same way every time", () => {
    const build = MOCKUPS[0]?.build;
    if (!build) throw new Error("no mockups");
    const a = composeMap(build()).data;
    const b = composeMap(build()).data;
    expect(a.length).toBe(b.length);
    expect(a.every((value, i) => value === b[i])).toBe(true);
  });

  it("keeps a terrace's top as grass, with only its edge in shade", () => {
    // Regression: the rim test matched every pixel more than a cliff-height
    // above the foot, so whole terraces were painted the rim's dark teal.
    const hillside = MOCKUPS.find((m) => m.id === "3-hillside");
    if (!hillside) throw new Error("no hillside");
    const buf = composeMap(hillside.build());
    // The middle of the top terrace (row 2) and of the middle terrace (row 13),
    // away from props and paths.
    for (const [x, y] of [
      [TILE * 6 + 8, TILE * 2 + 8],
      [TILE * 20 + 8, TILE * 14 + 4],
    ] as const) {
      expect(buf.rgb(x, y)).not.toBe(E.teal0);
    }
  });
});

describe("lean (the high camera)", () => {
  /** How many opaque pixels a row has. */
  const widthAt = (buf: PixelBuffer, y: number): number => {
    let n = 0;
    for (let x = 0; x < buf.width; x++) if (buf.opaque(x, y)) n++;
    return n;
  };

  it("keeps a building widest at its eave and narrows it toward the ground and the back", () => {
    // A roof 40 wide (rows 0-9) overhanging walls 36 wide (rows 10-29), the foot on row 29.
    const buf = new PixelBuffer(40, 30);
    buf.rect(0, 0, 40, 10, 0x8e613a);
    buf.rect(2, 10, 36, 20, 0xc98149);
    const leaned = lean({ buf, ax: 20, ay: 29 }, 0.2, 0.2).buf;
    expect(widthAt(leaned, 9)).toBe(42); // the eave keeps its width, plus its outline
    expect(widthAt(leaned, 10)).toBe(36); // the top of the wall too
    expect(widthAt(leaned, 29)).toBeLessThan(32); // the walls lean in to the ground
    // The roof narrows to the back: even with its outline, well inside the eave.
    expect(widthAt(leaned, 0)).toBeLessThan(widthAt(leaned, 9) - 4);
    // The roof ran to the canvas edge, so it had no outline there; leaned,
    // each of its rows gets one at both ends, darker than the thatch.
    for (let y = 0; y <= 9; y++) {
      const xs = Array.from({ length: leaned.width }, (_, x) => x).filter((x) =>
        leaned.opaque(x, y),
      );
      for (const x of [xs[0] ?? 0, xs[xs.length - 1] ?? 0]) {
        expect(leaned.rgb(x, y)).not.toBe(0x8e613a);
      }
    }
    // Every row stays one solid run: no gaps opened in the middle.
    for (let y = 0; y < 30; y++) {
      const xs = Array.from({ length: leaned.width }, (_, x) => x).filter((x) =>
        leaned.opaque(x, y),
      );
      expect((xs[xs.length - 1] ?? 0) - (xs[0] ?? 0) + 1).toBe(xs.length);
    }
  });
});
