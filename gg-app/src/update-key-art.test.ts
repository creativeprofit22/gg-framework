import { describe, expect, it } from "vitest";
import { burstPieces, cellFlights, PLATE_ROWS, PLATE_SRC, pixelWord } from "./update-key-art";

describe("update key art", () => {
  it("lays words out in the pixel font, one blank column between glyphs", () => {
    const word = pixelWord("XP");
    expect(word.cols).toBe(7);
    expect(word.rows).toBe(5);
    // X's top-left and P's top-left are lit; the gap column never is.
    expect(word.cells.some((c) => c.col === 0 && c.row === 0)).toBe(true);
    expect(word.cells.some((c) => c.col === 4 && c.row === 0)).toBe(true);
    expect(word.cells.some((c) => c.col === 3)).toBe(false);
    expect(word.cells.every((c) => c.t >= 0 && c.t <= 1)).toBe(true);
  });

  it("fits 100% in the 15 columns the XP readout reserves", () => {
    expect(pixelWord("100%").cols).toBe(15);
    expect(pixelWord("7%").cols).toBeLessThan(15);
  });

  it("scatters a word the same way every time", () => {
    const word = pixelWord("Update");
    expect(cellFlights(word, "Update", 70)).toEqual(cellFlights(word, "Update", 70));
    expect(cellFlights(word, "Update", 70)).toHaveLength(word.cells.length);
  });

  it("flings the burst out in every direction", () => {
    const burst = burstPieces();
    expect(burst).toEqual(burstPieces());
    expect(burst.some((p) => p.dx > 0) && burst.some((p) => p.dx < 0)).toBe(true);
    expect(burst.some((p) => p.dy > 0) && burst.some((p) => p.dy < 0)).toBe(true);
  });

  it("gives the plate a size border-image can slice", () => {
    expect(PLATE_ROWS.every((row) => row.length === 12)).toBe(true);
    expect(decodeURIComponent(PLATE_SRC)).toContain('<svg width="12" height="12" ');
  });
});
