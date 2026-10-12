// Detailed farm art for the cosy top-down Goal world, drawn pixel by pixel
// to sit beside hand-made farm-sim art: stepping stones that are each their
// own shape, crops where every plant grows its own way (each with its own
// outline, so they read as chunky little plants), raised beds with depth, a
// farmhouse whose every bay is different, and the small things that make a
// yard feel lived in. Pure: the same seed always draws the same pixels.

import { PixelBuffer, hash, mix, noise, stream, type Rgb } from "./goal-map-pixels";
import type { Sprite } from "./goal-map-props";

/** The warm near-black every edge in this world is drawn in. */
const LINE: Rgb = 0x3a1406;

function sprite(
  w: number,
  h: number,
  ax: number,
  ay: number,
  draw: (b: PixelBuffer) => void,
  shadow?: Sprite["shadow"],
  outline = 0.86,
): Sprite {
  const buf = new PixelBuffer(w, h);
  draw(buf);
  if (outline > 0) buf.outline(outline, LINE);
  return { buf, ax, ay, ...(shadow ? { shadow } : {}) };
}

/** An irregular closed shape: its radius wobbles smoothly with the angle. */
export function blob(seed: number, wobble = 0.16, lobes = 4): (nx: number, ny: number) => boolean {
  const amps: number[] = [];
  const phases: number[] = [];
  for (let k = 0; k < lobes; k++) {
    amps.push((0.45 + hash(k, 1, seed) * 0.55) / (k + 1));
    phases.push(hash(k, 2, seed) * Math.PI * 2);
  }
  return (nx, ny) => {
    const a = Math.atan2(ny, nx);
    let r = 1;
    for (let k = 0; k < lobes; k++)
      r += wobble * (amps[k] ?? 0) * Math.sin((k + 2) * a + (phases[k] ?? 0));
    return Math.hypot(nx, ny) <= r;
  };
}

// ── Stones ───────────────────────────────────────────────────

const ST = {
  sheen: 0xf6f3ee,
  light: 0xe2dcd4,
  base: 0xc9c2b9,
  mid: 0xb0a89f,
  side: 0x8d847b,
  deep: 0x625951,
  moss: 0x9cb344,
} as const;

/**
 * A flat stepping stone pressed into the earth, read from a hand-drawn one: a
 * wide, low slab seen from above, its face one pale grey with a few soft
 * darker patches worn into it and a white glint low on its rim. It sits in
 * the ground rather than on it: along its top the soil laps over its edge,
 * so the outline there is a soft grey, broken by dark only at the corners;
 * only its near edge shows a thin grey lip and a dark line, and the soil
 * round its foot is pressed darker, with the odd blade of grass poking out.
 * No cast shadow: it is no taller than the ground. Each one is its own shape.
 */
export function stone(seed: number, size: "s" | "m" | "l" = "m", mossy = false): Sprite {
  const base = size === "s" ? 5 : size === "l" ? 9.2 : 8.4;
  const rx = base + hash(seed, 0, 3) * 0.9;
  const ry = rx * (0.58 + hash(seed, 1, 3) * 0.06);
  const shape = blob(seed, 0.07, 5);
  const w = Math.ceil(rx * 2.3) + 6;
  const h = Math.ceil(ry * 2.3) + 7;
  const cx = w / 2;
  const cy = (h - 3) / 2;
  const top = (x: number, y: number): boolean => shape((x + 0.5 - cx) / rx, (y + 0.5 - cy) / ry);
  // The face plus its one-pixel lip below.
  const body = (x: number, y: number): boolean => top(x, y) || top(x, y - 1);
  const SLAB = {
    face: 0xd0cbc3,
    wear: 0xbdb4a9,
    lip: 0x8f8880,
    rim: 0x8a837b,
    glint: 0xfdfcf9,
    grass: 0x7a9a2a,
    grassLight: 0x9ab83e,
  };
  return sprite(
    w,
    h,
    Math.round(cx),
    h - 3,
    (b) => {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const ny = (y + 0.5 - cy) / ry;
          const nx = (x + 0.5 - cx) / rx;
          if (top(x, y)) {
            // Soft worn patches: broad, low-contrast, mostly across the middle and below.
            const worn = noise(x, y * 1.6, 3.2, seed + 2) + ny * 0.22 > 0.66;
            let c: Rgb = worn ? SLAB.wear : SLAB.face;
            if (mossy && ny > 0.45 && hash(x >> 1, y, seed + 4) < 0.3) c = SLAB.grass;
            b.set(x, y, c);
          } else if (body(x, y)) {
            b.set(x, y, SLAB.lip);
          } else if (body(x, y + 1) || body(x - 1, y) || body(x + 1, y)) {
            // The outline: soil lapping over the top edge (soft grey), dark round
            // the corners and along the near edge, where the stone meets the ground.
            const corner = Math.abs(nx) > 0.62 && hash(x, y, seed + 5) < 0.75;
            b.set(x, y, ny < -0.25 && !corner ? SLAB.rim : LINE);
          } else if (body(x, y - 1) || body(x, y - 2) || body(x - 1, y - 1) || body(x + 1, y - 1)) {
            // The pressed earth round its foot: a darker, see-through band.
            b.set(x, y, LINE, body(x, y - 1) ? 0.32 : 0.18);
          }
        }
      }
      // A glint low on the rim, the way light catches a worn edge, and a short one up top.
      const rnd = stream(seed + 6);
      const gy = Math.round(cy + ry * 0.62);
      const gx = Math.round(cx - rx * (0.25 + rnd() * 0.35));
      const len = size === "s" ? 2 : 3 + Math.floor(rnd() * 3);
      for (let d = 0; d < len; d++)
        if (top(gx + d, gy) && top(gx + d, gy + 1)) b.set(gx + d, gy, SLAB.glint);
      if (size !== "s") {
        const tx = Math.round(cx + rx * (0.45 + rnd() * 0.3));
        const ty = Math.round(cy - ry * 0.35);
        if (top(tx, ty) && top(tx + 1, ty)) b.set(tx, ty, SLAB.glint);
      }
      // A blade or two of grass poking up along its near edge.
      const blades = (size === "s" ? 0 : 1) + Math.floor(rnd() * 2);
      for (let k = 0; k < blades; k++) {
        const bx = Math.round(cx + (rnd() - 0.5) * rx * 1.4);
        let by = h - 1;
        while (by > 0 && !body(bx, by)) by--;
        b.set(bx, by + 1, SLAB.grass);
        b.set(bx + 1, by, SLAB.grassLight);
        b.set(bx, by, SLAB.grass);
      }
    },
    undefined,
    0,
  );
}

// ── Plants (each drawn and outlined on its own) ───────────────

const LEAF = { deep: 0x2f5014, dark: 0x467a1c, base: 0x63992a, light: 0x8cbf3c, hi: 0xb5dc5a };
const DAIKON_LEAF = { dark: 0x4e7a1c, base: 0x78a832, light: 0xa4cc4a, hi: 0xcce06a };

export type Crop = "carrot" | "daikon" | "cabbage" | "rice" | "eggplant";

/** How grown a plant is: 0 a seedling, 1 ready to pull. */
type Stage = number;

/** A short, thick leaf stroke from (x, y) at angle `a`, `len` long. */
function leafStroke(
  b: PixelBuffer,
  x: number,
  y: number,
  a: number,
  len: number,
  tones: { dark: Rgb; base: Rgb; light: Rgb; hi: Rgb },
  broad = 1,
): void {
  for (let s = 0; s <= len; s++) {
    const t = s / len;
    const px = x + Math.cos(a) * s;
    const py = y + Math.sin(a) * s;
    const width = t < 0.2 ? 0 : t > 0.88 ? 0 : broad;
    for (let k = -width; k <= width; k++) {
      const ox = Math.round(px + k * -Math.sin(a));
      const oy = Math.round(py + k * Math.cos(a));
      b.set(ox, oy, k < 0 ? tones.light : k > 0 ? tones.dark : t > 0.7 ? tones.hi : tones.base);
    }
  }
}

