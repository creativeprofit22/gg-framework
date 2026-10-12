// Composes a top-down Goal map: the painted ground, then every prop and
// critter sorted by how far down the map it stands (so a critter walking
// "behind" a tree is covered by it), each with a soft shadow, then speech
// bubbles and labels on top. Pure: the same scene always paints the same
// pixels, so the mockups and the eventual live view can share it.

import { CRITTERS, frameRows } from "./critter-sprites";
import { GLYPHS as GLYPHS_3X5 } from "./goal-world-font";
import { paintGround, scatterDetails, type MapGrid } from "./goal-map-ground";
import { E, PixelBuffer, darken, hash, type Rgb } from "./goal-map-pixels";
import type { Sprite } from "./goal-map-props";

export interface PlacedProp {
  readonly sprite: Sprite;
  /** Where its anchor stands, in map pixels. */
  readonly x: number;
  readonly y: number;
  readonly flip?: boolean;
  /** Painted flat on the ground, under everything that stands (rugs, pads). */
  readonly flat?: boolean;
  /** A building: everything down to its eave is roof, open to the sky (for weather). */
  readonly roof?: boolean;
  /** Holds its place (nothing walks through it) but isn't painted: drawn live instead. */
  readonly hidden?: boolean;
}

export interface PlacedCritter {
  readonly id: string;
  /** Where its feet are, in map pixels. */
  readonly x: number;
  readonly y: number;
  readonly flip?: boolean;
  readonly frame?: 0 | 1;
  /** GG Goals wears a crown. */
  readonly crown?: boolean;
  /** Held up in front, like a book or a mug. */
  readonly holding?: Sprite;
  readonly say?: string;
  /** Rides something: drawn under the critter, which sits on top. */
  readonly ride?: Sprite;
  /** Airborne (jetpack): drawn this far above its feet; the shadow stays down. */
  readonly lift?: number;
}

export interface MapScene {
  readonly grid: MapGrid;
  readonly seed: number;
  readonly props: readonly PlacedProp[];
  readonly critters: readonly PlacedCritter[];
  /** Station names shown as small tags, for the mockups. */
  readonly labels?: ReadonlyArray<{
    readonly text: string;
    readonly x: number;
    readonly y: number;
  }>;
  /** A cool night grade over the whole map, for variety in the mockups. */
  readonly tint?: { readonly color: Rgb; readonly a: number };
  /**
   * Swap ground colours after painting (standard palette → this world's), so
   * one painter serves every look. Props and critters are not remapped.
   */
  readonly groundColors?: ReadonlyMap<Rgb, Rgb>;
  /** What shadows darken toward (a warm brown for cosy worlds). */
  readonly ink?: Rgb;
  /** Hide the station name tags (the cosy scenes read without them). */
  readonly hideLabels?: boolean;
}

const BY_ID = new Map(CRITTERS.map((critter) => [critter.id, critter]));

function shadow(
  buf: PixelBuffer,
  x: number,
  y: number,
  rx: number,
  ry: number,
  a = 0.3,
  ink: Rgb = E.ink,
): void {
  for (let yy = Math.floor(y - ry); yy <= y + ry; yy++) {
    for (let xx = Math.floor(x - rx); xx <= x + rx; xx++) {
      const dx = (xx + 0.5 - x) / rx;
      const dy = (yy + 0.5 - y) / ry;
      if (dx * dx + dy * dy > 1 || !buf.inside(xx, yy)) continue;
      buf.set(xx, yy, darken(buf.rgb(xx, yy), 0.5, ink), a / 0.3 > 1 ? 1 : a / 0.3);
    }
  }
}

/** The furthest a shadow sits below the thing casting it, in pixels. */
const SHADOW_DROP = 5;
/** The furthest up behind its base a tall thing's pooled shadow reaches. */
const POOL = 9;

/**
 * Mark where a standing prop's shadow falls: its own silhouette, nudged a
 * few pixels down (and one left), laid on the ground before the prop is
 * drawn over it. Only the rim peeking out under the prop shows, so the
 * shadow hugs its lower edge in its own shape: a dark crescent under a
 * canopy round the trunk, a band along a building's foot. Taller things drop
 * theirs a little further. Each ground pixel keeps the darkest shadow over
 * it, so overlaps don't stack.
 */
