/**
 * Smoke wisps for a small glass lamp, ported from the user's own bloub project
 * (MIT; `src/experiments/wisps/sample.ts` + `depth.ts`). Three closed cubic ribbons
 * deform with whole-number harmonics, so the loop has no seam. Each ribbon is drawn
 * twice: a soft "far" pass and a crisp "near" pass whose opacities trade places,
 * which reads as smoke drifting in front of and behind itself.
 *
 * Pure function of absolute time: no clock, no state. The lamp's coordinate system
 * is bloub's: body radius 100, centre at the origin.
 */

// Authored ribbon control points (bloub), unchanged.
const RIBBONS = [
  [
    [-49, -51],
    [-18, -68],
    [49, -42],
    [25, -10],
    [7, 12],
    [-40, 9],
    [-22, 36],
    [-48, 17],
    [-4, -3],
    [10, -20],
    [27, -43],
    [-24, -46],
    [-49, -51],
  ],
  [
    [44, -32],
    [62, -9],
    [18, 17],
    [32, 41],
    [38, 54],
    [7, 66],
    [-21, 52],
    [15, 56],
    [19, 41],
    [12, 24],
    [-1, 0],
    [48, -7],
    [44, -32],
  ],
  [
    [-51, 21],
    [-66, 2],
    [-42, -25],
    [-16, -14],
    [8, -3],
    [-29, 31],
    [-4, 49],
    [-37, 37],
    [-9, 4],
    [-26, 0],
    [-44, -4],
    [-54, 8],
    [-51, 21],
  ],
] as const;

export const GLASS_WISPS = Object.freeze({
  /** Whole-blob spread (bloub's accepted "wide" profile). 68 * 1.45 + 16 < 115. */
  spread: 1.45,
  wrapSeconds: 120,
  depthPeriodSeconds: 8,
  minWeight: 0.15,
  maxWeight: 0.85,
  farFactor: 0.65,
  ribbonPhase: 2.1,
  stopPhase: Math.PI / 2,
  offsets: Object.freeze([0, 0.3, 0.65, 1] as const),
  /** Brighter than bloub's 0.13 / 0.09: the lamp is drawn at ~40px, not 316px. */
  baselineOpacities: Object.freeze([0, 0.3, 0.22, 0] as const),
  gradient: Object.freeze({ x1: -94, y1: -94, x2: 77, y2: 102 }),
  farSigma: 3.5,
  nearSigma: 1.6,
});

export type WispStops = readonly [number, number, number, number];
export interface WispRibbon {
  readonly d: string;
  readonly far: WispStops;
  readonly near: WispStops;
}
export type WispFrame = readonly [WispRibbon, WispRibbon, WispRibbon];

const wrap = (seconds: number) =>
  Number.isFinite(seconds)
    ? ((seconds % GLASS_WISPS.wrapSeconds) + GLASS_WISPS.wrapSeconds) % GLASS_WISPS.wrapSeconds
    : 0;

function ribbonPath(points: (typeof RIBBONS)[number], ribbon: number, phase: number): string {
  const moved = points.map(([x, y], index) => {
    // The closing point repeats the first exactly; the sections still deform.
    const section = index === points.length - 1 ? 0 : index;
    const p = ribbon * 2.1 + section * 0.63;
    const px = x * GLASS_WISPS.spread + 16 * Math.sin(phase * 15 + p);
    const py = y * GLASS_WISPS.spread + 14 * Math.sin(phase * 20 + p * 1.3);
    return `${px.toFixed(2)} ${py.toFixed(2)}`;
  });
  return `M ${moved[0]} C ${moved.slice(1).join(" ")} Z`;
}

/** Geometry and near/far opacities at an absolute time in seconds. */
export function sampleGlassWisps(timeSeconds: number): WispFrame {
  const t = wrap(timeSeconds);
  const shapePhase = (t * Math.PI * 2) / GLASS_WISPS.wrapSeconds;
  const depthPhase = (t * Math.PI * 2) / GLASS_WISPS.depthPeriodSeconds;
  const ribbon = (index: 0 | 1 | 2): WispRibbon => {
    const stops = (interior: 0 | 1): readonly [number, number] => {
      const wave = Math.sin(
        depthPhase + index * GLASS_WISPS.ribbonPhase + interior * GLASS_WISPS.stopPhase,
      );
      const near =
        GLASS_WISPS.minWeight + ((GLASS_WISPS.maxWeight - GLASS_WISPS.minWeight) * (1 + wave)) / 2;
      const opacity = GLASS_WISPS.baselineOpacities[interior + 1] ?? 0;
      return [opacity * (1 - near) * GLASS_WISPS.farFactor, opacity * near];
    };
    const [farA, nearA] = stops(0);
    const [farB, nearB] = stops(1);
    return {
      d: ribbonPath(RIBBONS[index], index, shapePhase),
      far: [0, farA, farB, 0],
      near: [0, nearA, nearB, 0],
    };
  };
  return [ribbon(0), ribbon(1), ribbon(2)];
}
