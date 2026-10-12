// The ground of a top-down Goal map: a grid of terrain codes (one per 16px
// tile) painted pixel by pixel. Soft terrains (grass, paths, sand, water) meet
// along rounded, slightly tufty edges, like hand-made autotiles: grass sits a
// little above paths and casts a shadow strip onto them, and ponds show an
// earthy bank on their far side. Plateaus (heights) get cliff faces with
// stone stairs; indoor floors and walls keep square edges. Pure: the same grid
// and seed always paint the same pixels.

import { E, PixelBuffer, darken, hash, mix, noise, type Rgb } from "./goal-map-pixels";

export const TILE = 16;
/** Height of a plateau's cliff face, in pixels. */
export const FACE = 16;

/**
 * Terrain codes:
 * `.` grass · `d` dirt path · `t` tilled soil · `s` sand · `c` cobblestone ·
 * `w` water · `W` deep water · `f` wood floor · `F` stone floor ·
 * `=` boards across (a deck) · `|` boards along (a vertical bridge) · `#` wall ·
 * `S` stairs cut into a cliff (on the cliff's face row).
 */
export type TerrainCode =
  "." | "d" | "t" | "s" | "c" | "w" | "W" | "f" | "F" | "=" | "|" | "#" | "S";

export interface MapGrid {
  readonly cols: number;
  readonly rows: number;
  /** One terrain code per cell, row by row. */
  readonly cells: readonly string[];
  /** Elevation per cell; 0 is the ground. A plateau's bottom row is its cliff. */
  readonly heights: readonly number[];
}

/** Builds a map grid by painting shapes onto grass. */
export class GridBuilder {
  readonly cells: string[];
  readonly heights: number[];

  constructor(
    readonly cols: number,
    readonly rows: number,
    fill: TerrainCode = ".",
  ) {
    this.cells = Array.from({ length: cols * rows }, () => fill);
    this.heights = Array.from({ length: cols * rows }, () => 0);
  }

  set(x: number, y: number, code: TerrainCode): this {
    if (x >= 0 && y >= 0 && x < this.cols && y < this.rows) this.cells[y * this.cols + x] = code;
    return this;
  }

  rect(x: number, y: number, w: number, h: number, code: TerrainCode): this {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.set(xx, yy, code);
    return this;
  }

  /** Cells whose centre lies inside the ellipse. */
  ellipse(cx: number, cy: number, rx: number, ry: number, code: TerrainCode): this {
    for (let y = Math.floor(cy - ry); y <= cy + ry; y++) {
      for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
        const dx = (x + 0.5 - cx) / rx;
        const dy = (y + 0.5 - cy) / ry;
        if (dx * dx + dy * dy <= 1) this.set(x, y, code);
      }
    }
    return this;
  }

  /** A path through tile points: straight runs, turning corner to corner. */
  path(points: ReadonlyArray<readonly [number, number]>, code: TerrainCode, width = 1): this {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      if (!a || !b) continue;
      const [x0, y0] = a;
      const [x1, y1] = b;
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++)
        this.rect(x, y0, width, width, code);
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
        this.rect(x1, y, width, width, code);
    }
    return this;
  }

  /** Raise a block of cells to `level` (its bottom row becomes the cliff). */
  raise(x: number, y: number, w: number, h: number, level: number): this {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        if (xx >= 0 && yy >= 0 && xx < this.cols && yy < this.rows) {
          this.heights[yy * this.cols + xx] = level;
        }
      }
    }
    return this;
  }

  build(): MapGrid {
    return { cols: this.cols, rows: this.rows, cells: [...this.cells], heights: [...this.heights] };
  }
}

interface Ground {
  /** Stacking order where soft terrains meet: higher sits on top. */
  readonly layer: number;
  /** Keeps square edges (floors, decks, walls). */
  readonly crisp?: boolean;
  /** Its edge colour where it sits over a lower terrain. */
  readonly rim?: Rgb;
  /** Its colour in the shadow of a higher terrain just above it. */
  readonly shade?: Rgb;
  readonly paint: (x: number, y: number) => Rgb;
}