function carrotPlant(seed: number, stage: Stage): Sprite {
  return sprite(
    16,
    19,
    8,
    17,
    (b) => {
      const rnd = stream(seed);
      const leaves = stage > 0.7 ? 6 : stage > 0.35 ? 4 : 2;
      const reach = stage > 0.7 ? 8.5 : stage > 0.35 ? 6 : 3.5;
      // Feathery fronds, fanned upward, each ending in a bushy tuft.
      for (let i = 0; i < leaves; i++) {
        const a = -Math.PI / 2 + (i - (leaves - 1) / 2) * 0.36 + (rnd() - 0.5) * 0.3;
        const len = reach + rnd() * 2;
        leafStroke(b, 8, 13, a, len, LEAF, 0);
        const tx = Math.round(8 + Math.cos(a) * len);
        const ty = Math.round(13 + Math.sin(a) * len);
        b.ellipse(tx + 0.5, ty + 0.5, 2.2, 1.8, LEAF.light);
        b.set(tx, ty - 1, LEAF.hi);
        b.set(tx - 1, ty, LEAF.hi);
        if (rnd() < 0.22) b.set(tx + 1, ty, 0xd8c85a); // one leaf turning yellow
      }
      if (stage > 0.3) {
        // The orange shoulder standing up out of the soil.
        const rw = stage > 0.7 ? 3.2 : 2.4;
        b.ellipse(8.5, 15, rw, 2.6, 0xe0702a);
        b.rect(7, 13, 2, 1, 0xf4a058);
        b.set(6, 14, 0xf4a058);
        b.set(Math.round(8 + rw) - 1, 16, 0xb04e18);
        b.set(9, 17, 0xb04e18);
        b.set(7, 16, 0xe88a3a);
      }
    },
    undefined,
    0.82,
  );
}

function daikonPlant(seed: number, stage: Stage): Sprite {
  return sprite(
    16,
    16,
    8,
    14,
    (b) => {
      const rnd = stream(seed);
      const leaves = stage > 0.6 ? 6 : stage > 0.3 ? 5 : 3;
      const reach = stage > 0.6 ? 7.5 : stage > 0.3 ? 5.5 : 3.5;
      // A rosette of broad leaves, back ones first.
      const angles = Array.from(
        { length: leaves },
        (_, i) => -Math.PI / 2 + (i - (leaves - 1) / 2) * 0.6 + (rnd() - 0.5) * 0.25,
      ).sort((p, q) => Math.abs(q + Math.PI / 2) - Math.abs(p + Math.PI / 2));
      for (const a of angles) leafStroke(b, 8, 11, a, reach + rnd() * 1.5, DAIKON_LEAF, 1);
      if (stage > 0.25) {
        // The white root's crown, with a pale green collar.
        const rw = stage > 0.6 ? 3.4 : 2.4;
        b.ellipse(8.5, 12.5, rw, 2, 0xf2efe0);
        b.set(7, 11, 0xffffff);
        b.set(Math.round(8 + rw) - 1, 13, 0xcfc9b0);
        b.rect(7, 10, 3, 1, 0xd6e4a0);
      }
    },
    undefined,
    0.8,
  );
}

function cabbagePlant(seed: number, stage: Stage): Sprite {
  return sprite(
    14,
    13,
    7,
    11,
    (b) => {
      const rnd = stream(seed);
      const r = 2.6 + stage * 2.4;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + rnd() * 0.5;
        b.ellipse(
          7 + Math.cos(a) * r * 0.55,
          7 + Math.sin(a) * r * 0.4,
          r * 0.55,
          r * 0.42,
          Math.sin(a) > 0.2 ? LEAF.dark : LEAF.base,
        );
      }
      b.ellipse(7.2, 6.5, r * 0.62, r * 0.5, 0xb8d47a);
      b.ellipse(6.4, 5.8, r * 0.3, r * 0.22, 0xdcebb0);
      b.set(Math.round(7 + r * 0.3), 8, 0x8cb050);
    },
    undefined,
    0.8,
  );
}

function eggplantPlant(seed: number, stage: Stage): Sprite {
  return sprite(
    14,
    16,
    7,
    14,
    (b) => {
      const rnd = stream(seed);
      for (let i = 0; i < 4; i++) {
        const a = -Math.PI / 2 + (i - 1.5) * 0.7 + (rnd() - 0.5) * 0.2;
        leafStroke(b, 7, 12, a, 4.5 + rnd() * 1.5, LEAF, 1);
      }
      if (stage > 0.4) {
        b.ellipse(5, 12, 1.6, 2.4, 0x5a2a6a);
        b.set(4, 11, 0x8a5aa0);
        if (stage > 0.7) {
          b.ellipse(9.5, 12.5, 1.5, 2.2, 0x6a3a7a);
          b.set(9, 11, 0x9a6ab0);
        }
      }
    },
    undefined,
    0.8,
  );
}

function riceClump(seed: number, stage: Stage): Sprite {
  return sprite(
    14,
    18,
    7,
    16,
    (b) => {
      const rnd = stream(seed);
      const stalks = 6 + Math.floor(rnd() * 4);
      for (let i = 0; i < stalks; i++) {
        const bx = 7 + (i - (stalks - 1) / 2) * 0.9 + (rnd() - 0.5);
        const hgt = 9 + Math.round(rnd() * 4 + stage * 2);
        const lean = (rnd() - 0.5) * 0.4 + (i - stalks / 2) * 0.1;
        let px = bx;
        for (let k = 0; k < hgt; k++) {
          px += lean * 0.28;
          const t = k / hgt;
          b.set(Math.round(px), 15 - k, t < 0.35 ? 0x5e8a28 : t < 0.65 ? 0x9ab840 : 0xd2c454);
        }
        // A drooping golden head.
        const dir = lean >= 0 ? 1 : -1;
        const hx = Math.round(px);
        const hy = 15 - hgt;
        b.set(hx, hy, 0xf0d870);
        b.set(hx + dir, hy, 0xe2c254);
        b.set(hx + dir, hy + 1, 0xd2a838);
        b.set(hx + dir * 2, hy + 2, 0xc89a30);
      }
    },
    undefined,
    0.82,
  );
}

const PLANTS: Readonly<Record<Crop, (seed: number, stage: Stage) => Sprite>> = {
  carrot: carrotPlant,
  daikon: daikonPlant,
  cabbage: cabbagePlant,
  eggplant: eggplantPlant,
  rice: riceClump,
};

// ── Beds and fields ──────────────────────────────────────────

/** A low wooden fence: posts of slightly different heights, two lit rails. */
function fence(b: PixelBuffer, x: number, y: number, width: number, seed: number): void {
  for (const ry of [y + 3, y + 7]) {
    for (let xx = x; xx < x + width; xx++) {
      b.set(xx, ry, hash(xx >> 2, ry, seed) < 0.1 ? 0xdea260 : 0xc98149);
      b.set(xx, ry + 1, 0x8a4e22);
    }
  }
  const posts = Math.max(2, Math.round(width / 11));
  for (let i = 0; i <= posts; i++) {
    const px = Math.min(x + width - 3, Math.round(x + (i * (width - 3)) / posts));
    const ph = 10 + (hash(px, 0, seed) < 0.35 ? 1 : 0);
    const top = y + 11 - ph;
    for (let k = 0; k < ph; k++) {
      b.set(px, top + k, 0xdea260);
      b.set(px + 1, top + k, 0xc98149);
      b.set(px + 2, top + k, 0x8a4e22);
    }
    b.set(px + 1, top, 0xf0c080);
  }
}

/** A field's soil: its lit and shaded tones. */
interface SoilTones {
  readonly light: Rgb;
  readonly base: Rgb;
  readonly mid: Rgb;
  readonly dark: Rgb;
  readonly deep: Rgb;
  /** The sunlit far wall, where the plot is dug down from the grass. */
  readonly lip: Rgb;
}

