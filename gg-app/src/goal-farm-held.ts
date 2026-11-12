// What a farm critter holds while it works, and what it does with it, drawn
// for the farm's high camera: we look down on an open book's pages, into a
// teacup, onto a letter's flap. Each tool is a small outlined sprite with its
// own light and shade, posed by the moment (a mallet raised, then struck; a
// fan swept to and fro), with the effect of the work on top (a page turning
// over, wood chips, sparks, steam, a line of writing). Also the paper lantern
// (chōchin) a critter carries after dark.
//
// Everything is drawn for a critter facing east; facing west mirrors it about
// the critter's centre. (x, y) is always the critter's feet.

import type { WorkKind } from "./goal-world-agents";
import type { Spot } from "./goal-farm-travel";

type Ctx = CanvasRenderingContext2D;

/** The outline every held thing shares with the critters. */
const INK = "#2a1406";

const PALETTE: Readonly<Record<string, string>> = {
  o: INK,
  // Paper, its shade, and lines of writing.
  W: "#fbf4e2",
  S: "#e2d3b2",
  L: "#a8957a",
  // A book's red cloth cover, and its dark edge.
  R: "#c0462e",
  r: "#7e2616",
  // Wood: a mallet's lit head, its shade, and a pale handle.
  H: "#d49a5a",
  h: "#9a6232",
  w: "#e8c890",
  // Bamboo.
  b: "#c8a85a",
  B: "#8a6a2c",
  // A fan's red sun.
  F: "#d8394a",
  // A teacup's glaze, its rim, and the tea.
  C: "#6f8aa0",
  c: "#4c6478",
  T: "#9ab048",
  t: "#c4d47a",
  // A wax seal.
  X: "#b02a2a",
  // A pencil-brush's ink tip, and fresh ink on paper.
  K: "#141008",
  k: "#4a3a2a",
  // A writing board.
  D: "#a0703a",
  d: "#6e4a22",
  // Porcelain: its glaze and a blue band.
  P: "#f2ece0",
  p: "#c8c0b0",
  U: "#4a78a8",
};

/** Draw `rows` (palette keys, "." clear) with its anchor column/row at (ax, ay), mirrored if facing west. */
function sprite(
  ctx: Ctx,
  rows: readonly string[],
  x: number,
  y: number,
  facing: 1 | -1,
  anchorCol = 0,
  anchorRow = 0,
): void {
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] ?? "";
    for (let c = 0; c < row.length; c++) {
      const color = PALETTE[row[c] ?? "."];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(Math.round(x + (c - anchorCol) * facing), Math.round(y + r - anchorRow), 1, 1);
    }
  }
}

/** One pixel at (dx, dy) from the critter's feet, mirrored for its facing. */
function dot(
  ctx: Ctx,
  color: string,
  x: number,
  y: number,
  facing: 1 | -1,
  dx: number,
  dy: number,
  alpha = 1,
): void {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x + dx * facing), Math.round(y + dy), 1, 1);
  ctx.globalAlpha = 1;
}

/** 0–1 through a cycle of `ms`, offset by `phase` (0–1). */
function cycle(now: number, ms: number, phase = 0): number {
  return (((now / ms + phase) % 1) + 1) % 1;
}

// ── The tools ───────────────────────────────────────────────────

/** An open book seen from above: two pages either side of the spine, the cover's edge below. */
const BOOK = [
  ".oooo.oooo.",
  "oWWWWoWWWWo",
  "oWkkWoWkkWo",
  "oWWWSoSWWWo",
  "oWkkWoWkWWo",
  "oRWWWoWWWRo",
  ".rrrrrrrrr.",
];
/** A page lifting off the right-hand side, mid-turn, standing over the spine. */
const PAGE_UP = ["..ooo", ".oWWo", "oWWSo", "oWWSo", ".ooo."];