/** A softer grass tone for sunny patches; mapped by each world's palette. */
export const GRASS_SUN: Rgb = mix(E.green2, E.green3, 0.32);

function grass(x: number, y: number): Rgb {
  // Like hand-made grass: one green, wide sunny patches of a lighter green,
  // darker clumps where it grows thick, and tufts of every size scattered
  // about: big five-blade tufts, small "v"s, and lone blades with a lit tip.
  const sunny = noise(x * 0.7, y, 22, 16) > 0.66;
  const thick = noise(x, y * 1.3, 9, 17) < 0.2;
  const base = sunny ? GRASS_SUN : thick ? mix(E.green2, E.green1, 0.4) : E.green2;
  const cell = 7;
  const gx = Math.floor(x / cell);
  const gy = Math.floor(y / cell);
  const roll = hash(gx, gy, 12);
  if (roll < 0.42) {
    const ox = gx * cell + 1 + Math.floor(hash(gx, gy, 13) * 4);
    const oy = gy * cell + 2 + Math.floor(hash(gx, gy, 14) * 3);
    const dx = x - ox;
    const dy = y - oy;
    if (roll < 0.08) {
      // A big tuft: five blades fanning up from one root.
      if (dy === 1 && dx >= 0 && dx <= 4) return E.green1;
      if (dy === 0 && (dx === 0 || dx === 2 || dx === 4)) return E.green1;
      if (dy === -1 && (dx === 1 || dx === 3)) return E.green1;
      if (dy === -1 && dx === 2) return mix(E.green2, E.green3, 0.6);
      if (dy === -2 && dx === 2) return E.green3;
    } else if (roll < 0.3) {
      // A small "v", sometimes with a lit blade beside it.
      if ((dy === 0 && (dx === 0 || dx === 2)) || (dy === 1 && dx === 1)) return E.green1;
      if (dy === -1 && dx === 2 && hash(gx, gy, 15) < 0.5) return mix(E.green2, E.green3, 0.6);
    } else {
      // A lone blade: dark at the root, lit at the tip.
      if (dx === 0 && dy === 1) return E.green1;
      if (dx === 0 && dy === 0) return mix(E.green2, E.green3, 0.6);
    }
  }
  return base;
}

function dirt(x: number, y: number): Rgb {
  // Hand-drawn earth is mostly one flat colour, with a few soft, wide,
  // lighter patches (worn) and the odd darker scuff: big shapes, not speckle.
  const worn = noise(x * 0.6, y, 14, 22);
  if (worn > 0.8) return mix(E.tan, E.sand, 0.35);
  const scuff = noise(x, y * 0.7, 6, 21);
  if (scuff < 0.1) return mix(E.tan, E.bark3, 0.25);
  if (hash(x >> 1, y >> 1, 23) < 0.006) return mix(E.tan, E.bark3, 0.55);
  return E.tan;
}

function sand(x: number, y: number): Rgb {
  if (hash(x, y, 31) < 0.02) return E.tan;
  const n = noise(x, y, 10, 32);
  if (n > 0.7) return mix(E.sand, E.cream, 0.5);
  if (n < 0.25) return mix(E.sand, E.tan, 0.25);
  return E.sand;
}

function tilled(x: number, y: number): Rgb {
  const row = y % 6;
  const base = row === 0 ? E.bark3 : row === 4 ? E.bark1 : E.bark2;
  return hash(x, y, 41) < 0.05 ? mix(base, E.bark3, 0.5) : base;
}

function cobble(x: number, y: number): Rgb {
  const rowH = 5;
  const row = Math.floor(y / rowH);
  const sx = (x + (row % 2) * 4) % 8;
  const sy = y % rowH;
  if (sx === 0 || sy === 0) return E.slate1;
  const stone = hash(Math.floor((x + (row % 2) * 4) / 8), row, 51);
  const base = mix(E.steel1, E.mist, stone * 0.45);
  if (sy === 1 && sx < 6) return mix(base, E.white, 0.25);
  if (sy === rowH - 1) return mix(base, E.steel0, 0.5);
  return base;
}