function castShadow(mask: Float32Array, width: number, height: number, p: PlacedProp): void {
  const { sprite } = p;
  const s = sprite.shadow;
  if (!s) return;
  const src = sprite.buf;
  let firstRow = src.height;
  for (let sy = 0; sy < src.height && firstRow === src.height; sy++) {
    for (let sx = 0; sx < src.width; sx++) {
      if ((src.data[(sy * src.width + sx) * 4 + 3] ?? 0) >= 128) {
        firstRow = sy;
        break;
      }
    }
  }
  const tallest = Math.max(1, sprite.ay - firstRow);
  const drop = Math.min(
    s.height ?? SHADOW_DROP,
    SHADOW_DROP,
    Math.max(2, Math.round(tallest / 10)),
  );
  const strength = s.a ?? 0.3;
  const ax = p.flip ? src.width - 1 - sprite.ax : sprite.ax;
  const left = Math.floor(p.x) - ax - 1;
  const top = Math.floor(p.y) - sprite.ay + drop;
  const base = Math.floor(p.y);
  // How far up from its base the pooled shadow under a tall thing reaches.
  const pool = Math.min(s.height ?? POOL, POOL, Math.round(tallest / 5));
  const mark = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = y * width + x;
    if ((mask[i] ?? 0) < strength) mask[i] = strength;
  };
  if (s.canopy) {
    // The sun is overhead, so a tree's shadow is one flat pool straight under
    // its canopy: about as wide as the canopy, a squat oval round the trunk's
    // foot with a softly lumpy rim (a few overlapping rounds, not a copy of
    // the leaves). The canopy hides its far half; the trunk stands in it.
    let minX = src.width;
    let maxX = -1;
    for (let sy = firstRow; sy <= sprite.ay && sy < src.height; sy++) {
      for (let sx = 0; sx < src.width; sx++) {
        if ((src.data[(sy * src.width + sx) * 4 + 3] ?? 0) < 128) continue;
        minX = Math.min(minX, sx);
        maxX = Math.max(maxX, sx);
      }
    }
    if (maxX < 0) return;
    const mid = (minX + maxX + 1) / 2;
    const cx = left + 1 + (p.flip ? src.width - mid : mid);
    const rx = ((maxX - minX + 1) / 2) * 0.82;
    const ry = Math.max(3, rx * 0.42);
    const cy = base - ry * 0.35;
    // The lumps: rounds spaced along the oval, each its own size.
    const lumps = 6;
    const rounds = Array.from({ length: lumps }, (_, k) => {
      const a = (k / lumps) * Math.PI * 2 + hash(k, 1, Math.floor(p.x)) * 0.6;
      return {
        x: cx + Math.cos(a) * rx * 0.55,
        y: cy + Math.sin(a) * ry * 0.55,
        r: 0.5 + hash(k, 2, Math.floor(p.y)) * 0.12,
      };
    });
    for (let y = Math.floor(cy - ry - 2); y <= cy + ry + 2; y++) {
      for (let x = Math.floor(cx - rx - 2); x <= cx + rx + 2; x++) {
        const inCore = ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 0.72;
        const inLump = rounds.some(
          (q) => ((x + 0.5 - q.x) / (rx * q.r)) ** 2 + ((y + 0.5 - q.y) / (ry * q.r)) ** 2 <= 1,
        );
        if (inCore || inLump) mark(x, y);
      }
    }
    return;
  }
  for (let sy = 0; sy < src.height; sy++) {
    // The pooled shadow: the whole silhouette squashed flat onto the ground
    // round its base, its top landing furthest back (hidden behind it).
    const t = Math.max(0, Math.min(1, (sprite.ay - sy) / tallest));
    const py = base + 1 - Math.round(t * pool);
    for (let sx = 0; sx < src.width; sx++) {
      if ((src.data[(sy * src.width + sx) * 4 + 3] ?? 0) < 128) continue;
      const x = left + (p.flip ? src.width - 1 - sx : sx);
      mark(x, top + sy);
      if (pool > 1) mark(x, py);
    }
  }
}

