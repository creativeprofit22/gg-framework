// Statistics owner: percentiles, seeded hierarchical bootstrap for effect-size
// CIs, autocorrelation for independence checks, pilot sizing and the open-loop
// knee. Pure functions; every random draw comes from an explicit seed.
import { KEEP_KILL, OPEN_LOOP, STATS } from "./spec.mjs";

/** Deterministic PRNG (mulberry32). */
export function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const finite = (xs) => xs.filter((x) => typeof x === "number" && Number.isFinite(x));

/** Percentile with linear interpolation between order statistics (Hyndman–Fan type 7). */
export function percentile(values, p) {
  const xs = finite(values).sort((a, b) => a - b);
  if (xs.length === 0) return undefined;
  if (p <= 0) return xs[0];
  if (p >= 100) return xs[xs.length - 1];
  const h = (xs.length - 1) * (p / 100);
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  const a = xs[lo];
  const b = xs[hi];
  return a + (h - lo) * (b - a);
}

export const median = (values) => percentile(values, 50);

export function mean(values) {
  const xs = finite(values);
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : undefined;
}

export function stddev(values) {
  const xs = finite(values);
  if (xs.length < 2) return undefined;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

export function summarize(values) {
  const xs = finite(values);
  return {
    n: xs.length,
    p50: percentile(xs, 50),
    p90: percentile(xs, 90),
    p99: percentile(xs, 99),
    max: xs.length ? Math.max(...xs) : undefined,
    mean: mean(xs),
  };
}

/** Metric extractors over a flat list of call values (latency) or wave throughputs. */
export const METRICS = Object.freeze({
  p50_latency_ms: (xs) => percentile(xs, 50),
  p90_latency_ms: (xs) => percentile(xs, 90),
  p99_latency_ms: (xs) => percentile(xs, 99),
  calls_per_s: (xs) => mean(xs),
});

/**
 * Hierarchical resample: `groups` is a nested array (sessions → launches →
 * units, any depth); at each level resample children with replacement, then
 * flatten the leaves. Repeating at every level keeps the variance of each
 * level in the CI (Kalibera & Jones).
 */
export function hierarchicalResample(groups, rng) {
  const out = [];
  const walk = (node) => {
    if (!Array.isArray(node)) {
      out.push(node);
      return;
    }
    if (node.length === 0) return;
    // A leaf list (numbers) is resampled as units; nested lists recurse.
    for (let i = 0; i < node.length; i++) walk(node[Math.floor(rng() * node.length)]);
  };
  walk(groups);
  return out;
}

/**
 * Bootstrap CI for the ratio metric(baseline) / metric(candidate) oriented so
 * that > 1 always means "candidate is better" (speedup). For `better: higher`
 * metrics the ratio is candidate / baseline.
 */
export function bootstrapRatio(
  baseline,
  candidate,
  {
    metric,
    better = "lower",
    resamples = STATS.bootstrapResamples,
    seed = STATS.bootstrapSeed,
    level = STATS.ciLevel,
  },
) {
  const f = typeof metric === "function" ? metric : METRICS[metric];
  if (!f) throw new Error(`unknown metric ${metric}`);
  const ratio = (b, c) => {
    const mb = f(b);
    const mc = f(c);
    if (mb === undefined || mc === undefined || mb === 0 || mc === 0) return undefined;
    return better === "higher" ? mc / mb : mb / mc;
  };
  const point = ratio(flatten(baseline), flatten(candidate));
  const rng = makeRng(seed);
  const draws = [];
  for (let i = 0; i < resamples; i++) {
    const r = ratio(hierarchicalResample(baseline, rng), hierarchicalResample(candidate, rng));
    if (r !== undefined) draws.push(r);
  }
  const alpha = (1 - level) / 2;
  return {
    metric: typeof metric === "string" ? metric : "custom",
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

export function flatten(node) {
  if (!Array.isArray(node)) return [node];
  return node.flatMap(flatten);
}

/** Sample autocorrelation for lags 1..maxLag; ±1.96/√n is the white-noise band. */
export function autocorrelation(values, maxLag = STATS.acfMaxLag) {
  const xs = finite(values);
  const n = xs.length;
  const m = mean(xs);
  const denom = xs.reduce((s, x) => s + (x - m) ** 2, 0);
  const lags = [];
  for (let k = 1; k <= maxLag; k++) {
    if (k >= n || denom === 0) {
      lags.push({ lag: k, r: undefined });
      continue;
    }
    let num = 0;
    for (let t = 0; t + k < n; t++) num += (xs[t] - m) * (xs[t + k] - m);
    lags.push({ lag: k, r: num / denom });
  }
  const band = n > 0 ? 1.96 / Math.sqrt(n) : undefined;
  const outside = lags
    .filter((l) => l.r !== undefined && band !== undefined && Math.abs(l.r) > band)
    .map((l) => l.lag);
  return {
    n,
    band,
    lags,
    outsideBand: outside,
    independentLooking: outside.length <= Math.ceil(maxLag * 0.05),
  };
}

/**
 * Pilot sizing at the launch level: n = ceil((z·CV / e)²), clamped. CV is the
 * coefficient of variation of the per-launch metric.
 */
export function pilotRepetitions(
  perLaunchValues,
  {
    z = STATS.pilotZ,
    relativeError = STATS.pilotTargetRelativeError,
    min = STATS.launchesMin,
    max = STATS.launchesMax,
  } = {},
) {
  const m = mean(perLaunchValues);
  const s = stddev(perLaunchValues);
  if (m === undefined || s === undefined || m === 0)
    return {
      cv: undefined,
      raw: undefined,
      launches: max,
      reason: "insufficient pilot data; using the maximum",
    };
  const cv = s / Math.abs(m);
  const raw = Math.ceil(((z * cv) / relativeError) ** 2);
  return { cv, raw, launches: Math.min(max, Math.max(min, raw)) };
}

/**
 * Open-loop knee: first step whose p99 exceeds factor × the first step's p99,
 * or whose completion rate falls below ratio × arrival rate.
 */
export function findKnee(
  steps,
  { factor = OPEN_LOOP.kneeP99Factor, ratio = OPEN_LOOP.kneeCompletionRatio } = {},
) {
  if (!steps.length) return undefined;
  const base = steps[0].p99;
  for (const step of steps) {
    const byLatency = base !== undefined && step.p99 !== undefined && step.p99 > factor * base;
    const byThroughput =
      step.completionRate !== undefined && step.completionRate < ratio * step.rate;
    if (byLatency || byThroughput)
      return { rate: step.rate, reason: byLatency ? "p99" : "completion", step };
  }
  return { rate: undefined, reason: "no knee within the tested rates" };
}

/** Least-squares slope of y over x (e.g. RSS bytes per minute in a soak). */
export function linearSlope(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return undefined;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den === 0 ? undefined : num / den;
}

/** 95% Wilson score interval for a proportion (error / deadline-hit rates); sensible at 0 and n. */
export function proportionCi(successes, n) {
  if (n === 0) return { rate: undefined, lower: undefined, upper: undefined };
  const z = 1.959963984540054;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  // Exact bounds at the edges (floating point would leave ~1e-18 residue).
  return {
    rate: p,
    lower: successes === 0 ? 0 : Math.max(0, centre - half),
    upper: successes === n ? 1 : Math.min(1, centre + half),
  };
}

/** Apply the pre-registered keep/kill rule to one headline CI. */
export function verdict(ci, { correctnessIdentical, reliabilityOk }) {
  if (!correctnessIdentical || !reliabilityOk) return "reverted";
  if (ci.point === undefined || ci.lower === undefined) return "inconclusive";
  if (ci.point >= KEEP_KILL.minSpeedup && ci.lower > KEEP_KILL.ciLowerAbove) return "kept";
  if (ci.upper !== undefined && ci.upper < KEEP_KILL.minSpeedup) return "reverted";
  return "inconclusive";
}
