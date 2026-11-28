// @ts-check
// Statistics. Pure functions; every random draw comes from an explicit seed.
// Percentiles, the hierarchical bootstrap and the Wilson interval are ported
// from bench/search/stats.mjs and tested against the same known values.
import { makeRng } from "./rng.mjs";

export const DEFAULTS = Object.freeze({
  resamples: 10_000,
  seed: 0x0b00_75ed,
  level: 0.95,
});

/** @param {readonly unknown[]} xs @returns {number[]} */
export const finite = (xs) =>
  /** @type {number[]} */ (xs.filter((x) => typeof x === "number" && Number.isFinite(x)));

/**
 * Percentile with linear interpolation between order statistics (Hyndman–Fan type 7).
 * @param {readonly unknown[]} values
 * @param {number} p 0..100
 */
export function percentile(values, p) {
  const xs = finite(values).sort((a, b) => a - b);
  if (xs.length === 0) return undefined;
  const first = /** @type {number} */ (xs[0]);
  const last = /** @type {number} */ (xs[xs.length - 1]);
  if (p <= 0) return first;
  if (p >= 100) return last;
  const h = (xs.length - 1) * (p / 100);
  const lo = Math.floor(h);
  const a = /** @type {number} */ (xs[lo]);
  const b = /** @type {number} */ (xs[Math.ceil(h)]);
  return a + (h - lo) * (b - a);
}

/** @param {readonly unknown[]} values */
export const median = (values) => percentile(values, 50);

/** @param {readonly unknown[]} values */
export function mean(values) {
  const xs = finite(values);
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : undefined;
}

/** Sample standard deviation (n − 1). @param {readonly unknown[]} values */
export function stddev(values) {
  const xs = finite(values);
  if (xs.length < 2) return undefined;
  const m = /** @type {number} */ (mean(xs));
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Geometric mean of positive values; undefined when any value is not positive. @param {readonly number[]} xs */
export function geomean(xs) {
  if (xs.length === 0 || xs.some((x) => !(x > 0) || !Number.isFinite(x))) return undefined;
  return Math.exp(xs.reduce((s, x) => s + Math.log(x), 0) / xs.length);
}

/** @param {readonly unknown[]} values */
export function summarize(values) {
  const xs = finite(values);
  const m = mean(xs);
  const sd = stddev(xs);
  return {
    n: xs.length,
    min: xs.length ? Math.min(...xs) : undefined,
    p50: percentile(xs, 50),
    p90: percentile(xs, 90),
    p95: percentile(xs, 95),
    p99: percentile(xs, 99),
    max: xs.length ? Math.max(...xs) : undefined,
    mean: m,
    sd,
    cv: m !== undefined && sd !== undefined && m !== 0 ? sd / Math.abs(m) : undefined,
  };
}

/** Named statistics a study may use for its decision rule. */
export const STATISTICS = Object.freeze({
  median: (/** @type {readonly unknown[]} */ xs) => percentile(xs, 50),
  mean: (/** @type {readonly unknown[]} */ xs) => mean(xs),
  min: (/** @type {readonly unknown[]} */ xs) => percentile(xs, 0),
  max: (/** @type {readonly unknown[]} */ xs) => percentile(xs, 100),
  p90: (/** @type {readonly unknown[]} */ xs) => percentile(xs, 90),
  p95: (/** @type {readonly unknown[]} */ xs) => percentile(xs, 95),
  p99: (/** @type {readonly unknown[]} */ xs) => percentile(xs, 99),
});

/** @typedef {keyof typeof STATISTICS} StatisticName */

/** @param {string | ((xs: readonly unknown[]) => number | undefined)} statistic */
function resolveStatistic(statistic) {
  if (typeof statistic === "function") return statistic;
  const f = STATISTICS[/** @type {StatisticName} */ (statistic)];
  if (!f) throw new Error(`unknown statistic ${statistic}`);
  return f;
}

/**
 * Inverse standard normal CDF (Acklam's rational approximation, relative error
 * below 1.2e-9). Common levels use exact constants so the ported Wilson values
 * stay bit-identical.
 * @param {number} p in (0, 1)
 * @returns {number}
 */
export function normalQuantile(p) {
  if (!(p > 0 && p < 1)) throw new Error(`normalQuantile needs 0 < p < 1, got ${p}`);
  /** @type {Record<string, number>} */
  const exact = { 0.95: 1.6448536269514722, 0.975: 1.959963984540054, 0.995: 2.5758293035489004 };
  const key = String(Math.round(p * 1e9) / 1e9);
  if (exact[key] !== undefined) return /** @type {number} */ (exact[key]);
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716,
    2.506628277459239,
  ];
  const b = [
    -54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972,
    -13.28068155288572,
  ];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const [a0, a1, a2, a3, a4, a5] = /** @type {[number, number, number, number, number, number]} */ (
    a
  );
  const [b0, b1, b2, b3, b4] = /** @type {[number, number, number, number, number]} */ (b);
  const [c0, c1, c2, c3, c4, c5] = /** @type {[number, number, number, number, number, number]} */ (
    c
  );
  const [d0, d1, d2, d3] = /** @type {[number, number, number, number]} */ (d);
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c0 * q + c1) * q + c2) * q + c3) * q + c4) * q + c5) /
      ((((d0 * q + d1) * q + d2) * q + d3) * q + 1)
    );
  }
  if (p > 1 - low) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a0 * r + a1) * r + a2) * r + a3) * r + a4) * r + a5) * q) /
    (((((b0 * r + b1) * r + b2) * r + b3) * r + b4) * r + 1)
  );
}