/** Turned earth, sampled from a hand-drawn carrot plot. */
const DIRT: SoilTones = {
  light: 0x8f5a2b,
  base: 0x7c4821,
  mid: 0x6f401d,
  dark: 0x5f3618,
  deep: 0x4b2410,
  lip: 0xa47e37,
};

/** A dry paddy: pale, sandy earth. */
const PADDY: SoilTones = {
  light: 0xb79442,
  base: 0x9a6e31,
  mid: 0x8e652d,
  dark: 0x705a24,
  deep: 0x5f4419,
  lip: 0xc8a650,
};

/** Grass blades that spill over a plot's edge. */
const BLADE = { dark: 0x5e6923, base: 0x7c8a30, light: 0x9aab3e } as const;

/**
 * A plot dug into the grass, seen from above: a ragged-edged patch of earth
 * (no frame, no boards), sunk a little below the turf, so its near (top and
 * left) walls sit in shade and its far ones catch the light, ploughed into
 * rows of ridges and furrows that wander a pixel up and down, with clods,
 * and grass spilling over the edge here and there. Transparent outside, so
 * the real ground shows round it.
 */
function paintPlot(
  b: PixelBuffer,
  x0: number,
  y0: number,
  w: number,
  h: number,
  rowH: number,
  soil: SoilTones,
  seed: number,
): void {
  const inside = (x: number, y: number): boolean => {
    if (x < x0 || y < y0 || x >= x0 + w || y >= y0 + h) return false;
    // A rounded rectangle whose edge wanders a pixel or two in and out.
    const cr = 5;
    const ex = Math.max(0, x0 + cr - x - 0.5, x + 0.5 - (x0 + w - cr));
    const ey = Math.max(0, y0 + cr - y - 0.5, y + 0.5 - (y0 + h - cr));
    const d = cr - Math.hypot(ex, ey);
    const edge = Math.min(x - x0, x0 + w - 1 - x, y - y0, y0 + h - 1 - y);
    const depth = ex > 0 && ey > 0 ? d : Math.min(edge + 0.5, d);
    return depth > (noise(x, y, 3.2, seed) - 0.3) * 2.6;
  };
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (!inside(x, y)) continue;
      // Broad mounded ridges, one per row of plants, wandering gently across
      // the plot: lit along their crests, dark down in the furrows between.
      const wave = (noise(x, 0, 13, seed + 1) - 0.5) * 3;
      const phase = (y - y0 + wave) / rowH;
      const v = 0.5 + 0.5 * Math.cos(phase * Math.PI * 2) + (noise(x, y, 3, seed + 2) - 0.5) * 0.45;
      let c: Rgb =
        v > 0.86
          ? (x + y) % 2 === 0
            ? soil.light
            : soil.base
          : v > 0.5
            ? soil.base
            : v > 0.26
              ? soil.mid
              : v > 0.08
                ? soil.dark
                : soil.deep;
      // Clods and pebbles.
      const speck = hash(x, y, seed + 3);
      if (speck < 0.03) c = soil.light;
      else if (speck > 0.975) c = soil.dark;
      // Sunk below the turf: the walls under the top and left edges are in
      // shade, the walls along the bottom and right are lit.
      if (!inside(x, y - 1) || !inside(x - 1, y)) c = soil.dark;
      else if (!inside(x, y - 2)) c = soil.dark;
      else if (!inside(x, y + 1) || !inside(x + 1, y)) c = soil.lip;
      else if (!inside(x, y + 2)) c = mix(soil.lip, c, 0.5);
      b.set(x, y, c);
    }
  }
  // Grass spilling over the edge: short dark blades leaning into the plot.
  const rnd = stream(seed + 4);
  const tuft = (x: number, y: number, dir: 1 | -1): void => {
    const blades = 2 + Math.floor(rnd() * 3);
    for (let i = 0; i < blades; i++) {
      const bx = x + i * 2 - blades + 1;
      const len = 2 + Math.floor(rnd() * 3);
      for (let k = 0; k < len; k++) {
        b.set(
          bx + (k > 1 ? Math.sign(i - blades / 2) : 0),
          y + dir * k,
          k === 0 ? BLADE.base : BLADE.dark,
        );
      }
      b.set(bx, y - dir, BLADE.light);
    }
  };
  for (let x = x0 + 4; x < x0 + w - 4; x += 5 + Math.floor(rnd() * 9)) {
    if (rnd() < 0.55) tuft(x, y0 + 1, 1);
  }
  for (let y = y0 + 6; y < y0 + h - 6; y += 7 + Math.floor(rnd() * 8)) {
    if (rnd() < 0.5) tuft(x0 + 1, y, 1);
    if (rnd() < 0.5) tuft(x0 + w - 2, y, 1);
  }
}

/** Lay a plant's silhouette on the soil as a soft shadow, down and to its right. */
function plantShadow(b: PixelBuffer, p: Sprite, x: number, y: number, flip: boolean): void {
  const src = p.buf;
  for (let sy = 0; sy < src.height; sy++) {
    for (let sx = 0; sx < src.width; sx++) {
      if ((src.data[(sy * src.width + sx) * 4 + 3] ?? 0) < 128) continue;
      const tx = x + (flip ? src.width - 1 - sx : sx) + 2;
      const ty = y + sy + 2;
      if (b.opaque(tx, ty)) b.set(tx, ty, mix(b.rgb(tx, ty), LINE, 0.38));
    }
  }
}

/**
 * A crop plot: a patch of ploughed earth sunk into the grass, its plants
 * (each different, back rows first so front plants overlap them) each
 * casting a small shadow on the soil. The fence along its front is a
 * separate prop (`fieldFence`), so it can stand and cast its own shadow.
 * Anchored at the middle of the plot's bottom edge.
 */
export function cropPlot(kind: Crop, cols: number, rows: number, seed: number): Sprite {
  const rice = kind === "rice";
  const cellW = rice ? 13 : 17;
  const cellH = rice ? 14 : 15;
  const w = cols * cellW + 10;
  const soilH = rows * cellH + 10;
  const headroom = 10;
  const h = headroom + soilH;
  const buf = new PixelBuffer(w, h);
  paintPlot(buf, 0, headroom, w, soilH, cellH / (rice ? 1.5 : 2), rice ? PADDY : DIRT, seed);
  // Plants, back row first. Each is its own plant: its own growth, lean and leaves.
  const plant = PLANTS[kind];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const rnd = stream(seed * 131 + r * 17 + c * 7);
      const roll = rnd();
      if (roll < 0.05) continue;
      const stage = roll < 0.16 ? 0.2 : roll < 0.4 ? 0.5 : 0.92;
      const p = plant(seed * 977 + r * 31 + c * 13, stage);
      // Staggered rows, the way hand-sown beds are laid out.
      const stagger = r % 2 === 1 && !rice ? Math.round(cellW / 2) - 2 : 0;
      if (stagger && c === cols - 1) continue;
      const px = 5 + c * cellW + Math.round(cellW / 2) + stagger + Math.round((rnd() - 0.5) * 2);
      const py = headroom + 5 + r * cellH + Math.round(cellH * 0.7) + Math.round((rnd() - 0.5) * 2);
      const flip = rnd() < 0.5;
      plantShadow(buf, p, px - p.ax, py - p.ay, flip);
      buf.draw(p.buf, px - p.ax, py - p.ay, flip);
    }
  }
  return { buf, ax: Math.round(w / 2), ay: h - 1 };
}

/** The low wooden fence along a plot's front, standing on its own so it casts a shadow. */
export function fieldFence(width: number, seed: number): Sprite {
  const h = 13;
  const buf = new PixelBuffer(width + 2, h);
  fence(buf, 1, 0, width, seed);
  return { buf, ax: Math.round((width + 2) / 2), ay: h - 2, shadow: { a: 0.3, height: 6 } };
}

/**
 * Long, rounded rows of a clipped crop (tea, or young cabbage), each a little
 * different, standing in a plot of earth and shading the soil below them.
 * Anchored at the middle of the plot's bottom edge.
 */
