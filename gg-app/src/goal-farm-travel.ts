// How a critter gets around the farm: on foot, along the yard's paths (a
// small waypoint graph laid out to keep clear of the house, the pond and the
// beds), and round anything in its way: given the ground every standing
// thing covers (a desk, a tree's trunk, the well), any stretch of a route
// that would cross it is re-planned round it on a fine grid, so nobody ever
// walks through the furniture. It walks at an easy pace and jogs a long way,
// easing into each trip and slowing as it arrives, so it never jumps or zips
// about. Pure: a trip is planned once, and its pose can be read at any moment.

import { SolidMask } from "./goal-farm-roam";

export const TRAVEL_MODES = ["walk", "run"] as const;
export type TravelMode = (typeof TRAVEL_MODES)[number];

/** A point on the map, in map pixels (for a critter: where its feet are). */
export interface Spot {
  readonly x: number;
  readonly y: number;
}

/** The ground a critter's feet can't cross (see Farm.walk): 1 = blocked. */
export interface WalkGrid {
  readonly width: number;
  readonly height: number;
  readonly blocked: Uint8Array;
}

/** A critter's feet on the ground: how wide, and how deep (feet at the bottom). */
const FEET = { w: 8, h: 2 } as const;
/** The grid a blocked stretch is re-planned on, in map pixels. */
const DETOUR_CELL = 3;
/** How far a walkway point inside something is moved to clear ground. */
const NODE_NUDGE = 18;

/** The yard's walkways: points, and which pairs are joined by a clear path. */
export interface PathGraph {
  readonly nodes: readonly Spot[];
  readonly edges: ReadonlyArray<readonly [number, number]>;
}

export interface Trip {
  readonly mode: TravelMode;
  readonly from: Spot;
  readonly to: Spot;
  /** The route it follows, along the paths. */
  readonly path: readonly Spot[];
  readonly start: number;
  readonly duration: number;
}

export interface Pose {
  readonly x: number;
  /** Where its feet (and its shadow) are on the ground. */
  readonly y: number;
  readonly facing: 1 | -1;
  readonly done: boolean;
}

/** Map pixels per second: an easy walk, and a jog for a long way. */
const SPEED: Readonly<Record<TravelMode, number>> = { walk: 30, run: 52 };
/** Past this far, a critter jogs. */
const JOG_FROM = 150;
/** How long it takes to get up to pace, and to slow to a stop. */
const RAMP_S = 0.3;
/** Two spots this close are joined directly, without the paths. */
const DIRECT = 26;

const dist = (a: Spot, b: Spot): number => Math.hypot(b.x - a.x, b.y - a.y);

export function pathLength(path: readonly Spot[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    if (a && b) total += dist(a, b);
  }
  return total;
}

export interface Router {
  /** The walking route from one spot to another, via the yard's paths. */
  route(from: Spot, to: Spot): Spot[];
}

/**
 * Feet and the ground: whether a critter could stand at a spot, walk a
 * straight stretch, or find its way round what's in the way.
 */
interface Ground {
  clear(p: Spot): boolean;
  stretchClear(a: Spot, b: Spot): boolean;
  /** The nearest spot within `reach` whose ground is clear, or null. */
  nearestClear(p: Spot, reach: number): Spot | null;
  /** A clear way from a to b round whatever's between (both ends included), or null. */
  detour(a: Spot, b: Spot): Spot[] | null;
}