/** A wooden mallet raised: the handle upright, the head across its top. */
const MALLET_UP = [
  "ooooooo",
  "oHHHHho",
  "ohhhhho",
  "ooooooo",
  "...ow..",
  "...ow..",
  "...ow..",
  "...ow..",
];
/** The same mallet brought down: the handle out flat, the head end-on against the work. */
const MALLET_DOWN = [".....oooo", "oooooHHho", "wwwwwHhho", ".....hhho", ".....oooo"];

/** A round paper fan (uchiwa) face-on, a red sun on it, on a bamboo handle. */
const FAN_OPEN = [
  ".ooooo.",
  "oWWWWWo",
  "oWWFFWo",
  "oWFFFWo",
  "oWWFWWo",
  ".ooooo.",
  "...b...",
  "...b...",
];
/** The same fan swept edge-on. */
const FAN_EDGE = [".oo.", "oWWo", "oFWo", "oFFo", "oWWo", ".oo.", ".b..", ".b.."];

/** A teacup (yunomi) seen from above: green tea in a blue-grey glaze. */
const CUP = [".oooo.", "oPttPo", "oTTTTo", "oUUUUo", "opPPpo", ".oooo."];

/** An envelope, its flap folded down to a red wax seal. */
/** An envelope seen from above, its flap folded down to a red wax seal. */
const LETTER = ["oooooooo", "oSWWWWSo", "oWSWWSWo", "oWWSSWWo", "oWWXXWWo", "oooooooo"];

/** A speech bubble with a "?" in it, lifting off a held letter. */
const ASK_BUBBLE = [".ooooo.", "oWWkWWo", "oWkWkWo", "oWWWkWo", "oWWkWWo", ".ooWoo.", "..oo..."];

/** A thought cloud above the head, room for three dots across its middle. */
const THOUGHT = ["..ooooo..", ".oWWWWWo.", "oWWWWWWWo", "oWWWWWWWo", ".oWWWWWo.", "..ooooo.."];

/**
 * A critter at work: what it holds, and what it's doing with it, so each job
 * reads at a glance. Reading turns the pages of an open book; searching casts
 * a bamboo rod into the pond and waits on the float; at the laptop the
 * screen's glow plays on its face; editing raises a mallet and brings it
 * down, chips flying; running fans the stove's fire, sparks rising; planning
 * writes line after line on a sheet; asking holds up a sealed letter; waiting
 * sips tea, steam curling up.
 */
export function drawFarmWork(
  ctx: Ctx,
  kind: WorkKind,
  x: number,
  y: number,
  facing: 1 | -1,
  now: number,
  look: Spot | undefined,
): void {
  switch (kind) {
    case "read":
      return drawReading(ctx, x, y, facing, now);
    case "search":
      return drawFishing(ctx, x, y, facing, now, look);
    case "edit":
      return drawHammering(ctx, x, y, facing, now);
    case "run":
      return drawFanning(ctx, x, y, facing, now, look);
    case "web":
      return drawScreenGlow(ctx, x, y, facing, now);
    case "think":
      return drawWriting(ctx, x, y, facing, now);
    case "ask":
      return drawLetter(ctx, x, y, facing, now);
    case "wait":
      return drawTea(ctx, x, y, facing, now);
    default:
      return;
  }
}

/** The book held open in front, a page turning over every few seconds. */
function drawReading(ctx: Ctx, x: number, y: number, facing: 1 | -1, now: number): void {
  // Held open in front, below its face, so it looks down into it.
  const bx = x;
  const by = y - 5;
  sprite(ctx, BOOK, bx, by, facing, 5, 0);
  const t = cycle(now, 3200);
  if (t > 0.78 && t < 0.86) {
    // The page lifts and stands over the spine…
    sprite(ctx, PAGE_UP, bx, by - 2, facing, 1, 0);
  } else if (t >= 0.86 && t < 0.92) {
    // …and settles on the left, a shadow line where it lands.
    for (let r = 1; r <= 4; r++) dot(ctx, PALETTE.S ?? INK, bx, by, facing, -2, r);
  }
}