export function teaRows(width: number, rolls: number, seed: number): Sprite {
  const rollH = 11;
  const gap = 3;
  const w = width + 10;
  const h = rolls * (rollH + gap) + 10;
  const buf = new PixelBuffer(w, h);
  paintPlot(buf, 0, 2, w, h - 2, rollH + gap, DIRT, seed);
  for (let r = 0; r < rolls; r++) {
    const roll = new PixelBuffer(w, rollH + 2);
    const inset = 4 + Math.round(hash(r, 0, seed) * 4);
    const right = w - 5 - Math.round(hash(r, 1, seed) * 4);
    for (let y = 0; y < rollH; y++) {
      const half = rollH / 2;
      const endR = half * Math.sqrt(Math.max(0, 1 - ((y - half + 0.5) / half) ** 2));
      for (let x = inset; x < right; x++) {
        if (x < inset + half - endR || x > right - half + endR) continue;
        const t = y / rollH;
        const bump = noise(x, y, 2, seed + r * 7) - 0.5;
        const l = (0.45 - t) * 1.5 + bump * 0.7 - ((x - inset) / (right - inset)) * 0.25;
        const c =
          l > 0.45
            ? 0x9db238
            : l > 0.1
              ? 0x8aa230
              : l > -0.3
                ? 0x7e942c
                : l > -0.6
                  ? 0x677824
                  : 0x54621c;
        roll.set(x, y + 1, c);
        // Leaf flecks catching the light.
        if (l > 0 && hash(x, y, seed + r) < 0.07) roll.set(x, y + 1, 0xb8c84a);
      }
    }
    roll.outline(0.86, LINE);
    const ry = 3 + r * (rollH + gap);
    plantShadow(buf, { buf: roll, ax: 0, ay: 0 }, 0, ry, false);
    buf.draw(roll, 0, ry);
  }
  return { buf, ax: Math.round(w / 2), ay: h - 1 };
}

// ── The farmhouse ────────────────────────────────────────────

/** Wood, paper and thatch tones sampled from a hand-drawn minka. */
export const W = {
  line: 0x470501,
  deep: 0x602710,
  shadow: 0x7a3c17,
  base: 0xa56436,
  mid: 0xb47744,
  warm: 0xc98149,
  light: 0xce8952,
  hi: 0xdea260,
  face: 0x9b582b,
  frame: 0x81512a,
} as const;
export const PAPER = { lit: 0xfff1d8, base: 0xf3d4aa, shade: 0xe0bc8a } as const;
export const THATCH = {
  hi: 0xac7b49,
  base: 0x8e613a,
  lo: 0x7a5230,
  deep: 0x5e3c20,
  moss: 0x7d8a34,
} as const;

/** What fills one bay (the space between two posts) of the house front. */
export type Bay = "shoji" | "shojiOpen" | "glass" | "room" | "blind" | "storeDoor";

/** One shoji panel: a dark frame, a paper lattice above, a wooden kickboard below. */
function shojiPanel(
  b: PixelBuffer,
  x: number,
  y: number,
  w: number,
  h: number,
  seed: number,
  grid = 3,
): void {
  b.rect(x, y, w, h, W.frame);
  const paperH = Math.round(h * 0.62);
  for (let yy = 1; yy < paperH; yy++) {
    for (let xx = 1; xx < w - 1; xx++) {
      const lattice = xx % grid === 0 || yy % (grid + 1) === 0;
      let c: Rgb = lattice ? W.mid : yy < paperH * 0.45 ? PAPER.lit : PAPER.base;
      if (!lattice && hash(x + xx, y + yy, seed) < 0.025) c = PAPER.shade;
      b.set(x + xx, y + yy, c);
    }
  }
  b.rect(x + 1, y + paperH, w - 2, 1, W.base);
  for (let yy = paperH + 1; yy < h - 1; yy++) {
    for (let xx = 1; xx < w - 1; xx++) {
      const c =
        yy === paperH + 1
          ? W.hi
          : yy === h - 2
            ? W.base
            : xx === Math.floor(w / 2)
              ? W.base
              : W.warm;
      b.set(x + xx, y + yy, c);
    }
  }
}

export function paintBay(
  b: PixelBuffer,
  kind: Bay,
  x: number,
  y: number,
  w: number,
  h: number,
  seed: number,
  sign?: Rgb,
): void {
  const half = Math.floor(w / 2);
  switch (kind) {
    case "shoji": {
      shojiPanel(b, x, y, half, h, seed);
      shojiPanel(b, x + half, y, w - half, h, seed + 1);
      return;
    }
    case "shojiOpen": {
      // The left panel slid across: a dim room with a tatami floor shows through.
      b.rect(x, y, half, h, 0x5a2e14);
      b.rect(x, y, half, 3, 0x40200c);
      b.rect(x, y + h - 8, half, 7, 0xb3a46a);
      b.rect(x, y + h - 8, half, 1, 0x7a6a3a);
      b.rect(x + 2, y + h - 6, 6, 3, 0xc84a3a);
      b.rect(x + 2, y + h - 6, 6, 1, 0xe07a6a);
      shojiPanel(b, x + half - 1, y, w - half + 1, h, seed, 4);
      b.rect(x + half - 2, y, 1, h, W.line);
      return;
    }
    case "glass": {
      const gh = Math.round(h * 0.6);
      b.rect(x, y, w, gh, W.frame);
      for (let yy = 2; yy < gh - 1; yy++) {
        for (let xx = 2; xx < w - 2; xx++) {
          const diag = xx + yy;
          let c: Rgb = 0xc9ddd2;
          if (diag > 6 && diag < 11) c = 0xe6f0ea;
          if (xx > w - 7 && yy > gh - 6) c = 0xa9c2b6;
          if (xx === half || yy === Math.floor(gh / 2)) c = W.frame;
          b.set(x + xx, y + yy, c);
        }
      }
      for (let yy = gh; yy < h; yy++) {
        for (let xx = 0; xx < w; xx++) {
          b.set(x + xx, y + yy, yy === gh ? W.hi : (yy - gh) % 4 === 0 ? W.base : W.warm);
        }
      }
      // A little plant in a pot on the sill.
      b.rect(x + 3, y + gh - 1, 5, 3, W.shadow);
      b.rect(x + 3, y + gh - 1, 5, 1, W.light);
      b.ellipse(x + 5.5, y + gh - 3, 2.6, 2, 0x63992a);
      b.set(x + 5, y + gh - 4, 0x8cbf3c);
      return;
    }
    case "room": {
      // A bright room through the open bay: an alcove with a scroll and a
      // vase, a doorway to a back room, a tatami floor and a red cushion.
      b.rect(x, y, w, h, 0xe6e3dc);
      b.rect(x, y, w, 3, 0xc6c0b6);
      b.rect(x + 2, y + 5, 7, h - 13, 0xbdb7ad);
      b.rect(x + 2, y + 5, 1, h - 13, 0xa8a298);
      b.rect(x + w - 11, y + 4, 9, h - 12, 0xd6d1c7);
      b.rect(x + w - 9, y + 6, 4, 10, PAPER.lit);
      b.rect(x + w - 9, y + 6, 4, 1, W.frame);
      b.rect(x + w - 9, y + 15, 4, 1, W.frame);
      for (const [ix, iy] of [
        [1, 3],
        [2, 4],
        [1, 6],
        [2, 7],
      ] as const) {
        b.set(x + w - 9 + ix, y + 6 + iy, 0x3a3a3a);
      }
      b.rect(x + w - 9, y + h - 10, 3, 3, 0x4a5a8a);
      b.set(x + w - 8, y + h - 11, 0x63992a);
      b.set(x + w - 8, y + h - 12, 0xd8394a);
      b.rect(x, y + h - 8, w, 8, 0xc8b878);
      b.rect(x, y + h - 8, w, 1, 0x8a7a40);
      b.rect(x + Math.floor(w * 0.5), y + h - 8, 1, 8, 0x8a7a40);
      b.rect(x + 3, y + h - 6, 7, 3, 0xc84a3a);
      b.rect(x + 3, y + h - 6, 7, 1, 0xe07a6a);
      if (sign !== undefined) {
        // A noren curtain over the top of the doorway.
        b.rect(x, y, w, 8, sign);
        for (let xx = x + 6; xx < x + w - 2; xx += 7) b.rect(xx, y, 1, 8, mix(sign, W.line, 0.35));
        b.rect(x, y + 7, w, 1, mix(sign, W.line, 0.35));
        b.rect(x + Math.floor(w / 2) - 2, y + 2, 4, 3, PAPER.lit);
      }
      return;
    }
    case "blind": {
      // Shoji behind a bamboo blind rolled two-thirds down.
      shojiPanel(b, x, y, half, h, seed);
      shojiPanel(b, x + half, y, w - half, h, seed + 1);
      const bh = Math.round(h * 0.6);
      for (let yy = 0; yy < bh; yy++) {
        for (let xx = 0; xx < w; xx++) {
          b.set(x + xx, y + yy, yy % 6 === 5 ? 0x9a7a3a : xx % 2 === 0 ? 0xd6b474 : 0xbf9a56);
        }
      }
      b.rect(x - 1, y + bh, w + 2, 2, 0x9a7a3a);
      b.rect(x - 1, y + bh, w + 2, 1, 0xe2c486);
      b.rect(x + 3, y + bh - 1, 1, 5, 0xd8394a);
      b.rect(x + w - 4, y + bh - 1, 1, 5, 0xd8394a);
      return;
    }
    case "storeDoor": {
      // A heavy board door with iron bands and a ring pull.
      for (let yy = 0; yy < h; yy++) {
        for (let xx = 0; xx < w; xx++) {
          const slat = yy % 4;
          b.set(
            x + xx,
            y + yy,
            slat === 0 ? W.hi : slat === 3 ? W.base : xx < 2 ? W.light : W.warm,
          );
        }
      }
      for (const by of [y + 5, y + h - 7]) {
        b.rect(x, by, w, 2, 0x3c3430);
        for (let rx = x + 2; rx < x + w; rx += 6) b.set(rx, by, 0x8a8078);
      }
      b.ellipse(x + w - 5, y + Math.floor(h / 2), 1.7, 1.7, 0x3c3430);
      b.set(x + w - 5, y + Math.floor(h / 2), W.warm);
      return;
    }
  }
}

