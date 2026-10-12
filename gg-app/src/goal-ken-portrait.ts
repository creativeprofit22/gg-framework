// Little Ken's dialogue portrait for the Workers view (see KenDialogue): the
// farm's Ken (KEN_FARM_CRITTER) drawn bigger and front-on, still a chibi. A
// round mochi head with a flat jaw, a short dark buzzcut, a black tee, and a
// touch of bad boy: a slit in his right brow, a plaster on his cheek, a smirk
// for his resting face. 36×44 cells: head, shoulders and chest (the dialogue
// box covers the rest), with room on the right for a ! ? or sparkle.
//
// The bust is fixed art; each of the ten faces is small grids of brows, eyes
// and mouth set on it, plus a second mouth for talking. Drawn from the design
// study in mockups/ken-dialogue. Colours are art, not theme roles.

import type { KenFace } from "./goal-ken-talk";

/** Portrait size, in cells (one canvas pixel each; scale it in CSS). */
export const KEN_PORTRAIT_W = 36;
export const KEN_PORTRAIT_H = 44;

const PALETTE: Readonly<Record<string, string>> = {
  O: "#17100d", // outline
  T: "#2e2522", // buzzcut
  H: "#5a4a41", // buzzcut flecks
  h: "#1c1512", // buzzcut shade
  B: "#f7dcc4", // skin
  D: "#e6bc9c", // skin shade
  K: "#1d1418", // eyes
  W: "#ffffff", // eye light
  C: "#f4a99e", // blush
  M: "#a84a42", // mouth
  m: "#5e1f1c", // mouth inside
  t: "#ee7f86", // tongue
  P: "#fbf1e0", // plaster
  p: "#c9a07a", // plaster pad
  S: "#26262d", // tee
  U: "#3b3b46", // tee, lit
  s: "#17171c", // tee, shade
  c: "#0c0c0f", // collar
  Y: "#ffd23a", // sparkles, !
  G: "#fffbe0", // sparkle light
  E: "#9adfff", // water (sweat, tears)
  e: "#3d8fd6", // water edge
  w: "#fff8e8", // marks (?)
};

const BUST: readonly string[] = [
  "....................................",
  ".........OOOOOOOOOOOOOO.............",
  ".......OOTTTTTTHTTTTTTTOO...........",
  "......OTTHTTTTTTTTHTTTTTTO..........",
  ".....OTTTTTTHTTTTTTTTTTTTTO.........",
  "....OTHTTTTTTTTHTTTTTTTThhhO........",
  "....OTTTTHTTTTTTTTHTTTTThhhO........",
  "...OTTTTTTTTHTTTTTTTTTTThhhhO.......",
  "...OTTTTTTTTTTTTTTTTTTTThhhhO.......",
  "...OTTTTTTTTDDDDDDDDTTTThhhhO.......",
  "...OTTDDDDDDBBBBBBBBDDDDDDhhO.......",
  "...OTTBBBBBBBBBBBBBBBBBBBBhhO.......",
  "...OTTBBBBBBBBBBBBBBBBBBBBhhO.......",
  "...OTTBBBBBBBBBBBBBBBBBBBBhhO.......",
  "...OTTBBBBBBBBBBBBBBBBBBBBhhO.......",
  "...ODDBBBBBBBBBBBBBBBBBBBBDDO.......",
  "...OBBBBBBBBBBBBBBBBBBBBBBBDO.......",
  "...OBBBBBBBBBBBBBBBBBBBBBBDDO.......",
  "...OBBBBBBBBBBBBBBBBBBBBBBDDO.......",
  "...ODDBBBBBBBBBBBBBBBBBBBBDDO.......",
  "....ODDBBBBBBBBBBBBBBBBBBDDO........",
  ".....ODDDBBBBBBBBBBBBBBDDDO.........",
  "......ODDDDDDDDDDDDDDDDDDO..........",
  ".......OOOOODDDDDDDDOOOOO...........",
  "............OOOOOOOO................",
  "............ODDDDDDO................",
  "........OOOOODDDDDDOOOOO............",
  ".....OOOUSSSccccccccSSSSOOO.........",
  "...OOUUUUSSSScSSSScSSSSSsssOO.......",
  "..OUUUUUUSSSSSSSSSSSSSSSsssssO......",
  "..OUUUUUUSSSSSSSSSSSSSSSsssssO......",
  ".OUUUUUUUSSSSSSSSSSSSSSSssssssO.....",
  ".OUUUUUUUSSSSSSSSSSSSSSSssssssO.....",
  ".OUUUOUUUSSSSSSSSSSSSSSSssOsssO.....",
  ".OUUUOUUUSSSSSSSSSSSSSSSssOsssO.....",
  ".OUUUOUUUSSSSSSSSSSSSSSSssOsssO.....",
  ".OUUUOUUUSSSSSSSSSSSSSSSssOsssO.....",
  ".OOOOOUUUSSSSSSSSSSSSSSSssOOOOO.....",
  ".OBBBOUUUSSSSSSSSSSSSSSSssODDDO.....",
  ".OBBBOUUUSSSSSSSSSSSSSSSssODDDO.....",
  ".OBBBOUUUSSSSSSSSSSSSSSSssODDDO.....",
  ".OBBBOUUUSSSSSSSSSSSSSSSssODDDO.....",
  ".OBBBOUUUSSSSSSSSSSSSSSSssODDDO.....",
  ".OBBBOUUUSSSSSSSSSSSSSSSssODDDO.....",
];

