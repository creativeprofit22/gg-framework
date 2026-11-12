import { describe, expect, it } from "vitest";
import { CRITTERS } from "./critter-sprites";
import {
  LOG_FRAME_CELLS,
  LOG_CORNER_CELLS,
  logBeamRows,
  logFramePieces,
  logFrameRows,
  parseMode,
  pickCrew,
  pixelText,
  seeded,
  shortDate,
  splitItem,
} from "./whatsnew-content";

describe("splitItem", () => {
  it.each([
    [
      "Plans never get stuck in limbo again. Whether Autopilot approves, it shows.",
      "Plans never get stuck in limbo again.",
      "Whether Autopilot approves, it shows.",
    ],
    [
      "Meet `GPT-5.6`, now the default. It is fast.",
      "Meet `GPT-5.6`, now the default.",
      "It is fast.",
    ],
    ["Big win. Planning got sharper today.", "Big win. Planning got sharper today.", ""],
    ["One sentence with no break", "One sentence with no break", ""],
  ])("%s", (text, headline, body) => {
    expect(splitItem(text)).toEqual({ headline, body });
  });
});

describe("parseMode", () => {
  it("only opens hype when asked for exactly", () => {
    expect(parseMode("hype")).toBe("hype");
    expect(parseMode("HYPE")).toBe("calm");
    expect(parseMode(null)).toBe("calm");
  });
});

describe("pickCrew", () => {
  it("never repeats a critter until the roster runs out", () => {
    const crew = pickCrew(CRITTERS.length, seeded(1));
    expect(new Set(crew.map((c) => c.id)).size).toBe(CRITTERS.length);
  });

  it("is reproducible for the same random source", () => {
    expect(pickCrew(4, seeded(9)).map((c) => c.id)).toEqual(
      pickCrew(4, seeded(9)).map((c) => c.id),
    );
  });
});

describe("log frame art", () => {
  it("is a square grid with notched, see-through corners and a solid edge", () => {
    const rows = logFrameRows();
    expect(rows).toHaveLength(LOG_FRAME_CELLS);
    expect(rows.every((row) => row.length === LOG_FRAME_CELLS)).toBe(true);
    expect(rows[0]?.[0]).toBe(".");
    expect(rows[0]?.[8]).toBe("O");
  });

  it("cuts into four square corners and four 6-cell edges, each sized to its art", () => {
    const pieces = logFramePieces();
    expect(pieces).toHaveLength(8);
    for (const piece of pieces) {
      expect(piece.rows).toHaveLength(piece.height);
      expect(piece.rows.every((row) => row.length === piece.width)).toBe(true);
    }
    expect(pieces.slice(0, 4).every((p) => p.width === LOG_CORNER_CELLS)).toBe(true);
    expect(pieces.slice(4, 6).map((p) => [p.width, p.height])).toEqual([
      [6, 5],
      [6, 5],
    ]);
    expect(pieces.slice(6).map((p) => [p.width, p.height])).toEqual([
      [5, 6],
      [5, 6],
    ]);
  });

  it("draws the top edge exactly like the beam, so they match", () => {
    expect(logFramePieces()[4]?.rows).toEqual(logBeamRows());
  });

  it("tiles the beam with the same five rings as the frame's edge", () => {
    const beam = logBeamRows();
    const edge = logFrameRows().map((row) => row[8]);
    expect(beam.map((row) => row[0])).toEqual(edge.slice(0, 5));
  });
});

describe("display helpers", () => {
  it("formats release dates without timezone drift", () => {
    expect(shortDate("2026-10-07")).toBe("Oct 7");
    expect(shortDate("not a date")).toBe("not a date");
  });

  it("lays out the pixel version as five equal rows", () => {
    const rows = pixelText("v0.8");
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((r) => r.length)).size).toBe(1);
    expect(rows[0]).toBe("....###...###");
  });
});