/** Ragged, streaky blotches of lighter straw across a thatch roof. */
export function thatchBlotch(x: number, y: number, seed: number): number {
  const cell = 13;
  let best = 0;
  for (let gy = Math.floor(y / 7) - 1; gy <= Math.floor(y / 7) + 1; gy++) {
    for (let gx = Math.floor(x / cell) - 1; gx <= Math.floor(x / cell) + 1; gx++) {
      if (hash(gx, gy, seed + 7) > 0.3) continue;
      const ox = gx * cell + hash(gx, gy, seed + 8) * cell;
      const oy = gy * 7 + hash(gx, gy, seed + 9) * 7;
      const rx = 6 + hash(gx, gy, seed + 10) * 8;
      const ry = 1.1 + hash(gx, gy, seed + 11) * 1.3;
      const hang = hash(Math.floor(x / 2), gy, seed + 12) * 2.2;
      const d =
        ((x - ox) / rx) ** 2 +
        (Math.max(0, y - oy - hang) / ry) ** 2 +
        (Math.min(0, y - oy) / ry) ** 2;
      best = Math.max(best, 1 - d);
    }
  }
  return best;
}

/**
 * A big minka farmhouse: a heavy thatched hip roof (sunlit hip on the left,
 * shaded on the right, moss near the ridge, a smoke vent on top, a ragged
 * straw fringe), a row of rafter ends under the eave, posts with a lit face,
 * bays that are each different, a paper lantern and a wind chime hanging
 * from the eave, and a raised veranda on foundation stones with sandals at
 * the step.
 */
export function farmhouse(
  seed: number,
  bays: readonly Bay[] = ["shoji", "shojiOpen", "glass", "room", "blind", "storeDoor"],
  sign?: Rgb,
): Sprite {
  const bayW = 32;
  const front = bays.length * bayW + 5;
  const over = 13;
  const w = front + over * 2;
  const roofH = 60;
  const eaveY = roofH;
  const lintelY = eaveY + 4;
  const wallH = 30;
  const deckY = lintelY + wallH;
  const deckH = 10;
  const h = deckY + deckH + 4;
  const left = over;
  const b = new PixelBuffer(w, h);

  // The front: deep shadow behind, then each bay, then posts over them.
  b.rect(left, lintelY, front, wallH, W.deep);
  bays.forEach((kind, i) => {
    paintBay(
      b,
      kind,
      left + 5 + i * bayW,
      lintelY + 1,
      bayW - 5,
      wallH - 1,
      seed + i * 13,
      kind === "room" ? sign : undefined,
    );
  });
  for (let i = 0; i <= bays.length; i++) {
    const px = left + i * bayW;
    for (let k = 0; k < wallH; k++) {
      b.set(px, lintelY + k, W.line);
      b.set(px + 1, lintelY + k, W.hi);
      b.set(px + 2, lintelY + k, W.warm);
      b.set(px + 3, lintelY + k, W.base);
      b.set(px + 4, lintelY + k, W.line);
    }
  }

  // The veranda: long boards, a lit nosing, foundation stones under it.
  for (let yy = 0; yy < deckH - 3; yy++) {
    for (let x = left - 9; x < left + front + 9; x++) {
      const c =
        yy === 0
          ? W.hi
          : yy % 3 === 0
            ? W.base
            : (x + Math.floor(yy / 3) * 17) % 37 === 0
              ? W.base
              : W.light;
      b.set(x, deckY + yy, c);
    }
  }
  b.rect(left - 9, deckY + deckH - 3, front + 18, 2, W.face);
  b.rect(left - 9, deckY + deckH - 3, front + 18, 1, W.warm);
  b.rect(left - 9, deckY + deckH - 1, front + 18, 1, W.line);
  for (let i = 0; i <= bays.length; i++) {
    const px = left + i * bayW - 1;
    b.rect(px, deckY + deckH, 7, 3, 0x9a928a);
    b.rect(px, deckY + deckH, 7, 1, 0xc8c1b8);
  }
  // A step stone in front of the open room, and sandals on it.
  const room = bays.indexOf("room");
  if (room >= 0) {
    const sx = left + 5 + room * bayW + 4;
    b.rect(sx, deckY + deckH, bayW - 13, 4, 0xc8c1b8);
    b.rect(sx, deckY + deckH, bayW - 13, 1, 0xe8e2da);
    b.rect(sx, deckY + deckH + 3, bayW - 13, 1, 0x8d847b);
    for (const gx of [sx + 4, sx + 9]) {
      b.rect(gx, deckY + deckH + 1, 3, 2, W.mid);
      b.set(gx + 1, deckY + deckH + 1, 0xc84a3a);
    }
  }

  // The roof: a hip of thatch, wider at the eave than at the ridge.
  for (let y = 0; y < roofH; y++) {
    const t = y / roofH;
    const half = Math.round(front * 0.33 + Math.pow(t, 0.6) * (w / 2 - front * 0.33));
    const L = Math.round(w / 2 - half);
    const R = Math.round(w / 2 + half);
    const hip = Math.round(5 + t * 16);
    for (let x = L; x < R; x++) {
      const lift = thatchBlotch(x, y, seed);
      const hollow = noise(x * 0.4, y * 1.3, 5, seed + 3) < 0.18;
      let c: Rgb =
        lift > 0 ? (lift > 0.55 ? THATCH.hi : mix(THATCH.base, THATCH.hi, 0.55)) : THATCH.base;
      if (hollow && lift <= 0) c = THATCH.lo;
      if (x < L + hip) c = mix(c, THATCH.hi, 0.3); // the sunlit hip
      if (x >= R - hip) c = mix(c, THATCH.deep, 0.42); // the shaded hip
      if (x === L + hip || x === R - hip - 1) c = THATCH.lo; // hip ridges
      if (t < 0.4 && noise(x, y, 3, seed + 21) > 0.82) c = mix(c, THATCH.moss, 0.55); // moss
      if (y >= roofH - 6) {
        const tooth = Math.floor(hash(Math.floor(x / 2), 9, seed) * 4);
        c = y >= roofH - 6 + tooth ? THATCH.deep : THATCH.lo;
      }
      b.set(x, y, c);
    }
  }
  // The ridge, capped, with a little smoke vent at its middle.
  const rL = Math.round(w / 2 - front * 0.33) + 2;
  const rR = Math.round(w / 2 + front * 0.33) - 2;
  b.rect(rL, 0, rR - rL, 5, THATCH.lo);
  b.rect(rL, 0, rR - rL, 1, THATCH.hi);
  b.rect(rL + 2, 2, rR - rL - 4, 2, W.deep);
  for (let x = rL + 6; x < rR - 6; x += 12) b.rect(x, 1, 3, 4, W.line);
  const vx = Math.round(w / 2) - 9;
  b.rect(vx, 0, 18, 7, W.frame);
  for (let xx = 1; xx < 17; xx += 2) b.rect(vx + xx, 2, 1, 4, PAPER.shade);
  b.rect(vx - 2, 0, 22, 2, THATCH.lo);
  // Rafter ends under the eave, then the lintel beam over the bays.
  for (let x = left - 7; x < left + front + 7; x += 6) {
    b.rect(x, eaveY, 4, 3, PAPER.base);
    b.rect(x + 3, eaveY, 1, 3, W.base);
    b.rect(x, eaveY + 3, 4, 1, W.line);
  }
  b.rect(left - 3, lintelY - 1, front + 6, 3, W.warm);
  b.rect(left - 3, lintelY - 1, front + 6, 1, W.hi);
  b.rect(left - 3, lintelY + 2, front + 6, 1, W.line);
  // The eave's shadow down the top of the front.
  for (let x = left; x < left + front; x++) {
    for (let k = 3; k < 8; k++) b.set(x, lintelY + k, W.line, 0.34 - (k - 3) * 0.07);
  }

  // A red paper lantern, and a glass wind chime with its paper strip.
  const lx = left + Math.max(1, room) * bayW + 2;
  b.rect(lx, eaveY + 4, 1, 4, W.line);
  b.ellipse(lx + 0.5, eaveY + 12, 3.2, 4.2, 0xd8394a);
  b.rect(lx - 2, eaveY + 9, 1, 7, 0xa82838);
  b.rect(lx + 2, eaveY + 9, 1, 7, 0xa82838);
  b.rect(lx - 1, eaveY + 11, 3, 2, 0xffb070);
  b.rect(lx - 2, eaveY + 8, 5, 1, 0x2a1a14);
  b.rect(lx - 2, eaveY + 16, 5, 1, 0x2a1a14);
  const cx = left + bayW + 14;
  b.rect(cx, eaveY + 4, 1, 3, W.line);
  b.ellipse(cx + 0.5, eaveY + 8, 2, 1.8, 0xbfe4ee);
  b.set(cx, eaveY + 7, 0xffffff);
  b.rect(cx, eaveY + 10, 1, 2, W.line);
  b.rect(cx - 1, eaveY + 12, 3, 5, PAPER.lit);
  b.rect(cx - 1, eaveY + 14, 3, 1, 0xd8394a);

  b.outline(0.9, W.line);
  return {
    buf: b,
    ax: Math.round(w / 2),
    ay: deckY + deckH + 1,
    shadow: { a: 0.34 },
  };
}