/** Two-sided z for a confidence level (0.95 → 1.96). @param {number} level */
export const zForLevel = (level) => normalQuantile(1 - (1 - level) / 2);

/**
 * Hierarchical resample (ported): `groups` is a nested array (repeats → items
 * → values, any depth); resample children with replacement at every level,
 * then flatten the leaves (Kalibera & Jones).
 * @param {unknown} groups
 * @param {() => number} rng
 * @returns {unknown[]}
 */
export function hierarchicalResample(groups, rng) {
  /** @type {unknown[]} */
  const out = [];
  /** @param {unknown} node */
  const walk = (node) => {
    if (!Array.isArray(node)) {
      out.push(node);
      return;
    }
    if (node.length === 0) return;
    for (let i = 0; i < node.length; i++) walk(node[Math.floor(rng() * node.length)]);
  };
  walk(groups);
  return out;
}

/** @param {unknown} node @returns {unknown[]} */
export function flatten(node) {
  if (!Array.isArray(node)) return [node];
  return node.flatMap(flatten);
}

/**
 * Ported bootstrap CI for statistic(baseline) / statistic(candidate), oriented
 * so > 1 always means "candidate is better".
 * @param {unknown} baseline nested groups
 * @param {unknown} candidate nested groups
 * @param {{ statistic?: string | ((xs: readonly unknown[]) => number | undefined), better?: "lower" | "higher", resamples?: number, seed?: number, level?: number }} [options]
 */
export function bootstrapRatio(baseline, candidate, options = {}) {
  const {
    statistic = "median",
    better = "lower",
    resamples = DEFAULTS.resamples,
    seed = DEFAULTS.seed,
    level = DEFAULTS.level,
  } = options;
  const f = resolveStatistic(statistic);
  /** @param {readonly unknown[]} b @param {readonly unknown[]} c */
  const ratio = (b, c) => {
    const mb = f(b);
    const mc = f(c);
    if (mb === undefined || mc === undefined || mb === 0 || mc === 0) return undefined;
    return better === "higher" ? mc / mb : mb / mc;
  };
  const point = ratio(flatten(baseline), flatten(candidate));
  const rng = makeRng(seed);
  /** @type {number[]} */
  const draws = [];
  for (let i = 0; i < resamples; i++) {
    const r = ratio(hierarchicalResample(baseline, rng), hierarchicalResample(candidate, rng));
    if (r !== undefined) draws.push(r);
  }
  const alpha = (1 - level) / 2;
  return {
    better,
    point,
    lower: percentile(draws, alpha * 100),
    upper: percentile(draws, (1 - alpha) * 100),
    level,
    resamples,
    validResamples: draws.length,
    seed,
  };
}