/** Darken the ground under every cast shadow, in one flat tone per strength. */
function applyShadows(buf: PixelBuffer, mask: Float32Array, ink: Rgb): void {
  for (let y = 0; y < buf.height; y++) {
    for (let x = 0; x < buf.width; x++) {
      const a = mask[y * buf.width + x] ?? 0;
      if (a > 0) buf.set(x, y, darken(buf.rgb(x, y), Math.min(0.6, a * 1.1), ink));
    }
  }
}

function drawProp(buf: PixelBuffer, p: PlacedProp): void {
  const { sprite } = p;
  const ax = p.flip ? sprite.buf.width - 1 - sprite.ax : sprite.ax;
  buf.draw(sprite.buf, p.x - ax, p.y - sprite.ay, p.flip ?? false);
}

const CRITTER = 14;

function critterBuffer(id: string, frame: 0 | 1): PixelBuffer {
  const def = BY_ID.get(id) ?? CRITTERS[0];
  const out = new PixelBuffer(CRITTER, CRITTER);
  if (def) out.stamp(frameRows(def, frame), def.palette, 0, 0);
  return out;
}

const CROWN = ["y..y..y", "yy.y.yy", "yyyyyyy", "ooooooo"];

function drawCritter(buf: PixelBuffer, c: PlacedCritter, ink: Rgb): void {
  const lift = c.lift ?? 0;
  shadow(buf, c.x, c.y, lift > 0 ? 5 : 6, lift > 0 ? 1.6 : 2.2, lift > 0 ? 0.22 : 0.34, ink);
  const rideH = c.ride ? c.ride.buf.height - 2 : 0;
  if (c.ride) {
    const r = c.ride;
    buf.draw(
      r.buf,
      c.x - (c.flip ? r.buf.width - 1 - r.ax : r.ax),
      c.y - r.ay - lift,
      c.flip ?? false,
    );
  }
  const left = Math.round(c.x - CRITTER / 2);
  const top = Math.round(c.y - CRITTER - rideH - lift);
  buf.draw(critterBuffer(c.id, c.frame ?? 0), left, top, c.flip ?? false);
  if (c.crown) buf.stamp(CROWN, { y: E.gold, o: E.amber }, left + 3, top - 3);
  if (c.holding) {
    const h = c.holding;
    const hx = c.flip ? left - h.buf.width + 5 : left + CRITTER - 5;
    buf.draw(h.buf, hx, top + 7, c.flip ?? false);
  }
}

/** Width of `text` in the 3×5 font, in pixels. */
export function textWidth(text: string): number {
  return text.length === 0 ? 0 : text.length * 4 - 1;
}

function drawText(buf: PixelBuffer, text: string, x: number, y: number, color: Rgb): void {
  let left = Math.round(x);
  for (const ch of text.toUpperCase()) {
    const glyph = GLYPHS_3X5[ch] ?? GLYPHS_3X5["?"] ?? [];
    glyph.forEach((row, dy) => {
      for (let dx = 0; dx < row.length; dx++)
        if (row[dx] === "#") buf.set(left + dx, y + dy, color);
    });
    left += 4;
  }
}