/**
 * A side wing with a board roof held down by stones and battens, a plaster
 * wall in a dark timber frame, a barred window, and firewood stacked under a
 * lean-to.
 */
export function annex(seed: number): Sprite {
  const w = 76;
  const h = 70;
  return sprite(
    w,
    h,
    44,
    68,
    (b) => {
      // The wall: plaster panels in a timber frame, with a barred window.
      b.rect(24, 30, 48, 36, 0xe9dbb9);
      for (const x of [24, 47, 70]) b.rect(x, 30, 3, 36, W.base);
      b.rect(24, 30, 48, 3, W.warm);
      b.rect(24, 52, 48, 3, W.warm);
      b.rect(24, 63, 48, 3, W.face);
      b.rect(31, 36, 12, 12, W.deep);
      for (let x = 32; x < 43; x += 2) b.rect(x, 36, 1, 12, 0xc8a868);
      b.rect(30, 35, 14, 1, W.hi);
      b.rect(50, 36, 17, 14, 0xd6c7ad);
      b.rect(50, 36, 17, 1, W.shadow);
      // The board roof: planks running down the slope, battens across, stones.
      for (let y = 4; y < 30; y++) {
        const inset = Math.round((30 - y) * 0.25);
        for (let x = 18 + inset; x < 76 - inset * 0.3; x++) {
          const plank = (x - 18) % 5 === 0;
          let c: Rgb = plank ? W.base : x < 34 ? W.hi : W.warm;
          if (y % 8 === 0) c = W.face;
          if (hash(x, y, seed) < 0.03) c = W.light;
          b.set(x, y, c);
        }
      }
      for (const [sx, sy] of [
        [28, 8],
        [44, 16],
        [60, 9],
        [36, 22],
        [66, 20],
      ] as const) {
        b.ellipse(sx, sy, 3, 2.2, 0xb0a89f);
        b.set(sx - 1, sy - 1, 0xe2dcd4);
      }
      b.rect(18, 28, 58, 3, W.shadow);
      // The lean-to on the left, with split logs stacked under it.
      for (let y = 22; y < 30; y++) {
        for (let x = 2; x < 26; x++) b.set(x, y, (x - 2) % 4 === 0 ? W.base : W.warm);
      }
      b.rect(2, 29, 24, 2, W.shadow);
      b.rect(4, 31, 2, 35, W.base);
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 3; c++) {
          const lx = 8 + c * 6 + (r % 2) * 3;
          const ly = 44 + r * 6;
          b.ellipse(lx, ly, 2.8, 2.6, 0xc98149);
          b.ellipse(lx, ly, 1.6, 1.4, 0xe8c08a);
          b.set(lx, ly, 0xb87a40);
        }
      }
    },
    { a: 0.3 },
  );
}

/** A little wooden dog house with a gable roof, an arched door and a bowl. */
export function kennel(): Sprite {
  return sprite(
    30,
    30,
    15,
    28,
    (b) => {
      for (let y = 12; y < 26; y++) {
        for (let x = 4; x < 26; x++)
          b.set(x, y, (x - 4) % 4 === 0 ? W.base : x < 8 ? W.light : W.warm);
      }
      b.ellipse(15, 21, 5, 6, W.line);
      b.rect(10, 21, 11, 5, W.line);
      b.ellipse(15, 21, 3.6, 4.6, 0x2a1408);
      b.rect(12, 7, 7, 3, PAPER.base);
      b.rect(12, 7, 7, 1, W.frame);
      for (let y = 0; y < 13; y++) {
        const half = Math.round(4 + y * 0.95);
        for (let x = 15 - half; x <= 15 + half; x++) {
          const right = x > 15;
          const course = (y + Math.abs(x - 15)) % 4 === 0;
          b.set(x, y + 1, course ? W.base : right ? W.face : W.hi);
        }
      }
      b.ellipse(23, 27, 3.4, 1.8, 0xc84a3a);
      b.ellipse(23, 26.6, 2.4, 1, 0x8a2a20);
    },
    { a: 0.3 },
  );
}

// ── Stations, in the farm's style ────────────────────────────