type Part = readonly [x: number, y: number, rows: readonly string[]];

export interface KenPortraitOptions {
  /** His other mouth (he's mid-word). */
  readonly talk?: boolean;
  /** Open eyes shut for a blink. */
  readonly blink?: boolean;
  /** Leave off the marks round his head (on light paper they don't read). */
  readonly plain?: boolean;
}

interface FaceArt {
  readonly eyes: readonly Part[];
  readonly brows: readonly Part[];
  readonly mouth: Part;
  /** His other mouth, swapped in and out while he talks. */
  readonly talk: Part;
  /** Open eyes, so he blinks now and then. */
  readonly blink: boolean;
  /** 0 none, 1 a little, 2 a lot. */
  readonly blush: number;
  /** Marks round his head (sparkles, ? !, sweat, a tear), outlined. */
  readonly extras: readonly Part[];
}

const SPARKLE = ["..w..", "..Y..", "wYGYw", "..Y..", "..w.."];
const QUESTION = [".www.", "w...w", "....w", "..ww.", "..w..", ".....", "..w.."];
const BANG = ["YY", "YY", "YY", "YY", "..", "YY"];
const SWEAT = [".e.", "eEe", "EWE", "EEe", ".e."];
const TEAR = ["E", "E", "e"];

const FACES: Readonly<Record<KenFace, FaceArt>> = {
  neutral: {
    eyes: [
      [10, 14, ["KKK", "WKK", "KKK"]],
      [20, 14, ["KKK", "WKK", "KKK"]],
    ],
    brows: [
      [9, 12, ["TTTT"]],
      [20, 12, ["TT.T"]],
    ],
    mouth: [14, 19, ["...M", "MMM."]],
    talk: [14, 19, [".MM.", "MmmM", ".MM."]],
    blink: true,
    blush: 0,
    extras: [],
  },
  happy: {
    eyes: [
      [10, 15, [".K.", "K.K"]],
      [20, 15, [".K.", "K.K"]],
    ],
    brows: [
      [9, 11, ["TTTT"]],
      [20, 11, ["TT.T"]],
    ],
    mouth: [13, 19, ["MMMMMM", "MmttmM", ".MMMM."]],
    talk: [13, 19, ["M....M", ".MMMM."]],
    blink: false,
    blush: 2,
    extras: [],
  },
  excited: {
    eyes: [
      [10, 13, ["KKK", "WKK", "KKW", "KKK"]],
      [20, 13, ["KKK", "WKK", "KKW", "KKK"]],
    ],
    brows: [
      [9, 10, ["TTTT"]],
      [20, 10, ["TT.T"]],
    ],
    mouth: [13, 19, ["MMMMMM", "MmmmmM", "MmttmM", ".MMMM."]],
    talk: [13, 19, ["MMMMMM", "MmttmM", ".MMMM."]],
    blink: true,
    blush: 2,
    extras: [
      [0, 2, SPARKLE],
      [30, 7, SPARKLE],
      [28, 0, SPARKLE],
    ],
  },
  thinking: {
    eyes: [
      [10, 14, ["KKW", "KKK", "KKK"]],
      [20, 14, ["KKW", "KKK", "KKK"]],
    ],
    brows: [
      [9, 12, ["TTTT"]],
      [20, 11, ["TT.T"]],
    ],
    mouth: [16, 19, ["MM"]],
    talk: [15, 19, [".M.", "MmM", ".M."]],
    blink: true,
    blush: 0,
    extras: [[30, 0, QUESTION]],
  },
  focused: {
    eyes: [
      [10, 15, ["KKK", "WKK"]],
      [20, 15, ["KKK", "WKK"]],
    ],
    brows: [
      [9, 12, ["TT..", "..TT"]],
      [20, 12, ["..TT", "TT.."]],
    ],
    mouth: [14, 19, ["MMMM"]],
    talk: [14, 19, ["MMMM", "MmmM"]],
    blink: true,
    blush: 0,
    extras: [],
  },
  surprised: {
    eyes: [
      [10, 13, [".K.", "KWK", "KKK", "KKK", ".K."]],
      [20, 13, [".K.", "KWK", "KKK", "KKK", ".K."]],
    ],
    brows: [
      [9, 9, ["TTTT"]],
      [20, 9, ["TT.T"]],
    ],
    mouth: [14, 19, [".MM.", "MmmM", "MmmM", ".MM."]],
    talk: [14, 19, [".MM.", "MmmM", ".MM."]],
    blink: true,
    blush: 1,
    extras: [[31, 1, BANG]],
  },
  worried: {
    eyes: [
      [10, 14, ["KKK", "WKK", "KKK"]],
      [20, 14, ["KKK", "WKK", "KKK"]],
    ],
    brows: [
      [9, 11, ["..TT", "TT.."]],
      [20, 11, ["TT..", "..TT"]],
    ],
    mouth: [13, 20, [".MMMM.", "M....M"]],
    talk: [14, 19, [".MM.", "MmmM"]],
    blink: true,
    blush: 0,
    extras: [[29, 8, SWEAT]],
  },
  sad: {
    eyes: [
      [10, 15, ["KKK", "KKK", "WKK"]],
      [20, 15, ["KKK", "KKK", "WKK"]],
    ],
    brows: [
      [9, 12, ["..TT", "TT.."]],
      [20, 12, ["TT..", "..TT"]],
    ],
    mouth: [13, 20, [".MMMM.", "M....M"]],
    talk: [13, 20, [".MMMM.", "MmmmmM"]],
    blink: true,
    blush: 0,
    extras: [[10, 17, TEAR]],
  },
  proud: {
    eyes: [
      [10, 15, ["OOO", "KKK"]],
      [20, 15, ["OOO", "KKK"]],
    ],
    brows: [
      [9, 11, ["TTTT"]],
      [20, 11, ["TT.T"]],
    ],
    mouth: [13, 19, [".....M", "MMMMM."]],
    talk: [13, 19, ["MMMMMM", ".mmmmM"]],
    blink: false,
    blush: 0,
    extras: [[30, 7, SPARKLE]],
  },
  wink: {
    eyes: [
      [10, 14, ["KKK", "WKK", "KKK"]],
      [20, 15, ["K.K", ".K."]],
    ],
    brows: [
      [9, 12, ["TTTT"]],
      [20, 12, ["TT.T"]],
    ],
    mouth: [13, 19, ["M....M", ".MMMM."]],
    talk: [13, 19, ["M....M", ".MmmM."]],
    blink: false,
    blush: 1,
    extras: [[30, 9, SPARKLE]],
  },
};