/**
 * @typedef {Record<string, number[]>} ByItem item id → one value per repeat
 * @typedef {{ point: number | undefined, lower: number | undefined, upper: number | undefined, level: number, resamples: number, validResamples: number, seed: number, items: number, scale: "ratio" | "difference", better: "lower" | "higher", statistic: string }} PairedCi
 */

/**
 * Paired, item-clustered bootstrap. Items are resampled with the same draw for
 * both sides (they ran the same workload); repeats inside each item are
 * resampled independently. The per-item effect is a ratio (aggregated by
 * geometric mean, so a 10 s clip and a 100 s clip weigh the same) or a
 * difference (aggregated by mean). Oriented so > 1 (ratio) or > 0
 * (difference) means the candidate is better.
 * @param {ByItem} reference
 * @param {ByItem} candidate
 * @param {{ statistic?: string, better?: "lower" | "higher", scale?: "ratio" | "difference", resamples?: number, seed?: number, level?: number }} [options]
 * @returns {PairedCi}
 */
export function pairedBootstrap(reference, candidate, options = {}) {
  const {
    statistic = "median",
    better = "lower",
    scale = "ratio",
    resamples = DEFAULTS.resamples,
    seed = DEFAULTS.seed,
    level = DEFAULTS.level,
  } = options;
  const f = resolveStatistic(statistic);
  const items = Object.keys(reference)
    .filter((id) => finite(reference[id] ?? []).length && finite(candidate[id] ?? []).length)
    .sort();
  /** @param {readonly number[]} r @param {readonly number[]} c */
  const effect = (r, c) => {
    const a = f(r);
    const b = f(c);
    if (a === undefined || b === undefined) return undefined;
    if (scale === "difference") return better === "higher" ? b - a : a - b;
    if (a <= 0 || b <= 0) return undefined;
    return better === "higher" ? b / a : a / b;
  };
  /** @param {(number | undefined)[]} effects */
  const aggregate = (effects) => {
    if (effects.some((e) => e === undefined)) return undefined;
    const xs = /** @type {number[]} */ (effects);
    return scale === "difference" ? mean(xs) : geomean(xs);
  };
  const base = {
    level,
    resamples,
    seed,
    items: items.length,
    scale,
    better,
    statistic: String(statistic),
  };
  if (items.length === 0)
    return { ...base, point: undefined, lower: undefined, upper: undefined, validResamples: 0 };
  const values = items.map((id) => ({
    r: finite(reference[id] ?? []),
    c: finite(candidate[id] ?? []),
  }));
  const point = aggregate(values.map((v) => effect(v.r, v.c)));
  const rng = makeRng(seed);
  /** @param {readonly number[]} xs */
  const draw = (xs) => xs.map(() => /** @type {number} */ (xs[Math.floor(rng() * xs.length)]));
  /** @type {number[]} */
  const draws = [];
  for (let i = 0; i < resamples; i++) {
    /** @type {(number | undefined)[]} */
    const effects = [];
    for (let k = 0; k < values.length; k++) {
      const v = /** @type {{ r: number[], c: number[] }} */ (
        values[Math.floor(rng() * values.length)]
      );
      effects.push(effect(draw(v.r), draw(v.c)));
    }
    const e = aggregate(effects);
    if (e !== undefined) draws.push(e);
  }
  const alpha = (1 - level) / 2;
  return {
    ...base,
    point,
    lower: percentile(draws, alpha * 100),
    upper: percentile(draws, (1 - alpha) * 100),
    validResamples: draws.length,
  };
}