function water(x: number, y: number): Rgb {
  const n = noise(x, y, 6, 61);
  if (n < 0.24) return E.blue1;
  if (hash(Math.floor(x / 3), y, 62) < 0.012 && y % 4 === 0) return E.sky;
  return E.blue2;
}

function deepWater(x: number, y: number): Rgb {
  // Mostly one blue, with short horizontal ripple dashes (light above, dark
  // below), the way hand-drawn water tiles show a calm surface.
  const rx = Math.floor(x / 6);
  const ry = Math.floor(y / 5);
  if (hash(rx, ry, 72) < 0.16) {
    const ox = rx * 6 + Math.floor(hash(rx, ry, 73) * 2);
    const oy = ry * 5 + 2;
    if (y === oy && x >= ox && x < ox + 4) return E.blue2;
    if (y === oy + 1 && x >= ox + 1 && x < ox + 4) return E.navy;
  }
  return E.blue1;
}

function woodFloor(x: number, y: number): Rgb {
  // Long planks: 6px tall, butt joints far apart and staggered, each plank a
  // slightly different tone, with a fine grain line along it.
  const plank = Math.floor(y / 6);
  const row = y % 6;
  if (row === 5) return E.bark1;
  const length = 48;
  const shift = Math.floor(hash(plank, 0, 81) * length);
  const segment = Math.floor((x + shift) / length);
  if ((x + shift) % length === 0) return E.bark1;
  const tone = hash(plank, segment, 82);
  let c =
    tone < 0.33 ? E.bark3 : tone < 0.66 ? mix(E.bark3, E.tan, 0.18) : mix(E.bark3, E.bark2, 0.22);
  if (row === 0) c = mix(c, E.tan, 0.3);
  if (row === 3 && noise(x, plank, 9, 83) > 0.62) c = mix(c, E.bark2, 0.5);
  return c;
}

function stoneFloor(x: number, y: number): Rgb {
  if (x % 8 === 0 || y % 8 === 0) return E.steel0;
  const checker = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0;
  const base = checker ? E.steel1 : mix(E.steel1, E.mist, 0.45);
  return y % 8 === 1 ? mix(base, E.white, 0.15) : base;
}

function deck(along: boolean): (x: number, y: number) => Rgb {
  return (x, y) => {
    const a = along ? y : x;
    const b = along ? x : y;
    if (a % 4 === 3) return E.bark1;
    if (a % 4 === 0) return mix(E.bark3, E.tan, 0.4);
    if ((b + Math.floor(a / 4) * 7) % 23 === 0) return E.bark2;
    return E.bark3;
  };
}

const GROUND: Readonly<Record<string, Ground>> = {
  W: { layer: 0, paint: deepWater },
  w: { layer: 1, paint: water },
  s: { layer: 2, shade: E.tan, paint: sand },
  d: { layer: 3, rim: mix(E.tan, E.bark3, 0.6), shade: E.bark3, paint: dirt },
  t: { layer: 3, rim: E.bark1, shade: E.bark1, paint: tilled },
  c: { layer: 3, rim: E.slate1, shade: E.steel0, paint: cobble },
  ".": { layer: 4, rim: E.teal0, paint: grass },
  S: { layer: 4, rim: E.teal0, paint: grass },
  f: { layer: 5, crisp: true, paint: woodFloor },
  F: { layer: 5, crisp: true, paint: stoneFloor },
  "=": { layer: 5, crisp: true, paint: deck(false) },
  "|": { layer: 5, crisp: true, paint: deck(true) },
  "#": { layer: 6, crisp: true, paint: () => E.bark1 },
};

