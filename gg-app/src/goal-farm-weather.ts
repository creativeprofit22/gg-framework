// What weather leaves on the farm. Snow settles on roofs, canopies and caps
// first, then the ground, building up the longer it falls (to a limit) and
// melting after; rain darkens everything it wets, puts a sheen on roofs, and
// gathers in puddles on the dirt, drying after. Both are baked into the map
// image (with the time of day's grade), so they cost nothing per frame; the
// map is rebuilt only when the cover changes by a step. Pure.

import { SURFACE } from "./goal-farm-map";
import { gradePixel, weatherFor, type FarmSky } from "./goal-farm-sky";
import { PixelBuffer, hash, mix, noise, type Rgb } from "./goal-map-pixels";

/** What lies on the ground, and how much (0 = none, 1 = as much as there gets). */
export interface Cover {
  readonly kind: "snow" | "rain";
  readonly level: number;
}

/**
 * How long snow or rain takes to build up fully, and to melt or dry after.
 * Snow settles slowly over a whole spell, rain soaks in faster.
 */
const BUILD_MIN = { snow: 240, rain: 60 } as const;
const CLEAR_MIN = { snow: 120, rain: 60 } as const;

/**
 * What's on the ground at a moment, from the weather now and in the last
 * four-hour spell: building up while it falls (full if it fell last spell
 * too), melting or drying away after it stops. Null when the ground is clear.
 */
export function coverAt(date: Date): Cover | null {
  const now = weatherFor(date);
  const before = weatherFor(new Date(date.getTime() - 4 * 3_600_000));
  const minutes = (date.getHours() % 4) * 60 + date.getMinutes();
  if (now === "snow" || now === "rain") {
    const level = before === now ? 1 : Math.min(1, minutes / BUILD_MIN[now]);
    return { kind: now, level };
  }
  if (before === "snow" || before === "rain") {
    const level = Math.max(0, 1 - minutes / CLEAR_MIN[before]);
    return level > 0 ? { kind: before, level } : null;
  }
  return null;
}

/** The cover rounded to a step, so the map is rebuilt only a couple of dozen times as it builds or melts. */
export const COVER_STEPS = 24;
export function coverStep(cover: Cover | null): Cover | null {
  if (!cover) return null;
  const level = Math.round(cover.level * COVER_STEPS) / COVER_STEPS;
  return level > 0 ? { kind: cover.kind, level } : null;
}

const SNOW = { lit: 0xffffff, body: 0xeef3fa, shade: 0xc8d4e6, deep: 0xa8b8d0 } as const;
const PUDDLE = { body: 0x7e98ae, deep: 0x5e7890, rim: 0x5a3c26, glint: 0xd8e8f2 } as const;

const channels = (c: Rgb): [number, number, number] => [(c >> 16) & 255, (c >> 8) & 255, c & 255];
const pack = ([r, g, b]: readonly [number, number, number]): Rgb => (r << 16) | (g << 8) | b;

/** Warm bare earth (the yard and its paths), as opposed to grass or stone. */
function isDirt(c: Rgb): boolean {
  const [r, g, b] = channels(c);
  return r > 120 && r > g + 22 && g > b;
}

/** A darker, slightly deeper version of a colour: how it looks wet. */
function wet(c: Rgb, amount: number): Rgb {
  const [r, g, b] = channels(c);
  const k = 1 - 0.3 * amount;
  const l = 0.299 * r + 0.587 * g + 0.114 * b;
  const sat = 1 + 0.25 * amount;
  const f = (v: number): number => Math.max(0, Math.min(255, Math.round((l + (v - l) * sat) * k)));
  return pack([f(r), f(g), f(b)]);
}

/** How bright a colour is, 0–1. */
const lum = (c: Rgb): number => {
  const [r, g, b] = channels(c);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
};

/**
 * How much snow a pixel holds at `level` (0 none, up to 1 a full clump): the
 * lightest dusting, never a blanket. Roofs, canopies and caps catch a few
 * small clumps (about a fifth of them at most); the grass gets a sprinkle of
 * flecks; stones, fields and the trodden dirt almost none. Never on outlines
 * (the darkest pixels), so every shape keeps its edges and texture.
 *
 * Each clump is a smooth mound of noise: as the level rises it spreads from
 * its middle out, and as the level falls (melting) it shrinks back into its
 * middle and thins, so snow melts the way it does, from the edges in, never
 * vanishing pixel by pixel at random.
 */
