import { GLYPH_H, GLYPHS } from "./goal-world-font";
import { hashKey, renderPixelGrid } from "./critter-sprites";
import { seeded } from "./whatsnew-content";

/**
 * Art for the home screen's update key (HomeUpdateButton): the
 * key's pixel plate and its side, the bobbing arrow, a sparkle, words in the
 * Goal world's pixel font, and the burst it goes off in at 100%. Colours are
 * art, not theme roles (like Ken's storybook art), so the key looks the same
 * in both themes. Everything here is computed once and deterministic.
 */

/** "%" for the XP readout; the Goal world's font has no percent sign. */
const EXTRA_GLYPHS: Readonly<Record<string, readonly string[]>> = {
  "%": ["#.#", "..#", ".#.", "#..", "#.#"],
};

export interface PixelCell {
  readonly col: number;
  readonly row: number;
  /** 0 at the word's left edge to 1 at its right, for a colour sweep. */
  readonly t: number;
}

export interface PixelWord {
  readonly cells: readonly PixelCell[];
  readonly cols: number;
  readonly rows: number;
}

/** `text` in the Goal world's 3x5 pixel font, one blank column between glyphs. */
export function pixelWord(text: string): PixelWord {
  const glyphs = [...text.toUpperCase()].map(
    (ch) => EXTRA_GLYPHS[ch] ?? GLYPHS[ch] ?? GLYPHS["?"] ?? [],
  );
  const cols = glyphs.reduce((sum, glyph, i) => sum + (glyph[0]?.length ?? 0) + (i > 0 ? 1 : 0), 0);
  const cells: PixelCell[] = [];
  let x = 0;
  glyphs.forEach((glyph, i) => {
    if (i > 0) x += 1;
    glyph.forEach((line, row) => {
      [...line].forEach((ch, col) => {
        if (ch !== "#") return;
        const at = x + col;
        cells.push({ col: at, row, t: cols > 1 ? at / (cols - 1) : 0 });
      });
    });
    x += glyph[0]?.length ?? 0;
  });
  return { cells, cols, rows: GLYPH_H };
}

/** Where each lit cell of a word starts before it flies into place. */
export interface CellFlight {
  readonly dx: number;
  readonly dy: number;
  readonly rot: number;
  /** Start delay, in seconds. */
  readonly delay: number;
}

/** A seeded scatter for a word's cells: the same word always flies the same way. */
export function cellFlights(word: PixelWord, key: string, spread: number): CellFlight[] {
  const rand = seeded(hashKey(key));
  return word.cells.map(() => ({
    dx: (rand() - 0.5) * spread * 2,
    dy: (rand() - 0.5) * spread,
    rot: (rand() - 0.5) * 540,
    delay: rand() * 0.35,
  }));
}

export interface BurstPiece {
  readonly dx: number;
  readonly dy: number;
  readonly size: number;
  readonly color: string;
  readonly delay: number;
}

const BURST_COLORS = ["#ffd23a", "#3ddc84", "#fff7d6", "#9adfff"] as const;

/**
 * The pixels a key goes off in when the update lands: a ring, flung outwards.
 * `squash` scales the vertical reach, for a bar too short for a full ring.
 */
export function burstPieces(count = 18, squash = 1): BurstPiece[] {
  const rand = seeded(hashKey("update-key-burst"));
  return Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * Math.PI * 2 + (rand() - 0.5) * 0.4;
    const reach = 46 + rand() * 40;
    return {
      dx: Math.round(Math.cos(angle) * reach * 1.9),
      dy: Math.round(Math.sin(angle) * reach * 0.8 * squash),
      size: rand() < 0.35 ? 6 : 4,
      color: BURST_COLORS[i % BURST_COLORS.length] ?? "#ffd23a",
      delay: rand() * 0.08,
    };
  });
}

/**
 * A pixel grid as an SVG with its own size (one unit per cell), so CSS
 * `border-image-slice` can count in cells. renderPixelGrid leaves the size
 * off, which border-image can't slice.
 */
function sizedPixelSvg(rows: readonly string[], palette: Readonly<Record<string, string>>): string {
  const width = rows[0]?.length ?? 0;
  const src = renderPixelGrid(rows, palette, { width, height: rows.length });
  return src.replace(
    encodeURIComponent("<svg "),
    encodeURIComponent(`<svg width="${width}" height="${rows.length}" `),
  );
}

/**
 * The key's plate as a 9-slice, 12x12 cells (slice 4): a dark outline with
 * stepped corners, a gold rim lit top-left and shaded bottom-right, a lighter
 * inner edge on top and left, and the deep indigo face.
 */
export const PLATE_ROWS = [
  "..KKKKKKKK..",
  ".KYYYYYYYYK.",
  "KYYHHHHHHYyK",
  "KYHFFFFFFFyK",
  "KYHFFFFFFFyK",
  "KYHFFFFFFFyK",
  "KYHFFFFFFFyK",
  "KYHFFFFFFFyK",
  "KYFFFFFFFFyK",
  "KyyFFFFFFyyK",
  ".KyyyyyyyyK.",
  "..KKKKKKKK..",
] as const;

export const PLATE_PALETTE = {
  K: "#0b0820",
  Y: "#ffd23a",
  y: "#b8861f",
  H: "#3d3496",
  F: "#221b5e",
} as const;

/** The key's side, seen under the plate: the same shape in dark gold. */
const BASE_PALETTE = {
  K: "#0b0820",
  Y: "#8f6216",
  y: "#5c3b0a",
  H: "#7a5212",
  F: "#7a5212",
} as const;

export const PLATE_SRC = sizedPixelSvg(PLATE_ROWS, PLATE_PALETTE);
export const BASE_SRC = sizedPixelSvg(PLATE_ROWS, BASE_PALETTE);

/** The up arrow on the key: green, outlined, lit on its left edge. 9x9. */
const ARROW_ROWS = [
  "....O....",
  "...OLO...",
  "..OLGGO..",
  ".OLGGGGO.",
  "OLGGGGGGO",
  "OOOLGGOOO",
  "..OLGGO..",
  "..OLGGO..",
  "..OOOOO..",
] as const;
export const ARROW_SRC = renderPixelGrid(
  ARROW_ROWS,
  { O: "#0b3d22", L: "#b6ffd6", G: "#3ddc84" },
  { width: 9, height: 9 },
);

/** A four-point twinkle. 5x5. */
const SPARKLE_ROWS = ["..Y..", "..Y..", "YYWYY", "..Y..", "..Y.."] as const;
export const SPARKLE_SRC = renderPixelGrid(
  SPARKLE_ROWS,
  { Y: "#ffd23a", W: "#fffbe0" },
  { width: 5, height: 5 },
);