const groundOf = (code: string): Ground =>
  GROUND[code] ?? GROUND["."] ?? { layer: 4, paint: grass };
const LAND_MIN = 2;
const isWater = (code: string): boolean => code === "w" || code === "W";

/** What the painter decided for each pixel, for later passes and props. */
export interface GroundInfo {
  readonly buf: PixelBuffer;
  /** Terrain code of every pixel. */
  readonly code: readonly string[];
  /** Elevation of every pixel (which plateau it is on). */
  readonly level: Uint8Array;
}

/** Paint a map's ground. */
export function paintGround(grid: MapGrid, seed = 1): GroundInfo {
  const W = grid.cols * TILE;
  const H = grid.rows * TILE;
  const buf = new PixelBuffer(W, H);
  const cellAt = (cx: number, cy: number): string => {
    const x = Math.min(grid.cols - 1, Math.max(0, cx));
    const y = Math.min(grid.rows - 1, Math.max(0, cy));
    return grid.cells[y * grid.cols + x] ?? ".";
  };
  const heightAt = (cx: number, cy: number): number => {
    const x = Math.min(grid.cols - 1, Math.max(0, cx));
    const y = Math.min(grid.rows - 1, Math.max(0, cy));
    return grid.heights[y * grid.cols + x] ?? 0;
  };

  // 1. Which terrain each pixel shows: square for crisp tiles, otherwise the
  // highest terrain covering more than half of a jittered blend of the four
  // nearest tile centres, which rounds corners and roughens edges.
  const code: string[] = new Array<string>(W * H);
  const layer = new Int8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const own = cellAt(Math.floor(x / TILE), Math.floor(y / TILE));
      const ownGround = groundOf(own);
      if (ownGround.crisp) {
        code[i] = own;
        layer[i] = ownGround.layer;
        continue;
      }
      const u = (x + 0.5) / TILE - 0.5;
      const v = (y + 0.5) / TILE - 0.5;
      const i0 = Math.floor(u);
      const j0 = Math.floor(v);
      const fu = u - i0;
      const fv = v - j0;
      const corners: Array<[string, number]> = [
        [cellAt(i0, j0), (1 - fu) * (1 - fv)],
        [cellAt(i0 + 1, j0), fu * (1 - fv)],
        [cellAt(i0, j0 + 1), (1 - fu) * fv],
        [cellAt(i0 + 1, j0 + 1), fu * fv],
      ];
      // A crisp neighbour doesn't pull soft edges toward it.
      const soft = corners.map(([c, w]): [string, number] => [groundOf(c).crisp ? own : c, w]);
      const jitter = (noise(x, y, 4, seed) - 0.5) * 0.3 + (noise(x, y, 1.7, seed + 1) - 0.5) * 0.14;
      const layers = [...new Set(soft.map(([c]) => groundOf(c).layer))].sort((a, b) => b - a);
      let chosen = groundOf(own).layer;
      for (const l of layers) {
        const cover = soft.reduce((sum, [c, w]) => sum + (groundOf(c).layer >= l ? w : 0), 0);
        if (cover > 0.5 + jitter) {
          chosen = l;
          break;
        }
      }
      let pick = own;
      let pickWeight = -1;
      for (const [c, w] of soft) {
        if (groundOf(c).layer === chosen && w > pickWeight) {
          pick = c;
          pickWeight = w;
        }
      }
      code[i] = pick;
      layer[i] = chosen;
    }
  }

  const codeAt = (x: number, y: number): string =>
    code[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))] ?? ".";
  const layerAt = (x: number, y: number): number =>
    layer[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))] ?? 4;

  // 2. Base textures, then edges: rims where a terrain sits over a lower one,
  // shadow strips under raised edges, pond banks and beach foam.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = code[y * W + x] ?? ".";
      const g = groundOf(c);
      let color = g.paint(x, y);
      const l = layerAt(x, y);
      if (isWater(c)) {
        color = waterEdge(x, y, c, color, codeAt, layerAt);
      } else if (!g.crisp) {
        const lower = [
          [x, y - 1],
          [x, y + 1],
          [x - 1, y],
          [x + 1, y],
        ].some(([nx, ny]) => layerAt(nx ?? x, ny ?? y) < l);
        if (lower && g.rim !== undefined && !(c === "s" && isWater(codeAt(x, y + 1)))) {
          color = g.rim;
        } else if (g.shade !== undefined && (layerAt(x, y - 1) > l || layerAt(x, y - 2) > l)) {
          color = g.shade;
        }
      }
      buf.set(x, y, color);
    }
  }

  // 3. Walls: a cap seen from above, and a panelled face where nothing stands below.
  paintWalls(buf, grid, cellAt);

  // 4. Plateaus, lowest first: cliff faces, stairs, rims and the shadow at their foot.
  const level = new Uint8Array(W * H);
  const maxHeight = grid.heights.reduce((m, h) => Math.max(m, h), 0);
  for (let L = 1; L <= maxHeight; L++) {
    paintPlateau(buf, L, seed, cellAt, heightAt, level);
  }

  return { buf, code, level };
}