/**
 * Probability that each candidate is the best, from paired resamples. Each
 * item's statistic is normalised by that item's mean across candidates so
 * items of different scale weigh the same; ties split the credit.
 * @param {Record<string, ByItem>} byCandidate
 * @param {{ statistic?: string, better?: "lower" | "higher", resamples?: number, seed?: number }} [options]
 * @returns {Record<string, number>}
 */
export function rankProbability(byCandidate, options = {}) {
  const {
    statistic = "median",
    better = "lower",
    resamples = 2_000,
    seed = DEFAULTS.seed,
  } = options;
  const f = resolveStatistic(statistic);
  const ids = Object.keys(byCandidate).sort();
  /** @type {Record<string, number>} */
  const wins = Object.fromEntries(ids.map((id) => [id, 0]));
  if (ids.length === 0) return wins;
  const items = Object.keys(/** @type {ByItem} */ (byCandidate[/** @type {string} */ (ids[0])]))
    .filter((item) => ids.every((id) => finite(byCandidate[id]?.[item] ?? []).length > 0))
    .sort();
  if (items.length === 0) return wins;
  const rng = makeRng(seed);
  let valid = 0;
  for (let i = 0; i < resamples; i++) {
    /** @type {Record<string, number>} */
    const score = Object.fromEntries(ids.map((id) => [id, 0]));
    let used = 0;
    for (let k = 0; k < items.length; k++) {
      const item = /** @type {string} */ (items[Math.floor(rng() * items.length)]);
      const stats = ids.map((id) => {
        const xs = finite(byCandidate[id]?.[item] ?? []);
        return f(xs.map(() => xs[Math.floor(rng() * xs.length)]));
      });
      if (stats.some((s) => s === undefined)) continue;
      const nums = /** @type {number[]} */ (stats);
      const norm = /** @type {number} */ (mean(nums));
      if (norm === 0) continue;
      ids.forEach(
        (id, j) =>
          (score[id] = /** @type {number} */ (score[id]) + /** @type {number} */ (nums[j]) / norm),
      );
      used++;
    }
    if (used === 0) continue;
    valid++;
    const values = ids.map((id) => /** @type {number} */ (score[id]));
    const best = better === "higher" ? Math.max(...values) : Math.min(...values);
    const winners = ids.filter(
      (id) =>
        Math.abs(/** @type {number} */ (score[id]) - best) <= 1e-12 * Math.max(1, Math.abs(best)),
    );
    for (const id of winners) wins[id] = /** @type {number} */ (wins[id]) + 1 / winners.length;
  }
  for (const id of ids) wins[id] = valid ? /** @type {number} */ (wins[id]) / valid : 0;
  return wins;
}

/**
 * Wilson score interval for a proportion; sensible at 0 and n (ported, with
 * a configurable level).
 * @param {number} successes
 * @param {number} n
 * @param {number} [level]
 */
export function wilson(successes, n, level = DEFAULTS.level) {
  if (n === 0) return { rate: undefined, lower: undefined, upper: undefined, n, level };
  const z = zForLevel(level);
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return {
    rate: p,
    lower: successes === 0 ? 0 : Math.max(0, centre - half),
    upper: successes === n ? 1 : Math.min(1, centre + half),
    n,
    level,
  };
}

/**
 * Unbiased pass@k: chance that at least one of k attempts drawn from n
 * attempts with c passes succeeds (Chen et al. 2021).
 * @param {number} n attempts
 * @param {number} c passes
 * @param {number} k
 */
export function passAtK(n, c, k) {
  if (!(n >= 1) || k < 1 || k > n || c < 0 || c > n) return undefined;
  if (n - c < k) return 1;
  let prod = 1;
  for (let i = n - c + 1; i <= n; i++) prod *= 1 - k / i;
  return 1 - prod;
}

/**
 * Cluster-robust standard error of the mean (Liang–Zeger with the G/(G−1)
 * correction): repeats of one task are correlated, so they share a cluster.
 * @param {readonly number[]} values
 * @param {readonly string[]} clusters same length as values
 */