/** A speech bubble with a tail, pointing down at (cx, bottom). */
function drawBubble(buf: PixelBuffer, text: string, cx: number, bottom: number): void {
  const w = textWidth(text) + 6;
  const h = 11;
  const x = Math.min(buf.width - w - 2, Math.max(2, Math.round(cx - w / 2)));
  const y = Math.round(bottom - h - 4);
  // Rounded body: cut the corners, ring it in ink.
  buf.rect(x + 1, y, w - 2, h, E.ink);
  buf.rect(x, y + 1, w, h - 2, E.ink);
  buf.rect(x + 1, y + 1, w - 2, h - 2, E.cream);
  buf.rect(x + 1, y + h - 2, w - 2, 1, E.sand);
  // Tail.
  const tx = Math.round(cx);
  buf.rect(tx - 2, y + h - 1, 5, 1, E.cream);
  buf.set(tx - 3, y + h - 1, E.ink);
  buf.set(tx + 3, y + h - 1, E.ink);
  buf.rect(tx - 1, y + h, 3, 1, E.cream);
  buf.set(tx - 2, y + h, E.ink);
  buf.set(tx + 2, y + h, E.ink);
  buf.set(tx, y + h + 1, E.cream);
  buf.set(tx - 1, y + h + 1, E.ink);
  buf.set(tx + 1, y + h + 1, E.ink);
  buf.set(tx, y + h + 2, E.ink);
  drawText(buf, text, x + 3, y + 3, E.bark0);
}

/** A small dark tag naming a station. */
function drawLabel(buf: PixelBuffer, text: string, cx: number, y: number): void {
  const w = textWidth(text) + 6;
  const x = Math.round(cx - w / 2);
  buf.rect(x + 1, y, w - 2, 9, E.ink, 0.78);
  buf.rect(x, y + 1, w, 7, E.ink, 0.78);
  drawText(buf, text, x + 3, y + 2, E.cream);
}

/** Swap exact colours in place; colours not in the map are left as they are. */
function recolor(buf: PixelBuffer, map: ReadonlyMap<Rgb, Rgb>): void {
  const d = buf.data;
  for (let i = 0; i < d.length; i += 4) {
    const c = ((d[i] ?? 0) << 16) | ((d[i + 1] ?? 0) << 8) | (d[i + 2] ?? 0);
    const to = map.get(c);
    if (to === undefined) continue;
    d[i] = (to >> 16) & 255;
    d[i + 1] = (to >> 8) & 255;
    d[i + 2] = to & 255;
  }
}

/**
 * Paint a whole map scene. Props in `leaveOut` aren't drawn, though their
 * shadows are (the goal farm paints a copy without its trees and bushes, to
 * redraw one swaying in place without its still self showing behind it).
 */
export function composeMap(
  scene: MapScene,
  leaveOut: ReadonlySet<PlacedProp> = new Set(),
): PixelBuffer {
  const ground = paintGround(scene.grid, scene.seed);
  scatterDetails(ground, scene.seed);
  const buf = ground.buf;
  if (scene.groundColors) recolor(buf, scene.groundColors);

  const ink = scene.ink ?? E.ink;
  for (const p of scene.props) if (p.flat) drawProp(buf, p);
  // Shadows go down on the ground (and anything flat on it) before anything stands on it.
  const mask = new Float32Array(buf.width * buf.height);
  for (const p of scene.props) {
    if (!p.flat && !p.hidden) castShadow(mask, buf.width, buf.height, p);
  }
  applyShadows(buf, mask, ink);
  type Item = { y: number; x: number; draw: () => void };
  const items: Item[] = [];
  for (const p of scene.props) {
    if (!p.flat && !p.hidden && !leaveOut.has(p)) {
      items.push({ y: p.y, x: p.x, draw: () => drawProp(buf, p) });
    }
  }
  for (const c of scene.critters) {
    items.push({ y: c.y + 0.5, x: c.x, draw: () => drawCritter(buf, c, ink) });
  }
  items.sort((a, b) => a.y - b.y || a.x - b.x);
  for (const item of items) item.draw();

  if (scene.tint) {
    for (let y = 0; y < buf.height; y++) {
      for (let x = 0; x < buf.width; x++) buf.set(x, y, scene.tint.color, scene.tint.a);
    }
  }
  if (!scene.hideLabels) {
    for (const label of scene.labels ?? []) drawLabel(buf, label.text, label.x, label.y);
  }
  for (const c of scene.critters) {
    if (!c.say) continue;
    const rideH = c.ride ? c.ride.buf.height - 2 : 0;
    drawBubble(buf, c.say, c.x, c.y - CRITTER - rideH - (c.lift ?? 0) - (c.crown ? 3 : 0));
  }
  return buf;
}