function waterEdge(
  x: number,
  y: number,
  c: string,
  base: Rgb,
  codeAt: (x: number, y: number) => string,
  layerAt: (x: number, y: number) => number,
): Rgb {
  const land = (px: number, py: number): boolean => layerAt(px, py) >= LAND_MIN;
  const beach = (px: number, py: number): boolean => codeAt(px, py) === "s";
  // The far bank: earth showing below the land edge just above, then the
  // water in its shade. A sandy shore has no bank, only shallows and foam.
  for (let j = 1; j <= 5; j++) {
    if (!land(x, y - j)) continue;
    if (beach(x, y - j)) break;
    if (j <= 2) return E.bark2;
    if (j === 3) return E.bark1;
    return c === "W" ? E.navy : E.blue1;
  }
  for (const dx of [-1, 1]) {
    if (land(x + dx, y) && !beach(x + dx, y)) return E.bark2;
    if (land(x + dx * 2, y) && !beach(x + dx * 2, y)) return c === "W" ? E.navy : E.blue1;
  }
  let nearSand = 9;
  for (let r = 1; r <= 4 && nearSand === 9; r++) {
    for (const [dx, dy] of [
      [0, -r],
      [0, r],
      [-r, 0],
      [r, 0],
    ] as const) {
      if (beach(x + dx, y + dy)) {
        nearSand = r;
        break;
      }
    }
  }
  if (nearSand === 1) return mix(E.ice, E.white, 0.4);
  if (nearSand <= 2) return E.ice;
  if (nearSand <= 4) return mix(base, E.sky, 0.55);
  return base;
}

function paintWalls(
  buf: PixelBuffer,
  grid: MapGrid,
  cellAt: (cx: number, cy: number) => string,
): void {
  for (let cy = 0; cy < grid.rows; cy++) {
    for (let cx = 0; cx < grid.cols; cx++) {
      if (cellAt(cx, cy) !== "#") continue;
      const face = cellAt(cx, cy + 1) !== "#";
      const left = cellAt(cx - 1, cy) !== "#";
      const right = cellAt(cx + 1, cy) !== "#";
      const top = cellAt(cx, cy - 1) !== "#";
      for (let dy = 0; dy < TILE; dy++) {
        for (let dx = 0; dx < TILE; dx++) {
          const x = cx * TILE + dx;
          const y = cy * TILE + dy;
          let color: Rgb;
          if (face && dy >= 5) {
            // Panelled face: boards, a moulding at the top, a skirting at the foot.
            const fy = dy - 5;
            if (fy === 0) color = E.tan;
            else if (fy >= 9) color = E.bark1;
            else if ((x + 2) % 5 === 0) color = E.bark2;
            else color = fy === 1 ? mix(E.bark3, E.tan, 0.3) : E.bark3;
          } else {
            color = dy === 0 && top ? E.bark2 : E.bark1;
            if (face && dy === 4) color = E.bark0;
          }
          if ((left && dx === 0) || (right && dx === TILE - 1)) color = darken(color, 0.5);
          if (top && dy === 0) color = darken(E.bark1, 0.45);
          buf.set(x, y, color);
        }
      }
      // The floor just in front of a wall face sits in its shadow.
      if (face && cellAt(cx, cy + 1) !== "#") {
        for (let dy = 0; dy < 3; dy++) {
          for (let dx = 0; dx < TILE; dx++) {
            buf.set(cx * TILE + dx, (cy + 1) * TILE + dy, E.ink, 0.28 - dy * 0.08);
          }
        }
      }
    }
  }
}