function groundOf(walk: WalkGrid): Ground {
  const mask = new SolidMask(
    walk.width,
    walk.height,
    (x, y) => walk.blocked[y * walk.width + x] === 1,
  );
  const clear = (p: Spot): boolean =>
    !mask.any(p.x - FEET.w / 2, p.y - FEET.h + 1, p.x + FEET.w / 2, p.y + 1);
  const stretchClear = (a: Spot, b: Spot): boolean => {
    const steps = Math.max(1, Math.ceil(dist(a, b)));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (!clear({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })) return false;
    }
    return true;
  };
  const nearestClear = (p: Spot, reach: number): Spot | null => {
    if (clear(p)) return p;
    for (let r = 1; r <= reach; r++) {
      let best: Spot | null = null;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const q = { x: p.x + dx, y: p.y + dy };
          if (clear(q) && (!best || dist(p, q) < dist(p, best))) best = q;
        }
      }
      if (best) return best;
    }
    return null;
  };
  const cols = Math.ceil(walk.width / DETOUR_CELL);
  const rows = Math.ceil(walk.height / DETOUR_CELL);
  const cellSpot = (c: number): Spot => ({
    x: (c % cols) * DETOUR_CELL + DETOUR_CELL / 2,
    y: Math.floor(c / cols) * DETOUR_CELL + DETOUR_CELL / 2,
  });
  const open = new Uint8Array(cols * rows);
  for (let c = 0; c < open.length; c++) open[c] = clear(cellSpot(c)) ? 1 : 0;
  const cellOf = (p: Spot): number => {
    const cx = Math.min(cols - 1, Math.max(0, Math.floor(p.x / DETOUR_CELL)));
    const cy = Math.min(rows - 1, Math.max(0, Math.floor(p.y / DETOUR_CELL)));
    return cy * cols + cx;
  };
  /** The nearest open cell to a spot (it may stand just inside something). */
  const openCellNear = (p: Spot): number => {
    const home = cellOf(p);
    if (open[home]) return home;
    const hx = home % cols;
    const hy = Math.floor(home / cols);
    for (let r = 1; r <= 8; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = hx + dx;
          const y = hy + dy;
          if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
          if (open[y * cols + x]) return y * cols + x;
        }
      }
    }
    return -1;
  };
  const detour = (a: Spot, b: Spot): Spot[] | null => {
    const start = openCellNear(a);
    const goal = openCellNear(b);
    if (start < 0 || goal < 0) return null;
    // A* over the grid, eight ways, never cutting a blocked corner.
    const gScore = new Float32Array(cols * rows).fill(Infinity);
    const came = new Int32Array(cols * rows).fill(-1);
    const shut = new Uint8Array(cols * rows);
    const goalSpot = cellSpot(goal);
    const heap: Array<[number, number]> = [];
    const push = (f: number, c: number): void => {
      heap.push([f, c]);
      let i = heap.length - 1;
      while (i > 0) {
        const up = (i - 1) >> 1;
        if ((heap[up]?.[0] ?? 0) <= f) break;
        [heap[i], heap[up]] = [heap[up] as [number, number], heap[i] as [number, number]];
        i = up;
      }
    };
    const pop = (): number => {
      const top = heap[0]?.[1] ?? -1;
      const last = heap.pop();
      if (heap.length > 0 && last) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1;
          const r = l + 1;
          let m = i;
          if ((heap[l]?.[0] ?? Infinity) < (heap[m]?.[0] ?? Infinity)) m = l;
          if ((heap[r]?.[0] ?? Infinity) < (heap[m]?.[0] ?? Infinity)) m = r;
          if (m === i) break;
          [heap[i], heap[m]] = [heap[m] as [number, number], heap[i] as [number, number]];
          i = m;
        }
      }
      return top;
    };
    gScore[start] = 0;
    push(dist(cellSpot(start), goalSpot), start);
    let found = false;
    while (heap.length > 0) {
      const c = pop();
      if (c < 0 || shut[c]) continue;
      if (c === goal) {
        found = true;
        break;
      }
      shut[c] = 1;
      const cx = c % cols;
      const cy = Math.floor(c / cols);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const nc = ny * cols + nx;
          if (!open[nc] || shut[nc]) continue;
          if (dx && dy && (!open[cy * cols + nx] || !open[ny * cols + cx])) continue;
          const g = (gScore[c] ?? Infinity) + (dx && dy ? Math.SQRT2 : 1);
          if (g >= (gScore[nc] ?? Infinity)) continue;
          gScore[nc] = g;
          came[nc] = c;
          push(g + dist(cellSpot(nc), goalSpot) / DETOUR_CELL, nc);
        }
      }
    }
    if (!found) return null;
    const cells: Spot[] = [];
    for (let c = goal; c >= 0; c = came[c] ?? -1) {
      cells.push(cellSpot(c));
      if (c === start) break;
    }
    cells.reverse();
    // Pull the zigzag of cells taut: from each point, straight to the
    // furthest one it can reach in the clear.
    const points = [a, ...cells, b];
    const taut: Spot[] = [a];
    let at = 0;
    while (at < points.length - 1) {
      let next = at + 1;
      for (let k = points.length - 1; k > at + 1; k--) {
        const from = points[at];
        const to = points[k];
        if (from && to && stretchClear(from, to)) {
          next = k;
          break;
        }
      }
      const point = points[next];
      if (point) taut.push(point);
      at = next;
    }
    return taut;
  };
  return { clear, stretchClear, nearestClear, detour };
}

/**
 * Precompute every shortest route through the graph (it is small). Given the
 * ground (see WalkGrid), walkway points that sit inside something move to
 * clear ground, and any stretch of a route that would cross something is
 * re-planned round it.
 */