export function clusteredStandardError(values, clusters) {
  if (values.length !== clusters.length) throw new Error("values and clusters differ in length");
  const n = values.length;
  const m = mean(values);
  if (m === undefined) return undefined;
  /** @type {Map<string, number>} */
  const sums = new Map();
  values.forEach((x, i) => {
    const key = /** @type {string} */ (clusters[i]);
    sums.set(key, (sums.get(key) ?? 0) + (x - m));
  });
  const g = sums.size;
  if (g < 2) return undefined;
  let ss = 0;
  for (const s of sums.values()) ss += s * s;
  return Math.sqrt(((g / (g - 1)) * ss) / (n * n));
}

/**
 * Tukey fences: mild beyond 1.5 IQR, severe beyond 3 IQR (criterion.rs labels).
 * @param {readonly number[]} values
 */
export function tukey(values) {
  const xs = finite(values);
  const q1 = percentile(xs, 25);
  const q3 = percentile(xs, 75);
  if (q1 === undefined || q3 === undefined) return undefined;
  const iqr = q3 - q1;
  const fences = {
    lowSevere: q1 - 3 * iqr,
    lowMild: q1 - 1.5 * iqr,
    highMild: q3 + 1.5 * iqr,
    highSevere: q3 + 3 * iqr,
  };
  /** @param {number} x */
  const label = (x) =>
    x < fences.lowSevere
      ? "low severe"
      : x < fences.lowMild
        ? "low mild"
        : x > fences.highSevere
          ? "high severe"
          : x > fences.highMild
            ? "high mild"
            : "normal";
  const labels = xs.map(label);
  /** @type {Record<string, number>} */
  const counts = { "low severe": 0, "low mild": 0, normal: 0, "high mild": 0, "high severe": 0 };
  for (const l of labels) counts[l] = /** @type {number} */ (counts[l]) + 1;
  return {
    q1,
    q3,
    iqr,
    fences,
    labels,
    counts,
    outliers: xs.length - /** @type {number} */ (counts.normal),
  };
}

/**
 * Modified z-scores from the median absolute deviation (Iglewicz–Hoaglin).
 * @param {readonly number[]} values
 */
export function madZScores(values) {
  const xs = finite(values);
  const m = median(xs);
  if (m === undefined) return [];
  const mad = /** @type {number} */ (median(xs.map((x) => Math.abs(x - m))));
  if (mad === 0) {
    const meanAd = /** @type {number} */ (mean(xs.map((x) => Math.abs(x - m))));
    if (meanAd === 0) return xs.map(() => 0);
    return xs.map((x) => (x - m) / (1.253314 * meanAd));
  }
  return xs.map((x) => (0.6745 * (x - m)) / mad);
}

/** Values whose |modified z| exceeds the threshold (3.5 by convention). @param {readonly number[]} values */
export function madOutliers(values, threshold = 3.5) {
  const xs = finite(values);
  const z = madZScores(xs);
  return xs
    .map((x, i) => ({ value: x, z: /** @type {number} */ (z[i]) }))
    .filter((r) => Math.abs(r.z) > threshold);
}

/**
 * Pilot sizing (ported): n = ceil((z·CV / e)²), clamped.
 * @param {readonly number[]} perRepeatValues
 * @param {{ z?: number, relativeError?: number, min?: number, max?: number }} [options]
 */
export function pilotRepetitions(perRepeatValues, options = {}) {
  const { z = 1.96, relativeError = 0.05, min = 3, max = 30 } = options;
  const m = mean(perRepeatValues);
  const s = stddev(perRepeatValues);
  if (m === undefined || s === undefined || m === 0)
    return {
      cv: undefined,
      raw: undefined,
      repeats: max,
      reason: "insufficient pilot data; using the maximum",
    };
  const cv = s / Math.abs(m);
  const raw = Math.ceil(((z * cv) / relativeError) ** 2);
  return { cv, raw, repeats: Math.min(max, Math.max(min, raw)) };
}