/** A bamboo rod out over the water, its line sagging to a float that bobs and, now and then, dips. */
function drawFishing(
  ctx: Ctx,
  x: number,
  y: number,
  facing: 1 | -1,
  now: number,
  look: Spot | undefined,
): void {
  if (!look) return;
  const nibble = cycle(now, 5200) > 0.82;
  // The rod: from the hands up and out, bending a touch at the tip, its
  // joints darker every third pixel.
  const len = 13;
  let tipX = x;
  let tipY = y;
  for (let k = 0; k < len; k++) {
    const f = k / (len - 1);
    const bend = nibble ? f * f * 2 : f * f;
    const px = Math.round(x + facing * (5 + k));
    const py = Math.round(y - 3 - k * 0.9 + bend);
    // Outlined along its underside where it's thick, near the hands.
    if (k < 5) {
      ctx.fillStyle = INK;
      ctx.fillRect(px, py + 1, 1, 1);
    }
    ctx.fillStyle = k % 3 === 2 ? (PALETTE.B ?? INK) : (PALETTE.b ?? INK);
    ctx.fillRect(px, py, 1, 1);
    tipX = px;
    tipY = py;
  }
  // The grip, wrapped dark, in its hands at its side.
  ctx.fillStyle = INK;
  ctx.fillRect(Math.round(x + facing * 4), Math.round(y - 3), 1, 2);
  ctx.fillStyle = PALETTE.d ?? INK;
  ctx.fillRect(Math.round(x + facing * 5), Math.round(y - 2), 1, 1);
  // The float: red over white, sitting on the water, pulled under on a nibble.
  const fx = Math.round(look.x + Math.sin(now / 1100) * 2);
  const fy = Math.round(look.y + (nibble ? 1 : Math.sin(now / 400) > 0.6 ? 0.5 : 0));
  // The line: a fine pale thread with a gentle sag.
  const steps = Math.max(2, Math.ceil(Math.hypot(fx - tipX, fy - tipY)));
  ctx.globalAlpha = 0.75;
  ctx.fillStyle = "#e8e4d8";
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const sag = Math.sin(t * Math.PI) * (nibble ? 1 : 3);
    ctx.fillRect(
      Math.round(tipX + (fx - tipX) * t),
      Math.round(tipY + (fy - tipY) * t + sag),
      1,
      1,
    );
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = INK;
  ctx.fillRect(fx - 1, fy - 2, 3, 1);
  ctx.fillStyle = PALETTE.F ?? INK;
  ctx.fillRect(fx - 1, fy - 1, 3, 1);
  if (!nibble) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(fx - 1, fy, 3, 1);
  }
  // Rings spreading where it bobs.
  const ring = cycle(now, 1600);
  const spread = 2 + Math.floor(ring * 4) + (nibble ? 1 : 0);
  ctx.globalAlpha = 0.55 * (1 - ring);
  ctx.fillStyle = "#daefe2";
  ctx.fillRect(fx - spread, fy + 1, 1, 1);
  ctx.fillRect(fx + spread, fy + 1, 1, 1);
  ctx.fillRect(fx - spread + 1, fy + 2, spread * 2 - 1, 1);
  ctx.globalAlpha = 1;
}

/** A mallet raised slowly, brought down hard on the bench, chips and dust flying off it. */
function drawHammering(ctx: Ctx, x: number, y: number, facing: 1 | -1, now: number): void {
  const t = cycle(now, 1100);
  const struck = t > 0.6;
  const hx = x + facing * 5;
  const hy = y - 4;
  if (struck) {
    sprite(ctx, MALLET_DOWN, hx, hy, facing, 0, 2);
    // Chips and a puff of sawdust off the bench, flying up and falling back.
    const k = (t - 0.6) / 0.4;
    const ix = 7;
    const lift = Math.sin(k * Math.PI) * 4;
    const ex = (dx: number): number => dx + k * Math.sign(dx) * 3;
    dot(ctx, PALETTE.w ?? INK, hx, hy, facing, ix + ex(1), -2 - lift);
    dot(ctx, PALETTE.H ?? INK, hx, hy, facing, ix + ex(-1), -1 - lift * 0.7);
    dot(ctx, PALETTE.h ?? INK, hx, hy, facing, ix + ex(2), -lift * 0.5);
    if (k < 0.4) {
      // The blow lands: a flash of pale dust at the head.
      dot(ctx, "#fff4dc", hx, hy, facing, 9, 3, 0.8);
      dot(ctx, "#fff4dc", hx, hy, facing, 10, 2, 0.6);
      dot(ctx, "#fff4dc", hx, hy, facing, 9, 1, 0.5);
    }
  } else {
    // Raised over the shoulder: it climbs a pixel as the blow gathers.
    const rise = t > 0.3 ? 1 : 0;
    sprite(ctx, MALLET_UP, hx, hy - rise, facing, 3, 7);
  }
}

