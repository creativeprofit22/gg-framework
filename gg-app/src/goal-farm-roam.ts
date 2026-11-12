// Farm animals wandering freely: each one walks a loop of waypoints around
// its home, pausing now and then (a hen pecks, the cat sits), never stepping
// onto anything drawn on the map. Routes are planned once, when the map is
// built, against a mask of everything solid; the renderer then just looks up
// where an animal is at a given time. Deterministic for a seed.

import { hash, stream } from "./goal-map-pixels";
import type { Spot } from "./goal-farm-travel";

export type RoamerKind = "cat" | "hen";

export interface Roamer {
  readonly kind: RoamerKind;
  /** A closed loop: the animal walks to each spot in turn, then back to the first. */
  readonly route: readonly Spot[];
  /** Varies its pauses and pace. */
  readonly seed: number;
}

export interface RoamPose {
  readonly x: number;
  readonly y: number;
  /** Which way it faces: 1 right, -1 left. */
  readonly facing: 1 | -1;
  readonly moving: boolean;
}

/** How big each animal's body is, standing on its feet: width and height, in pixels. */
export const BODY: Readonly<Record<RoamerKind, { readonly w: number; readonly h: number }>> = {
  cat: { w: 24, h: 11 },
  hen: { w: 14, h: 12 },
};

/** Walking pace, pixels per second. */
const PACE: Readonly<Record<RoamerKind, number>> = { cat: 16, hen: 9 };

/**
 * Where solid things are, as a pixel mask with a summed-area table so any
 * box can be tested in constant time.
 */
export class SolidMask {
  private readonly sums: Int32Array;

  constructor(
    readonly width: number,
    readonly height: number,
    solid: (x: number, y: number) => boolean,
  ) {
    const w1 = width + 1;
    this.sums = new Int32Array(w1 * (height + 1));
    for (let y = 0; y < height; y++) {
      let row = 0;
      for (let x = 0; x < width; x++) {
        row += solid(x, y) ? 1 : 0;
        this.sums[(y + 1) * w1 + x + 1] = (this.sums[y * w1 + x + 1] ?? 0) + row;
      }
    }
  }

  /** Is any pixel in the box [x0, x1) × [y0, y1) solid (or off the mask)? */
  any(x0: number, y0: number, x1: number, y1: number): boolean {
    const ax = Math.floor(x0);
    const ay = Math.floor(y0);
    const bx = Math.ceil(x1);
    const by = Math.ceil(y1);
    if (ax < 0 || ay < 0 || bx > this.width || by > this.height) return true;
    const w1 = this.width + 1;
    const s = (x: number, y: number): number => this.sums[y * w1 + x] ?? 0;
    return s(bx, by) - s(ax, by) - s(bx, ay) + s(ax, ay) > 0;
  }

  /** Could an animal of this size stand with its feet at (x, y)? */
  clear(kind: RoamerKind, x: number, y: number): boolean {
    const { w, h } = BODY[kind];
    return !this.any(x - w / 2, y - h, x + w / 2, y + 1);
  }

  /** Could it walk straight from a to b? (Sampled every pixel.) */
  walkable(kind: RoamerKind, a: Spot, b: Spot): boolean {
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (!this.clear(kind, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) return false;
    }
    return true;
  }
}

/**
 * Plan a wandering loop around `home`: up to `legs` stops, each a short walk
 * from the last, within `radius` of home, every step of the way clear, and
 * the last stop able to walk straight back to the first. A blocked home
 * moves to the nearest clear spot; with no clear spot in reach the route is
 * empty, and the animal isn't placed at all (never drawn on top of things).
 */
export function planRoute(
  mask: SolidMask,
  kind: RoamerKind,
  start: Spot,
  radius: number,
  seed: number,
  legs = 9,
): Spot[] {
  let home = start;
  // A home that's blocked moves to the nearest clear spot within reach.
  if (!mask.clear(kind, home.x, home.y)) {
    let found: Spot | undefined;
    for (let r = 2; r <= radius && !found; r += 2) {
      for (let k = 0; k < 16 && !found; k++) {
        const a = (k / 16) * Math.PI * 2;
        const spot = {
          x: Math.round(home.x + Math.cos(a) * r),
          y: Math.round(home.y + Math.sin(a) * r * 0.6),
        };
        if (mask.clear(kind, spot.x, spot.y)) found = spot;
      }
    }
    if (!found) return [];
    home = found;
  }
  const rnd = stream(seed);
  const route: Spot[] = [home];
  for (let tries = 0; tries < 400 && route.length < legs; tries++) {
    const from = route[route.length - 1] ?? home;
    const angle = rnd() * Math.PI * 2;
    const dist = 10 + rnd() * 34;
    const next = {
      x: Math.round(from.x + Math.cos(angle) * dist),
      y: Math.round(from.y + Math.sin(angle) * dist * 0.6),
    };
    if (Math.hypot(next.x - home.x, (next.y - home.y) / 0.6) > radius) continue;
    if (!mask.walkable(kind, from, next)) continue;
    // Keep the loop closable: from here, home must be one clear walk away,
    // or another stop must be able to get there.
    route.push(next);
  }
  // Close the loop: drop stops from the end until the last can walk home.
  while (route.length > 1) {
    const last = route[route.length - 1] ?? home;
    if (mask.walkable(kind, last, home)) break;
    route.pop();
  }
  return route;
}

interface Leg {
  readonly from: Spot;
  readonly to: Spot;
  readonly walk: number;
  readonly pause: number;
}

function legsOf(roamer: Roamer): Leg[] {
  const { route, kind, seed } = roamer;
  return route.map((from, i) => {
    const to = route[(i + 1) % route.length] ?? from;
    const len = Math.hypot(to.x - from.x, to.y - from.y);
    // Pauses vary: a quick look round, or a long sit.
    const pause = 0.8 + hash(i, 1, seed) * (kind === "hen" ? 3.2 : 4.5);
    return { from, to, walk: len / PACE[kind], pause };
  });
}

/** Where a roaming animal is at `seconds`: walking a leg of its loop, or paused at a stop. */
export function roamPose(roamer: Roamer, seconds: number): RoamPose {
  const legs = legsOf(roamer);
  const first = roamer.route[0] ?? { x: 0, y: 0 };
  const total = legs.reduce((sum, l) => sum + l.walk + l.pause, 0);
  if (legs.length < 2 || total <= 0) {
    return {
      x: first.x,
      y: first.y,
      facing: hash(1, 2, roamer.seed) < 0.5 ? 1 : -1,
      moving: false,
    };
  }
  // Each animal starts somewhere different in its loop.
  let t = (((seconds + hash(3, 3, roamer.seed) * total) % total) + total) % total;
  for (const leg of legs) {
    const facing: 1 | -1 = leg.to.x >= leg.from.x ? 1 : -1;
    if (t < leg.pause) return { x: leg.from.x, y: leg.from.y, facing, moving: false };
    t -= leg.pause;
    if (t < leg.walk) {
      const k = t / leg.walk;
      return {
        x: leg.from.x + (leg.to.x - leg.from.x) * k,
        y: leg.from.y + (leg.to.y - leg.from.y) * k,
        facing,
        moving: true,
      };
    }
    t -= leg.walk;
  }
  return { x: first.x, y: first.y, facing: 1, moving: false };
}