function paintPlateau(
  buf: PixelBuffer,
  L: number,
  seed: number,
  cellAt: (cx: number, cy: number) => string,
  heightAt: (cx: number, cy: number) => number,
  level: Uint8Array,
): void {
  const W = buf.width;
  const H = buf.height;
  // The plateau covers exactly its tiles, so its cliff face is exactly its
  // bottom row of tiles (where stairs, paths and props are placed). Only the
  // left and right ends wobble a little, so they don't read as ruled lines.
  const mass = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const cx = Math.floor(x / TILE);
      const cy = Math.floor(y / TILE);
      if (heightAt(cx, cy) < L) continue;
      const dx = x - cx * TILE;
      const sideOpen =
        (dx < 3 && heightAt(cx - 1, cy) < L) || (dx > TILE - 4 && heightAt(cx + 1, cy) < L);
      if (
        sideOpen &&
        noise(x, y, 3, seed + 9 + L) < (dx < 3 ? (3 - dx) / 3 : (dx - TILE + 4) / 3)
      ) {
        continue;
      }
      mass[y * W + x] = 1;
    }
  }
  const inMass = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < W && y < H && mass[y * W + x] === 1;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!inMass(x, y)) continue;
      let k = 1;
      while (k <= FACE && inMass(x, y + k)) k++;
      const stairs = cellAt(Math.floor(x / TILE), Math.floor(y / TILE)) === "S";
      if (k <= FACE) {
        // A face pixel, k rows up from the foot of the cliff.
        buf.set(x, y, stairs ? stairColor(x, y, k, cellAt) : cliffColor(x, k, L));
        level[y * W + x] = L;
        continue;
      }
      level[y * W + x] = L;
      // The rim: the one row where the plateau's top meets the top of its
      // cliff face. The loop above stops counting at FACE + 1, so test the
      // foot directly: the mass ends exactly FACE + 1 rows below this pixel.
      if (!stairs && inMass(x, y + FACE) && !inMass(x, y + FACE + 1)) {
        buf.set(x, y, E.teal0);
      }
    }
  }
  // Silhouette outline, grass tufts over the cliff's top edge, and the shadow
  // the cliff casts on the ground at its foot.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (inMass(x, y)) {
        const edge = !inMass(x - 1, y) || !inMass(x + 1, y) || !inMass(x, y - 1);
        if (edge) buf.set(x, y, darken(buf.rgb(x, y), 0.55));
        continue;
      }
      for (let j = 1; j <= 3; j++) {
        if (inMass(x, y - j)) {
          buf.set(x, y, E.ink, 0.34 - j * 0.08);
          break;
        }
      }
    }
  }
  for (let x = 0; x < W; x++) {
    for (let y = 1; y < H; y++) {
      if (!inMass(x, y)) continue;
      let k = 1;
      while (k <= FACE && inMass(x, y + k)) k++;
      // The top row of the cliff face: some columns get a grass tuft hanging over.
      if (k === FACE && cellAt(Math.floor(x / TILE), Math.floor(y / TILE)) !== "S") {
        const drop = hash(x, L, seed + 31) < 0.45 ? 1 + Math.floor(hash(x, L, seed + 32) * 2) : 0;
        for (let d = 0; d < drop; d++) buf.set(x, y + d, d === drop - 1 ? E.teal0 : E.green2);
      }
    }
  }
}