function snowAt(
  code: number,
  base: Rgb,
  x: number,
  y: number,
  level: number,
  seed: number,
): number {
  if (code === SURFACE.side || code === SURFACE.water) return 0;
  if (lum(base) < 0.2) return 0;
  // Smooth noise only (no per-pixel hash), so clumps have soft, round edges.
  const mound = noise(x, y, 4, seed) * 0.75 + noise(x, y, 9, seed + 9) * 0.25;
  const reach =
    code === SURFACE.top ? 0.34 : code === SURFACE.flat ? 0.14 : isDirt(base) ? 0.08 : 0.18;
  // How far above the waterline this pixel's mound stands at this level.
  const depth = mound - (1 - reach * level);
  if (depth <= 0) return 0;
  return Math.min(1, depth / 0.06);
}

/**
 * Puddles: a few rounded pools in low spots of the dirt, each growing with
 * the rain from a small pool to a wide one, its edge softly uneven, and only
 * where the whole pool fits on open dirt.
 */
function findPuddles(
  width: number,
  height: number,
  dirtAt: (x: number, y: number) => boolean,
  level: number,
  seed: number,
): Uint8Array {
  const out = new Uint8Array(width * height);
  const CELL = 28;
  for (let cy = 0; cy < height; cy += CELL) {
    for (let cx = 0; cx < width; cx += CELL) {
      // Not every low spot holds water; the deeper ones fill first.
      const depth = hash(cx, cy, seed + 11);
      if (depth < 0.45 || depth < 1 - level) continue;
      const px = Math.floor(cx + hash(cx, cy, seed + 12) * CELL);
      const py = Math.floor(cy + hash(cx, cy, seed + 13) * CELL);
      if (!dirtAt(px, py)) continue;
      const rx = 2.5 + (depth - 0.45) * 12 * level;
      const ry = rx * (0.4 + hash(cx, cy, seed + 14) * 0.15);
      const cells: number[] = [];
      let fits = true;
      for (let y = Math.floor(py - ry - 1); y <= py + ry + 1 && fits; y++) {
        for (let x = Math.floor(px - rx - 1); x <= px + rx + 1; x++) {
          const d = ((x + 0.5 - px) / rx) ** 2 + ((y + 0.5 - py) / ry) ** 2;
          if (d > 1 + (noise(x, y, 2, seed + 15) - 0.5) * 0.5) continue;
          if (!dirtAt(x, y)) {
            fits = false;
            break;
          }
          cells.push(y * width + x);
        }
      }
      if (fits) for (const i of cells) out[i] = 1;
    }
  }
  return out;
}

/**
 * Bake what the weather left onto a copy of the map, then grade it for the
 * time of day. `surface` says what each pixel is (see SURFACE). Returns the
 * picture and where the puddles are (rain landing in one makes a ring).
 */
export function weatherBackground(
  base: PixelBuffer,
  surface: Uint8Array,
  sky: FarmSky,
  cover: Cover | null,
  seed: number,
): { pixels: PixelBuffer; puddles: Uint8Array } {
  const { width, height } = base;
  const out = new PixelBuffer(width, height);
  out.data.set(base.data);
  const puddles = new Uint8Array(width * height);
  const codeAt = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= width || y >= height ? SURFACE.side : (surface[y * width + x] ?? 0);
  if (cover?.kind === "snow") {
    const snowy = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        snowy[y * width + x] = snowAt(codeAt(x, y), base.rgb(x, y), x, y, cover.level, seed);
      }
    }
    paintSnow(out, base, snowy, (x, y) => codeAt(x, y), cover.level);
  } else if (cover?.kind === "rain") {
    const a = cover.level;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const code = codeAt(x, y);
        if (code === SURFACE.water) continue;
        const c = base.rgb(x, y);
        let next = wet(c, a * (code === SURFACE.side ? 0.6 : 1));
        // A wet sheen on roofs and stones: pale glints in streaks down the slope.
        if ((code === SURFACE.top || code === SURFACE.flat) && a > 0.25) {
          if (noise(x * 0.6, y * 2.4, 3, seed + 3) > 0.8) next = mix(next, PUDDLE.glint, 0.35 * a);
        }
        out.set(x, y, next);
      }
    }
    const dirtAt = (x: number, y: number): boolean =>
      x >= 0 &&
      y >= 0 &&
      x < width &&
      y < height &&
      codeAt(x, y) === SURFACE.ground &&
      isDirt(base.rgb(x, y));
    puddles.set(findPuddles(width, height, dirtAt, a, seed));
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!puddles[y * width + x]) continue;
        const up = puddles[(y - 1) * width + x] === 1;
        const down = puddles[(y + 1) * width + x] === 1;
        // Its far bank throws a dark lip on it; its near edge catches the sky;
        // a faint reflection streak runs across the middle.
        let c: Rgb = PUDDLE.body;
        if (!up) c = PUDDLE.rim;
        else if (!puddles[(y - 2) * width + x]) c = PUDDLE.deep;
        else if (!down) c = PUDDLE.glint;
        else if (hash(x >> 2, y, seed + 7) < 0.12) c = mix(PUDDLE.body, PUDDLE.glint, 0.5);
        out.set(x, y, c);
      }
    }
  }
  grade(out, sky);
  return { pixels: out, puddles };
}