/**
 * A low wooden table from high above with a laptop open on it: the table's
 * top is most of it (boards lit along the back, grain, a thick front edge,
 * short legs); the laptop's screen stands at the back, its glow lit at the
 * top, its keyboard a grey slab in front; a cup of tea steams beside it.
 */
export function laptopTable(): Sprite {
  const w = 28;
  const h = 20;
  return sprite(
    w,
    h,
    14,
    18,
    (b) => {
      // Legs.
      for (const x of [3, 23]) {
        b.rect(x, 14, 2, 4, W.face);
        b.rect(x, 14, 1, 4, W.light);
      }
      // The top, seen deep, its front edge thick.
      for (let y = 5; y < 15; y++) {
        for (let x = 1; x < w - 1; x++) {
          let c: Rgb = y === 5 ? W.hi : y >= 13 ? (y === 14 ? W.face : W.base) : W.warm;
          if (y > 5 && y < 13 && (y - 5) % 4 === 0)
            c = W.mid; // board seams
          else if (y > 5 && y < 13 && noise(x, y * 3, 4, 7) > 0.74) c = W.light;
          b.set(x, y, c);
        }
      }
      // The laptop: the screen at the back, then the keyboard.
      b.rect(8, 0, 12, 8, 0x2a2a34);
      b.rect(9, 1, 10, 6, 0x4ab8e0);
      b.rect(9, 1, 10, 2, 0x8ad8f8);
      b.rect(10, 4, 5, 1, 0xd8f4ff);
      b.rect(10, 5, 3, 1, 0xb8ecff);
      b.rect(7, 8, 14, 4, 0x8a8a96);
      b.rect(7, 8, 14, 1, 0xb8b8c4);
      for (let x = 8; x < 20; x += 2) b.set(x, 9, 0x5a5a66);
      for (let x = 9; x < 19; x += 2) b.set(x, 10, 0x5a5a66);
      b.rect(12, 11, 4, 1, 0x6a6a76); // the trackpad
      // A cup of tea.
      b.ellipse(24, 9, 2, 1.6, 0xf2ece0);
      b.ellipse(24, 8.8, 1.2, 0.8, 0x8aa040);
      b.set(23, 10, 0xb8b0a0);
    },
    { a: 0.28 },
  );
}

/**
 * A low bookcase from high above: its top board seen deep (grained, lit
 * along the back, a book lying open on it), then the shelves below, each a
 * row of spines (every book its own colour, height and lean, a lit edge down
 * one side), shaded under the shelf above, in a frame lit on its left.
 */
export function bookcase(seed: number): Sprite {
  const w = 24;
  const h = 24;
  const SPINES = [0xc84a3a, 0x3a6aa8, 0xe8b84a, 0x5a8a3a, 0x8a4aa0, 0xd88a4a, 0x3a8a8a, 0xf0e0c0];
  return sprite(
    w,
    h,
    12,
    22,
    (b) => {
      // The frame and the dark backs of the shelves.
      b.rect(1, 6, 22, 16, W.base);
      b.rect(1, 6, 1, 16, W.hi);
      b.rect(22, 6, 1, 16, W.face);
      b.rect(3, 7, 18, 13, W.deep);
      // Two shelves of books.
      for (const [top, bottom] of [
        [7, 13],
        [14, 20],
      ] as const) {
        let x = 3;
        while (x < 21) {
          const bw = 1 + Math.floor(hash(x, top, seed) * 2.4);
          const bh = Math.min(bottom - top, 4 + Math.floor(hash(x, top + 1, seed) * 3));
          const color = SPINES[Math.floor(hash(x, top + 2, seed) * SPINES.length)] ?? 0xc84a3a;
          const bx = Math.min(bw, 21 - x);
          b.rect(x, bottom - bh, bx, bh, color);
          b.rect(x, bottom - bh, 1, bh, mix(color, 0xffffff, 0.3)); // a lit edge
          if (bh > 4) b.rect(x, bottom - bh + 1, bx, 1, mix(color, 0xffffff, 0.45)); // a band
          x += bx + (hash(x, top + 3, seed) < 0.15 ? 1 : 0);
        }
        // Shade under the shelf above.
        for (let xx = 3; xx < 21; xx++) b.set(xx, top, mix(b.rgb(xx, top), W.line, 0.45));
        b.rect(2, bottom, 20, 1, W.light);
        b.rect(2, bottom + 1, 20, 1, W.face);
      }
      // The top board, seen deep.
      for (let y = 1; y < 7; y++) {
        for (let x = 0; x < w; x++) {
          let c: Rgb = y === 1 ? W.hi : y === 6 ? W.face : W.warm;
          if (y > 1 && y < 6 && noise(x, y * 3, 4, seed) > 0.72) c = W.light;
          b.set(x, y, c);
        }
      }
      // A book lying open on top.
      b.rect(7, 2, 10, 4, PAPER.shade);
      b.rect(7, 2, 4, 3, PAPER.lit);
      b.rect(12, 2, 5, 3, PAPER.lit);
      b.rect(11, 2, 1, 4, W.frame);
      b.rect(8, 3, 2, 1, 0xb8a888);
      b.rect(13, 3, 3, 1, 0xb8a888);
    },
    { a: 0.28 },
  );
}

/** A carpenter's bench with a plane, a saw on the wall-peg and shavings. */
export function carpentryBench(): Sprite {
  return sprite(
    30,
    22,
    15,
    20,
    (b) => {
      b.rect(2, 8, 26, 4, W.hi);
      b.rect(2, 11, 26, 2, W.face);
      for (const x of [4, 24]) b.rect(x, 12, 3, 8, W.base);
      b.rect(4, 16, 23, 1, W.base);
      b.rect(9, 5, 8, 3, W.warm);
      b.rect(10, 4, 3, 1, 0x3c3430);
      b.rect(19, 6, 6, 2, 0xc8c1b8);
      b.rect(19, 5, 2, 1, W.base);
      for (const [x, y] of [
        [6, 19],
        [12, 20],
        [20, 19],
        [16, 21],
      ] as const) {
        b.rect(x, y, 2, 1, 0xf0d0a0);
      }
    },
    { a: 0.3 },
  );
}

/** A clay kamado stove with two fire mouths glowing and a pot steaming on top. */
export function kamado(): Sprite {
  return sprite(
    30,
    24,
    15,
    22,
    (b) => {
      for (let y = 8; y < 22; y++) {
        for (let x = 2; x < 28; x++) {
          const round = (x - 15) ** 2 / 169 + (y - 15) ** 2 / 400 > 1;
          if (round) continue;
          b.set(x, y, y < 11 ? 0xe2b07a : x < 9 ? 0xd09a62 : x > 22 ? 0x9a6436 : 0xb8804a);
        }
      }
      for (const fx of [9, 20]) {
        b.ellipse(fx, 17, 3, 2.8, 0x2a1408);
        b.ellipse(fx, 18, 2, 1.6, 0xff8a2a);
        b.set(fx, 17, 0xffd27a);
      }
      b.ellipse(15, 7, 7, 2.6, 0x3c3430);
      b.ellipse(15, 6, 5.6, 1.8, 0x5a524c);
      b.rect(13, 3, 4, 2, 0x3c3430);
    },
    { a: 0.3 },
  );
}

/** A wooden board under a little roof, with notes, a plan and a red seal pinned to it. */
export function notesBoard(seed: number): Sprite {
  return sprite(
    30,
    32,
    15,
    30,
    (b) => {
      for (const x of [5, 23]) b.rect(x, 8, 2, 22, W.base);
      b.rect(3, 9, 24, 15, W.warm);
      b.rect(3, 9, 24, 1, W.hi);
      b.rect(4, 10, 22, 13, 0xd8b884);
      const rnd = stream(seed);
      for (let i = 0; i < 4; i++) {
        const nx = 5 + i * 5 + Math.round(rnd() * 2);
        const ny = 11 + Math.round(rnd() * 4);
        b.rect(nx, ny, 4, 6, PAPER.lit);
        b.rect(nx + 1, ny + 2, 2, 1, 0x8a8a9a);
        b.rect(nx + 1, ny + 4, 2, 1, 0x8a8a9a);
        b.set(nx + 1, ny, 0xc84a3a);
      }
      b.ellipse(22, 20, 1.6, 1.6, 0xd8394a);
      for (let y = 0; y < 8; y++) {
        const half = Math.round(6 + y * 1.4);
        for (let x = 15 - half; x <= 15 + half; x++)
          b.set(x, y + 1, y === 7 ? W.base : x > 15 ? W.face : W.hi);
      }
    },
    { a: 0.3 },
  );
}