/** A paper fan swept to and fro at the stove, sparks lifting off the fire with each stroke. */
function drawFanning(
  ctx: Ctx,
  x: number,
  y: number,
  facing: 1 | -1,
  now: number,
  look: Spot | undefined,
): void {
  const open = Math.floor(now / 170) % 2 === 0;
  const fx = x + facing * 8;
  const fy = y - 2;
  if (open) sprite(ctx, FAN_OPEN, fx, fy, facing, 3, 7);
  else sprite(ctx, FAN_EDGE, fx + facing, fy, facing, 1, 7);
  // Sparks rising off the fire it fans, drifting and going out.
  const sx = look?.x ?? x + facing * 12;
  const sy = look?.y ?? y - 6;
  for (let i = 0; i < 4; i++) {
    const p = cycle(now, 1300, i / 4);
    const px = Math.round(sx + Math.sin(p * 7 + i * 2) * 2 + (i - 1.5));
    const py = Math.round(sy - 2 - p * 10);
    ctx.globalAlpha = 1 - p;
    ctx.fillStyle = p < 0.4 ? "#ffe08a" : "#ff8a3a";
    ctx.fillRect(px, py, 1, 1);
  }
  ctx.globalAlpha = 1;
}

/** At the laptop: the screen's cool light flickering on the critter's face as it types. */
function drawScreenGlow(ctx: Ctx, x: number, y: number, facing: 1 | -1, now: number): void {
  const flick = Math.floor(now / 260) % 3;
  ctx.globalAlpha = 0.3 + flick * 0.06;
  ctx.fillStyle = "#bfe4ff";
  for (let r = 0; r < 4; r++)
    ctx.fillRect(Math.round(x + facing * 6), Math.round(y - 11 + r), 1, 1);
  ctx.fillRect(Math.round(x + facing * 5), Math.round(y - 13), 1, 2);
  ctx.globalAlpha = 1;
}

/**
 * Planning, at the board: nothing in its hands, just a thought bubble over
 * its head with three dots coming in one after another, steady and slow
 * (like someone typing), then starting over. Distinct from reading (a book)
 * and from asking (a letter).
 */
function drawWriting(ctx: Ctx, x: number, y: number, facing: 1 | -1, now: number): void {
  const tx = x + facing * 3;
  const ty = y - 21 + Math.round(Math.sin(now / 900) * 0.5);
  // The little puffs leading up from the head to the cloud.
  dot(ctx, INK, tx, ty, facing, -2, 9);
  dot(ctx, "#ffffff", tx, ty, facing, -2, 8);
  dot(ctx, "#ffffff", tx, ty, facing, -1, 7);
  sprite(ctx, THOUGHT, tx, ty, facing, 0, 0);
  // One, two, three dots, a beat each, then a short rest with all three.
  const shown = Math.min(3, Math.floor(cycle(now, 2400) * 4) + 1);
  for (let i = 0; i < shown; i++) dot(ctx, PALETTE.k ?? INK, tx, ty, facing, 2 + i * 2, 3);
}

/**
 * Asking: an envelope held out in both hands, bobbing gently with breath,
 * and now and then a speech bubble with a "?" lifting off it.
 */