/**
 * The same for one standing prop drawn on its own (redrawn over critters
 * passing behind it): snow or wet on its sky-facing rows, then the grade.
 * (`mapX`, `mapY`) is where its top-left sits on the map, for the noise to match.
 */
export function weatherSprite(
  buf: PixelBuffer,
  topRow: number,
  mapX: number,
  mapY: number,
  flip: boolean,
  sky: FarmSky,
  cover: Cover | null,
  seed: number,
): PixelBuffer {
  const out = new PixelBuffer(buf.width, buf.height);
  out.data.set(buf.data);
  const mx = (sx: number): number => mapX + (flip ? buf.width - 1 - sx : sx);
  const codeAt = (sx: number, sy: number): number =>
    !buf.opaque(sx, sy) ? SURFACE.side : sy <= topRow ? SURFACE.top : SURFACE.side;
  if (cover?.kind === "snow") {
    const snowy = new Float32Array(buf.width * buf.height);
    for (let y = 0; y < buf.height; y++) {
      for (let x = 0; x < buf.width; x++) {
        if (!buf.opaque(x, y)) continue;
        snowy[y * buf.width + x] = snowAt(
          codeAt(x, y),
          buf.rgb(x, y),
          mx(x),
          mapY + y,
          cover.level,
          seed,
        );
      }
    }
    paintSnow(out, buf, snowy, codeAt, cover.level);
  } else if (cover?.kind === "rain") {
    for (let y = 0; y < buf.height; y++) {
      for (let x = 0; x < buf.width; x++) {
        if (!buf.opaque(x, y)) continue;
        const code = codeAt(x, y);
        let next = wet(buf.rgb(x, y), cover.level * (code === SURFACE.side ? 0.6 : 1));
        if (code === SURFACE.top && cover.level > 0.25) {
          if (noise(mx(x) * 0.6, (mapY + y) * 2.4, 3, seed + 3) > 0.8) {
            next = mix(next, PUDDLE.glint, 0.35 * cover.level);
          }
        }
        out.set(x, y, next);
      }
    }
  }
  grade(out, sky);
  return out;
}

/**
 * Lay snow on a picture: each pixel takes as much as `snowy` says (0–1), as
 * a thin layer the surface shows through, lit along each clump's top and
 * shaded along its bottom like snow sitting on it. Thin snow at a clump's
 * edge is mostly the surface showing, so clumps fade out rather than stop.
 */
function paintSnow(
  out: PixelBuffer,
  under: PixelBuffer,
  snowy: Float32Array,
  _codeAt: (x: number, y: number) => number,
  _level: number,
): void {
  const { width, height } = out;
  const at = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= width || y >= height ? 0 : (snowy[y * width + x] ?? 0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const amount = at(x, y);
      if (amount <= 0) continue;
      const under0 = under.rgb(x, y);
      const l = Math.max(0, Math.min(1, (lum(under0) - 0.25) / 0.55));
      let c: Rgb = mix(SNOW.shade, SNOW.body, l);
      if (at(x, y - 1) < amount * 0.5) c = SNOW.lit;
      else if (at(x, y + 1) < amount * 0.5) c = mix(SNOW.shade, SNOW.deep, 0.4);
      // Thin at the edges, so a clump fades into the surface; in pixel steps.
      const cover = Math.round(Math.min(0.82, amount * 0.82) * 4) / 4;
      if (cover > 0) out.set(x, y, mix(under0, c, cover));
    }
  }
}

/** Grade every pixel for the time of day (see gradePixel). */
function grade(buf: PixelBuffer, sky: FarmSky): void {
  if (sky.grade < 0.01 && sky.lift < 0.01 && Math.abs(sky.saturation - 1) < 0.01) return;
  const d = buf.data;
  for (let i = 0; i < d.length; i += 4) {
    if ((d[i + 3] ?? 0) === 0) continue;
    const [r, g, b] = gradePixel(d[i] ?? 0, d[i + 1] ?? 0, d[i + 2] ?? 0, sky);
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
  }
}