/** A red Japanese pillar post box, with a white slot plate. */
export function postBox(): Sprite {
  return sprite(
    14,
    24,
    7,
    22,
    (b) => {
      b.ellipse(7, 4, 5, 2.6, 0xe0403a);
      b.ellipse(6.5, 3.4, 3.4, 1.4, 0xf87a6a);
      b.rect(2, 4, 10, 17, 0xc8302c);
      b.rect(2, 4, 2, 17, 0xe85a50);
      b.rect(10, 4, 2, 17, 0x8a1e1c);
      b.rect(4, 8, 6, 2, 0x2a1408);
      b.rect(4, 12, 6, 4, PAPER.lit);
      b.rect(5, 13, 4, 1, 0xc8302c);
      b.rect(1, 20, 12, 2, 0x5a524c);
    },
    { a: 0.3 },
  );
}

/** The fishing spot's creel: a woven basket for the catch. */
export function fishingSpot(): Sprite {
  return sprite(
    34,
    26,
    8,
    24,
    (b) => {
      b.ellipse(8, 20, 5, 4, 0xc8a868);
      for (let x = 4; x < 13; x += 2) b.rect(x, 17, 1, 7, 0x9a7a3a);
      b.ellipse(8, 17, 4, 1.4, 0x5a3a1a);
    },
    { a: 0.28 },
  );
}

/** A long bench with a red felt cloth, a tea tray and a red parasol: the place to wait. */
export function teaBench(): Sprite {
  return sprite(
    44,
    40,
    22,
    38,
    (b) => {
      b.rect(4, 26, 36, 5, 0xc8302c);
      b.rect(4, 26, 36, 1, 0xe85a50);
      b.rect(4, 30, 36, 1, 0x8a1e1c);
      for (const x of [6, 36]) b.rect(x, 31, 3, 7, W.base);
      b.rect(26, 23, 9, 3, W.warm);
      b.ellipse(29, 22, 2, 1.6, 0x5a7a4a);
      b.rect(32, 22, 2, 1, PAPER.lit);
      // The parasol: a wide, shallow red cone on a bamboo pole.
      b.rect(12, 6, 1, 22, 0xc8a868);
      for (let y = 0; y < 8; y++) {
        const half = Math.round(4 + y * 2.2);
        for (let x = 12 - half; x <= 12 + half; x++) {
          const rib = (x - 12 + 30) % 5 === 0;
          b.set(x, y, rib ? 0xa82838 : x < 12 ? 0xe85a50 : 0xc8302c);
        }
      }
      b.rect(-6 + 12, 7, 25, 1, 0x8a1e1c);
    },
    { a: 0.3 },
  );
}

// ── Little things ────────────────────────────────────────────

/** A forked twig lying on the ground. */
export function twig(seed: number): Sprite {
  return sprite(
    14,
    8,
    7,
    6,
    (b) => {
      const flip = hash(seed, 0, 1) < 0.5;
      for (let i = 0; i < 11; i++) b.set(flip ? 12 - i : 1 + i, 5 - Math.round(i * 0.25), W.base);
      for (let i = 0; i < 4; i++) b.set(flip ? 7 - i : 6 + i, 3 - i, W.base);
    },
    undefined,
    0.7,
  );
}

/**
 * A bare patch worn into the grass, flat on the ground: a lumpy, ragged-edged
 * splash of earth (never a circle), a lighter worn patch or two inside it, a
 * darker rim where the grass gives way, and the odd blade still growing in it.
 */
export function dirtPatch(seed: number, size: "s" | "l" = "s"): Sprite {
  const rx = (size === "l" ? 15 : 7) + hash(seed, 0, 5) * (size === "l" ? 6 : 4);
  const ry = rx * (0.48 + hash(seed, 1, 5) * 0.16);
  const w = Math.ceil(rx * 2) + 6;
  const h = Math.ceil(ry * 2) + 6;
  const cx = w / 2;
  const cy = h / 2;
  // A few overlapping lobes make the shape lumpy.
  const rnd = stream(seed);
  const lobes = Array.from({ length: 4 }, () => ({
    x: cx + (rnd() - 0.5) * rx * 0.9,
    y: cy + (rnd() - 0.5) * ry * 0.8,
    rx: rx * (0.45 + rnd() * 0.3),
    ry: ry * (0.5 + rnd() * 0.35),
  }));
  const inside = (x: number, y: number): boolean => {
    const edge = (noise(x, y, 2.6, seed) - 0.5) * 0.5;
    return lobes.some(
      (l) => ((x + 0.5 - l.x) / l.rx) ** 2 + ((y + 0.5 - l.y) / l.ry) ** 2 <= 1 + edge,
    );
  };
  const DIRT = { base: 0xd08f35, light: 0xdcab6f, worn: 0xe2b878, rim: 0xac7841, blade: 0x7c8a30 };
  return sprite(
    w,
    h,
    Math.round(cx),
    Math.round(cy),
    (b) => {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!inside(x, y)) continue;
          let c: Rgb = DIRT.base;
          const n = noise(x * 0.8, y, 6, seed + 1);
          if (n > 0.66) c = DIRT.light;
          if (n > 0.8) c = DIRT.worn;
          // The rim along its top edge: the grass overhangs it a little.
          if (!inside(x, y - 1) || !inside(x - 1, y)) c = DIRT.rim;
          b.set(x, y, c);
        }
      }
      // A blade or two still growing in the bare earth.
      for (let i = 0; i < (size === "l" ? 3 : 1); i++) {
        const x = Math.round(cx + (rnd() - 0.5) * rx);
        const y = Math.round(cy + (rnd() - 0.5) * ry * 0.6);
        if (!inside(x, y) || !inside(x, y - 1)) continue;
        b.set(x, y, DIRT.blade);
        b.set(x + 1, y - 1, DIRT.blade);
        b.set(x - 1, y - 1, DIRT.blade);
      }
    },
    undefined,
    0,
  );
}

/** A sprig of grass poking up from the foot of a wall: three to five blades, each its own height. */
export function grassSprig(seed: number): Sprite {
  const G = { dark: 0x5e6923, base: 0x7c8a30, light: 0x9aab3e };
  return sprite(
    9,
    8,
    4,
    7,
    (b) => {
      const rnd = stream(seed);
      const blades = 3 + Math.floor(rnd() * 3);
      for (let i = 0; i < blades; i++) {
        const bx = 1 + Math.round((i / Math.max(1, blades - 1)) * 6);
        const len = 2 + Math.floor(rnd() * 4);
        const lean = bx < 4 ? -1 : bx > 4 ? 1 : 0;
        for (let k = 0; k < len; k++) {
          const x = bx + (k >= len - 1 ? lean : 0);
          b.set(x, 7 - k, k === len - 1 ? G.light : k === 0 ? G.dark : G.base);
        }
      }
    },
    undefined,
    0.6,
  );
}

/** A few pebbles. */
export function pebbles(seed: number): Sprite {
  return sprite(
    12,
    7,
    6,
    5,
    (b) => {
      const rnd = stream(seed);
      for (let i = 0; i < 3; i++) {
        const x = 2 + Math.round(rnd() * 7);
        const y = 2 + Math.round(rnd() * 2);
        b.rect(x, y, 2, 1, ST.light);
        b.set(x, y + 1, ST.mid);
      }
    },
    undefined,
    0.7,
  );
}