function drawLetter(ctx: Ctx, x: number, y: number, facing: 1 | -1, now: number): void {
  const bob = Math.round(Math.sin(now / 520) * 0.6);
  const lx = x + facing * 5;
  const ly = y - 7 + bob;
  sprite(ctx, LETTER, lx, ly, facing, 0, 0);
  const q = cycle(now, 4200);
  if (q < 0.4) {
    const rise = q / 0.4;
    ctx.globalAlpha = rise < 0.7 ? 1 : 1 - (rise - 0.7) / 0.3;
    sprite(ctx, ASK_BUBBLE, lx + facing * 4, ly - 8 - Math.round(rise * 3), facing, 0, 0);
    ctx.globalAlpha = 1;
  }
}

/** A teacup held to the chest, steam curling up off it, lifted to sip now and then. */
function drawTea(ctx: Ctx, x: number, y: number, facing: 1 | -1, now: number): void {
  const sip = cycle(now, 6000) > 0.85;
  const cx = x + facing * (sip ? 4 : 5);
  const cy = y - (sip ? 8 : 6);
  sprite(ctx, CUP, cx, cy, facing, 0, 0);
  if (sip) return;
  // Three wisps, each rising and swaying, thinning as it goes.
  for (let i = 0; i < 3; i++) {
    const p = cycle(now, 1800, i / 3);
    const sway = Math.sin(p * 5 + i * 2.1) * 1.3;
    ctx.globalAlpha = 0.65 * (1 - p);
    ctx.fillStyle = "#ffffff";
    const wx = Math.round(cx + facing * (2 + i * 0.7 + sway));
    const wy = Math.round(cy - 1 - p * 9);
    ctx.fillRect(wx, wy, 1, p < 0.5 ? 2 : 1);
  }
  ctx.globalAlpha = 1;
}

// ── The paper lantern ───────────────────────────────────────────

/** A chōchin: black caps, ribbed paper glowing warm, a red band round its middle. */
const CHOCHIN = [".ooo.", "oPWPo", "PWWWP", "pRRRp", "PWWWP", "oPWPo", ".ooo."];
const CHOCHIN_PALETTE: Readonly<Record<string, string>> = {
  o: INK,
  W: "#fff4c8",
  P: "#ffd27a",
  p: "#d89a48",
  R: "#d8483a",
};

/**
 * A paper lantern after dark. Carried, it hangs from the end of a short
 * bamboo pole held out in front, swaying with the walk; set down while its
 * critter works, it stands on the ground beside it. Returns the middle of its
 * paper (where its light comes from). (x, y) is the top of its cap.
 */
export function drawChochin(
  ctx: Ctx,
  x: number,
  y: number,
  held: boolean,
  strength: number,
  now: number,
  hand: Spot,
): Spot {
  const lx = Math.round(x);
  const ly = Math.round(y);
  const alpha = Math.min(1, strength * 1.6);
  ctx.globalAlpha = alpha;
  if (held) {
    // The pole from the hand out to above the lantern, and its cord.
    const steps = Math.max(1, Math.abs(lx - hand.x));
    ctx.fillStyle = PALETTE.B ?? INK;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      ctx.fillRect(
        Math.round(hand.x + (lx - hand.x) * t),
        Math.round(hand.y + (ly - 2 - hand.y) * t),
        1,
        1,
      );
    }
    ctx.fillStyle = INK;
    ctx.fillRect(lx, ly - 1, 1, 1);
  }
  // The paper flickers between two warm tones, the flame's heart brightest.
  const flick = Math.floor(now / 140 + x) % 3 === 0;
  for (let r = 0; r < CHOCHIN.length; r++) {
    const row = CHOCHIN[r] ?? "";
    for (let c = 0; c < row.length; c++) {
      const key = row[c] ?? ".";
      let color = CHOCHIN_PALETTE[key];
      if (!color) continue;
      if (flick && key === "W") color = "#ffe9a8";
      ctx.fillStyle = color;
      ctx.fillRect(lx - 2 + c, ly + r, 1, 1);
    }
  }
  ctx.globalAlpha = 1;
  return { x: lx, y: ly + 3 };
}