function cliffColor(x: number, k: number, L: number): Rgb {
  const top = FACE - k; // 0 at the top of the face
  if (k === 1) return E.bark1;
  if (top === 0) return E.teal0;
  if (top === 1) return E.bark3;
  const column = (x + Math.floor(hash(Math.floor(x / 6), L, 5) * 6)) % 6;
  let c = top < 5 ? E.bark2 : mix(E.bark2, E.bark1, 0.35);
  if (column === 0) c = E.bark1;
  else if (column === 1 && top > 2) c = mix(c, E.bark3, 0.35);
  if (top % 6 === 5) c = mix(c, E.bark1, 0.5);
  return c;
}

function stairColor(
  x: number,
  y: number,
  k: number,
  cellAt: (cx: number, cy: number) => string,
): Rgb {
  const cx = Math.floor(x / TILE);
  const cy = Math.floor(y / TILE);
  const dx = x - cx * TILE;
  const leftEdge = cellAt(cx - 1, cy) !== "S" && dx <= 1;
  const rightEdge = cellAt(cx + 1, cy) !== "S" && dx >= TILE - 2;
  if (leftEdge || rightEdge) return dx === 0 || dx === TILE - 1 ? E.slate1 : E.steel0;
  const step = (FACE - k) % 4;
  if (step === 0) return E.mist;
  if (step === 3) return E.steel0;
  return E.steel1;
}

/** Small things on the ground: grass tufts, flowers and pebbles, placed by hash. */
export function scatterDetails(info: GroundInfo, seed = 1): void {
  const { buf, code } = info;
  const W = buf.width;
  const H = buf.height;
  const plain = (x: number, y: number, c: string): boolean => {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const px = x + dx;
        const py = y + dy;
        if (px < 0 || py < 0 || px >= W || py >= H || code[py * W + px] !== c) return false;
      }
    }
    return true;
  };
  for (let by = 0; by < H; by += 7) {
    for (let bx = 0; bx < W; bx += 7) {
      const r = hash(bx, by, seed + 101);
      const x = bx + Math.floor(hash(bx, by, seed + 102) * 5) + 1;
      const y = by + Math.floor(hash(bx, by, seed + 103) * 5) + 1;
      const c = code[y * W + x];
      if (c === "." && plain(x, y, ".") && info.level[y * W + x] === levelAt(info, x, y + 3)) {
        if (r < 0.22) {
          // A tuft: a small dark V with one bright blade.
          buf.set(x - 1, y, E.green1);
          buf.set(x + 1, y, E.green1);
          buf.set(x, y + 1, E.green1);
          if (r < 0.1) buf.set(x + 1, y - 1, E.green3);
        } else if (r < 0.255) {
          const petal =
            [E.pink, E.white, E.yellow, E.ice, E.orchid][Math.floor(r * 1000) % 5] ?? E.pink;
          buf.set(x, y - 1, petal);
          buf.set(x - 1, y, petal);
          buf.set(x + 1, y, petal);
          buf.set(x, y, E.gold);
          buf.set(x, y + 1, E.green1);
        }
      } else if (c === "d" && plain(x, y, "d") && r < 0.12) {
        buf.set(x, y, E.bark3);
        buf.set(x + 1, y, mix(E.tan, E.bark3, 0.5));
        buf.set(x, y - 1, E.sand);
      } else if (c === "s" && plain(x, y, "s") && r < 0.08) {
        buf.set(x, y, E.cream);
        buf.set(x + 1, y, E.tan);
      }
    }
  }
}

function levelAt(info: GroundInfo, x: number, y: number): number {
  const W = info.buf.width;
  const H = info.buf.height;
  if (x < 0 || y < 0 || x >= W || y >= H) return -1;
  return info.level[y * W + x] ?? 0;
}