/** The plaster on his right cheek, on every face. */
const PLASTER: Part = [22, 17, ["PPPP", "PppP", "PPPP"]];

function put(grid: (string | null)[][], [x0, y0, rows]: Part): void {
  rows.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      const key = row[c];
      const line = grid[y0 + r];
      if (!key || key === "." || !line || x0 + c >= line.length) continue;
      line[x0 + c] = key;
    }
  });
}

/** Ken's cells for one face: palette keys, null where he isn't. */
export function kenPortraitCells(
  face: KenFace,
  options: KenPortraitOptions = {},
): ReadonlyArray<ReadonlyArray<string | null>> {
  const art = FACES[face];
  const grid = BUST.map((row) => [...row].map((key) => (key === "." ? null : key)));
  if (art.blush > 0) put(grid, [art.blush > 1 ? 7 : 8, 18, [art.blush > 1 ? "CCC" : "CC"]]);
  put(grid, PLASTER);
  for (const brow of art.brows) put(grid, brow);
  for (const eye of art.eyes) {
    const [x, y, rows] = eye;
    const width = rows[0]?.length ?? 0;
    // A blink: open eyes shut to one line where their lower lid was.
    if (options.blink && art.blink) put(grid, [x, y + rows.length - 1, ["K".repeat(width)]]);
    else put(grid, eye);
  }
  put(grid, options.talk ? art.talk : art.mouth);
  if (art.extras.length > 0 && !options.plain) {
    const layer: (string | null)[][] = BUST.map((row) => Array.from(row, () => null));
    for (const extra of art.extras) put(layer, extra);
    // Each mark gets its own outline, never drawn over Ken himself.
    const marks = layer.map((row) => [...row]);
    for (let y = 0; y < KEN_PORTRAIT_H; y++) {
      for (let x = 0; x < KEN_PORTRAIT_W; x++) {
        if (marks[y]?.[x] || BUST[y]?.[x] !== ".") continue;
        const near =
          marks[y - 1]?.[x] || marks[y + 1]?.[x] || marks[y]?.[x - 1] || marks[y]?.[x + 1];
        if (near && layer[y]) layer[y][x] = "O";
      }
    }
    for (let y = 0; y < KEN_PORTRAIT_H; y++) {
      for (let x = 0; x < KEN_PORTRAIT_W; x++) {
        const key = layer[y]?.[x];
        const row = grid[y];
        if (!key || !row || (key === "O" && row[x])) continue;
        row[x] = key;
      }
    }
  }
  return grid;
}

/** Paint Ken with `face` onto `canvas` at one canvas pixel per cell. */
export function drawKenPortrait(
  canvas: HTMLCanvasElement,
  face: KenFace,
  options: KenPortraitOptions = {},
): void {
  if (canvas.width !== KEN_PORTRAIT_W) canvas.width = KEN_PORTRAIT_W;
  if (canvas.height !== KEN_PORTRAIT_H) canvas.height = KEN_PORTRAIT_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, KEN_PORTRAIT_W, KEN_PORTRAIT_H);
  kenPortraitCells(face, options).forEach((row, y) => {
    row.forEach((key, x) => {
      const colour = key ? PALETTE[key] : undefined;
      if (!colour) return;
      ctx.fillStyle = colour;
      ctx.fillRect(x, y, 1, 1);
    });
  });
}