export function createRouter(graph: PathGraph, walk?: WalkGrid): Router {
  const ground = walk ? groundOf(walk) : null;
  graph = ground
    ? {
        ...graph,
        nodes: graph.nodes.map((node) => ground.nearestClear(node, NODE_NUDGE) ?? node),
      }
    : graph;
  const n = graph.nodes.length;
  const d: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 0 : Infinity)),
  );
  const next: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? j : -1)),
  );
  for (const [a, b] of graph.edges) {
    const na = graph.nodes[a];
    const nb = graph.nodes[b];
    if (!na || !nb) continue;
    const len = dist(na, nb);
    const rowA = d[a];
    const rowB = d[b];
    if (rowA && rowB) {
      rowA[b] = len;
      rowB[a] = len;
    }
    const nextA = next[a];
    const nextB = next[b];
    if (nextA && nextB) {
      nextA[b] = b;
      nextB[a] = a;
    }
  }
  // Floyd–Warshall, with next hops so routes can be read back.
  for (let k = 0; k < n; k++) {
    const rowK = d[k];
    if (!rowK) continue;
    for (let i = 0; i < n; i++) {
      const rowI = d[i];
      const nextI = next[i];
      if (!rowI || !nextI) continue;
      const ik = rowI[k] ?? Infinity;
      if (ik === Infinity) continue;
      for (let j = 0; j < n; j++) {
        const through = ik + (rowK[j] ?? Infinity);
        if (through < (rowI[j] ?? Infinity)) {
          rowI[j] = through;
          nextI[j] = nextI[k] ?? -1;
        }
      }
    }
  }
  const nearest = (p: Spot): number => {
    let best = 0;
    let bestD = Infinity;
    graph.nodes.forEach((node, i) => {
      const dd = dist(p, node);
      if (dd < bestD) {
        bestD = dd;
        best = i;
      }
    });
    return best;
  };
  /** The route along the walkways, before anything in the way is walked round. */
  const along = (from: Spot, to: Spot): Spot[] => {
    if (dist(from, to) <= DIRECT || n === 0) return [from, to];
    const a = nearest(from);
    const b = nearest(to);
    const hops: Spot[] = [];
    let at = a;
    for (let guard = 0; guard <= n; guard++) {
      const node = graph.nodes[at];
      if (node) hops.push(node);
      if (at === b) break;
      const step = next[at]?.[b] ?? -1;
      if (step < 0) break;
      at = step;
    }
    const path = [from, ...hops, to];
    // Drop repeated points (a spot standing right on a node).
    return path.filter((p, i) => {
      const prev = path[i - 1];
      return i === 0 || !prev || dist(prev, p) > 0.5;
    });
  };
  return {
    route(from, to) {
      const path = along(from, to);
      if (!ground) return path;
      // Walk round anything a stretch would cross.
      const out: Spot[] = [path[0] ?? from];
      for (let i = 1; i < path.length; i++) {
        const a = out[out.length - 1] ?? from;
        const b = path[i];
        if (!b) continue;
        if (ground.stretchClear(a, b)) {
          out.push(b);
          continue;
        }
        const way = ground.detour(a, b);
        if (way) out.push(...way.slice(1));
        else out.push(b);
      }
      return out.filter((p, i) => {
        const prev = out[i - 1];
        return i === 0 || !prev || dist(prev, p) > 0.5;
      });
    },
  };
}

/** Walk a short way, jog a long one. */
export function chooseMode(length: number): TravelMode {
  return length > JOG_FROM ? "run" : "walk";
}

/** How long a trip of `length` takes: the time at pace, plus a ramp at each end. */
function tripMs(mode: TravelMode, length: number): number {
  const cruise = length / SPEED[mode];
  return Math.round((cruise + Math.min(RAMP_S, cruise)) * 1000);
}

/** Plan a trip along a route. */
export function planTrip(route: readonly Spot[], options: { readonly now: number }): Trip {
  const from = route[0] ?? { x: 0, y: 0 };
  const to = route[route.length - 1] ?? from;
  const length = pathLength(route);
  const mode = chooseMode(length);
  return { mode, from, to, path: route, start: options.now, duration: tripMs(mode, length) };
}

/**
 * How far along a trip is (0–1) at time fraction t: speeding up over the
 * first ramp, at an even pace in the middle, slowing over the last ramp.
 */
function paced(t: number, duration: number): number {
  if (duration <= 0) return 1;
  const f = Math.min(1 / 3, (RAMP_S * 1000) / duration);
  if (f <= 0) return t;
  const v = 1 / (1 - f);
  if (t < f) return (0.5 * v * t * t) / f;
  if (t > 1 - f) return 1 - (0.5 * v * (1 - t) * (1 - t)) / f;
  return 0.5 * v * f + v * (t - f);
}

function along(path: readonly Spot[], distance: number): { at: Spot; dx: number } {
  let left = distance;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    if (!a || !b) continue;
    const seg = dist(a, b);
    if (left <= seg || i === path.length - 1) {
      const t = seg === 0 ? 1 : Math.min(1, left / seg);
      return { at: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, dx: b.x - a.x };
    }
    left -= seg;
  }
  return { at: path[path.length - 1] ?? { x: 0, y: 0 }, dx: 0 };
}

/** Where a trip has the critter at `now`. */
export function tripPose(trip: Trip, now: number, lastFacing: 1 | -1 = 1): Pose {
  const t = trip.duration <= 0 ? 1 : Math.min(1, Math.max(0, (now - trip.start) / trip.duration));
  const done = t >= 1;
  const { at, dx } = along(trip.path, pathLength(trip.path) * paced(t, trip.duration));
  const facing: 1 | -1 = dx > 0.5 ? 1 : dx < -0.5 ? -1 : lastFacing;
  return { ...(done ? trip.to : at), facing, done };
}
