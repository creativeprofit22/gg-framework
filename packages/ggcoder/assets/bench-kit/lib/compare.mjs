// @ts-check
// Comparison and the decision rule. Turns measured data into per-candidate
// classifications and one verdict: WIN, TIE, NO-WIN or INCONCLUSIVE, with
// GATED-OUT per candidate. Pure; all randomness is seeded from the study.
import { seedFrom } from "./rng.mjs";
import { DEFAULTS, pairedBootstrap, rankProbability } from "./stats.mjs";

export const VERDICTS = Object.freeze(["WIN", "TIE", "NO-WIN", "INCONCLUSIVE"]);
export const CANDIDATE_VERDICTS = Object.freeze([
  "WIN",
  "TIE",
  "NO-WIN",
  "INCONCLUSIVE",
  "GATED-OUT",
]);

/** Default noise threshold when no A/A run is available (criterion.rs uses 1 %). */
export const DEFAULT_NOISE = 0.01;
export const DEFAULT_MAX_ERROR_RATE = 0.1;

/**
 * Bonferroni-adjusted confidence level for m simultaneous comparisons.
 * @param {number} level
 * @param {number} comparisons
 */
export function bonferroniLevel(level, comparisons) {
  const m = Math.max(1, comparisons);
  return 1 - (1 - level) / m;
}

/**
 * A/A (same-vs-same) check. It passes when the interval contains "no
 * difference"; the noise floor is how far the interval reaches either way.
 * @param {{ point?: number, lower?: number, upper?: number, scale?: "ratio" | "difference" }} ci
 */
export function noiseFromAA(ci) {
  const neutral = ci.scale === "difference" ? 0 : 1;
  if (ci.lower === undefined || ci.upper === undefined)
    return { passed: false, noise: undefined, reason: "A/A run produced no interval" };
  const passed = ci.lower <= neutral && ci.upper >= neutral;
  const noise = Math.max(ci.upper - neutral, neutral - ci.lower);
  return {
    passed,
    noise,
    reason: passed
      ? "same-vs-same interval contains no difference"
      : "same-vs-same interval excludes no difference: the setup is not stable enough to compare",
  };
}

/**
 * Criterion-style classification of an oriented interval against the noise floor.
 * @param {{ lower?: number, upper?: number, scale?: "ratio" | "difference" }} ci
 * @param {{ noise?: number }} [options]
 * @returns {"better" | "worse" | "no-change" | "within-noise" | "unknown"}
 */
export function classifyChange(ci, { noise = DEFAULT_NOISE } = {}) {
  if (ci.lower === undefined || ci.upper === undefined) return "unknown";
  const ratio = ci.scale !== "difference";
  const neutral = ratio ? 1 : 0;
  if (ci.lower <= neutral && ci.upper >= neutral) return "no-change";
  const lowBand = ratio ? 1 / (1 + noise) : -noise;
  const highBand = ratio ? 1 + noise : noise;
  if (ci.lower >= lowBand && ci.upper <= highBand) return "within-noise";
  return ci.lower > neutral ? "better" : "worse";
}

/**
 * @typedef {Record<string, number[]>} ByItem
 * @typedef {{ status: "pass" | "fail" | "errored" | "not-run", failures?: { gate: string, item?: string, reason: string }[], errored?: { gate: string, item?: string, reason: string }[] }} GateSummary
 * @typedef {{ planned: number, completed: number, errored: number, notRun: number }} Counts
 * @typedef {{
 *   study: any,
 *   data: Record<string, Record<string, ByItem>>,
 *   gates?: Record<string, GateSummary>,
 *   counts?: Record<string, Counts>,
 *   aa?: { passed: boolean, noise?: number, reason?: string },
 *   incomplete?: string,
 *   resamples?: number,
 * }} DecisionInput
 */

/** @param {any} study @param {string} id */
function metricDef(study, id) {
  return (study.metrics ?? []).find((/** @type {any} */ m) => m.id === id);
}

/**
 * Evaluate the study's pre-registered decision rule.
 * @param {DecisionInput} input
 */
export function decide(input) {
  const { study, data } = input;
  const decision = study.decision;
  const ref = decision.reference;
  const primary = decision.primary;
  const pMetric = metricDef(study, primary.metric) ?? {};
  const better = primary.better ?? pMetric.better ?? "lower";
  const scale = primary.scale ?? "ratio";
  const statistic = primary.statistic ?? "median";
  const ratio = scale === "ratio";
  const bar = ratio ? (primary.minRatio ?? 1) : (primary.minDifference ?? 0);
  const floor = primary.ciLowerAbove ?? (ratio ? 1 : 0);
  const level = decision.level ?? DEFAULTS.level;
  const maxErrorRate = study.maxErrorRate ?? DEFAULT_MAX_ERROR_RATE;
  const resamples = input.resamples ?? decision.resamples ?? DEFAULTS.resamples;
  const seed = Number.isInteger(study.seed) ? study.seed : DEFAULTS.seed;
  const gates = input.gates ?? {};
  const counts = input.counts ?? {};
  const noise = input.aa?.noise ?? DEFAULT_NOISE;
  const neutral = ratio ? 1 : 0;
  const tieHigh = ratio ? Math.max(bar, 1 + noise) : Math.max(bar, noise);
  const tieLow = ratio ? 1 / tieHigh : -tieHigh;

  const ids = (study.candidates ?? []).map((/** @type {any} */ c) => c.id);
  const others = ids.filter((/** @type {string} */ id) => id !== ref);
  const comparisons = Math.max(1, others.length);
  const adjustedLevel = bonferroniLevel(level, comparisons);

  /** @param {string} id */
  const errorRate = (id) => {
    const c = counts[id];
    if (!c) return 0;
    const attempted = c.completed + c.errored;
    return attempted ? c.errored / attempted : 0;
  };

  /** @type {Record<string, any>} */
  const candidates = {};
  for (const id of ids) {
    const g = gates[id];
    /** @type {any} */
    const entry = { id, reasons: [], errorRate: errorRate(id), counts: counts[id] };
    if (g?.status === "fail") {
      entry.verdict = "GATED-OUT";
      entry.reasons.push(
        ...(g.failures ?? []).map(
          (f) => `gate ${f.gate} failed${f.item ? ` on ${f.item}` : ""}: ${f.reason}`,
        ),
      );
    } else if (g?.status === "errored") {
      entry.verdict = "INCONCLUSIVE";
      entry.reasons.push(
        ...(g.errored ?? []).map(
          (f) => `gate ${f.gate} could not be checked${f.item ? ` on ${f.item}` : ""}: ${f.reason}`,
        ),
      );
    } else if (entry.errorRate > maxErrorRate) {
      entry.verdict = "INCONCLUSIVE";
      entry.reasons.push(
        `${Math.round(entry.errorRate * 100)}% of samples errored (limit ${Math.round(maxErrorRate * 100)}%)`,
      );
    }
    candidates[id] = entry;
  }

  const refEntry = candidates[ref];
  const refBlocked = refEntry?.verdict;
  if (refEntry && !refBlocked) refEntry.verdict = "REFERENCE";

  for (const id of others) {
    const entry = candidates[id];
    if (entry.verdict) continue;
    if (refBlocked) {
      entry.verdict = "INCONCLUSIVE";
      entry.reasons.push(`the reference ${ref} could not be compared (${refBlocked})`);
      continue;
    }
    const ci = pairedBootstrap(
      data[ref]?.[primary.metric] ?? {},
      data[id]?.[primary.metric] ?? {},
      {
        statistic,
        better,
        scale,
        resamples,
        level: adjustedLevel,
        seed: seedFrom(`${seed}:${id}:${primary.metric}`),
      },
    );
    entry.primary = { metric: primary.metric, ci, classification: classifyChange(ci, { noise }) };
    if (ci.point === undefined || ci.lower === undefined || ci.upper === undefined) {
      entry.verdict = "INCONCLUSIVE";
      entry.reasons.push(`no comparable ${primary.metric} measurements against ${ref}`);
      continue;
    }
    const clearsBar = ci.point >= bar && ci.lower > floor && ci.point > (ratio ? 1 + noise : noise);
    if (clearsBar) entry.verdict = "WIN";
    else if (ci.lower >= tieLow && ci.upper <= tieHigh) entry.verdict = "TIE";
    else if (ci.upper < bar || ci.upper < neutral) entry.verdict = "NO-WIN";
    else {
      entry.verdict = "INCONCLUSIVE";
      entry.reasons.push(
        "the interval is too wide to tell whether it clears the bar; add repeats or reduce noise",
      );
    }

    entry.secondary = [];
    for (const s of decision.secondary ?? []) {
      const def = metricDef(study, s.metric) ?? {};
      const better = s.better ?? def.better ?? "lower";
      const sci = pairedBootstrap(data[ref]?.[s.metric] ?? {}, data[id]?.[s.metric] ?? {}, {
        statistic: s.statistic ?? "median",
        better,
        scale: "ratio",
        resamples,
        level: adjustedLevel,
        seed: seedFrom(`${seed}:${id}:${s.metric}`),
      });
      const limit = s.mustNotRegressBeyond;
      const regressed = sci.point !== undefined && limit !== undefined && sci.point < 1 / limit;
      const row = {
        metric: s.metric,
        better,
        ci: sci,
        classification: classifyChange(sci, { noise }),
        limit,
        regressed,
      };
      entry.secondary.push(row);
      if (sci.point === undefined && entry.verdict === "WIN") {
        entry.verdict = "INCONCLUSIVE";
        entry.reasons.push(`secondary ${s.metric} has no comparable measurements`);
      } else if (regressed) {
        entry.reasons.push(
          `${s.metric} regressed beyond the allowed ${limit}× (${(1 / /** @type {number} */ (sci.point)).toFixed(2)}× worse)`,
        );
        if (entry.verdict === "WIN") entry.verdict = "NO-WIN";
      }
    }
  }

  const measurable = ids.filter((/** @type {string} */ id) => {
    const v = candidates[id].verdict;
    return v !== "GATED-OUT" && !(id === ref && refBlocked);
  });
  /** @type {Record<string, ByItem>} */
  const rankData = {};
  for (const id of measurable) rankData[id] = data[id]?.[primary.metric] ?? {};
  const rank =
    measurable.length >= 2
      ? rankProbability(rankData, {
          statistic,
          better,
          resamples: Math.min(resamples, 2_000),
          seed: seedFrom(`${seed}:rank`),
        })
      : {};

  /** @type {string[]} */
  const reasons = [];
  let verdict;
  /** @type {string | undefined} */
  let winner;
  /** @type {string[]} */
  const wins = others.filter((/** @type {string} */ id) => candidates[id].verdict === "WIN");
  if (decision.noise?.requireAA && !input.aa)
    reasons.push("the required A/A (same-vs-same) check has not been run");
  if (input.aa && !input.aa.passed)
    reasons.push(input.aa.reason ?? "the A/A (same-vs-same) check failed");
  if (input.incomplete) reasons.push(input.incomplete);
  if (refBlocked)
    reasons.push(`the reference ${ref} is ${refBlocked}: ${refEntry.reasons.join("; ")}`);

  if (reasons.length) verdict = "INCONCLUSIVE";
  else if (wins.length) {
    verdict = "WIN";
    winner = [...wins].sort(
      (a, b) =>
        (rank[b] ?? 0) - (rank[a] ?? 0) ||
        candidates[b].primary.ci.point - candidates[a].primary.ci.point,
    )[0];
    if (wins.length > 1)
      reasons.push(
        `${wins.filter((/** @type {string} */ w) => w !== winner).join(", ")} also cleared the rule; ${winner} ranked best most often`,
      );
  } else if (others.some((/** @type {string} */ id) => candidates[id].verdict === "INCONCLUSIVE")) {
    verdict = "INCONCLUSIVE";
    for (const id of others)
      if (candidates[id].verdict === "INCONCLUSIVE")
        reasons.push(`${id}: ${candidates[id].reasons.join("; ")}`);
  } else if (others.some((/** @type {string} */ id) => candidates[id].verdict === "TIE")) {
    verdict = "TIE";
  } else verdict = "NO-WIN";

  return {
    verdict,
    winner,
    keep: verdict === "WIN" ? winner : ref,
    reference: ref,
    tieBreak: decision.tieBreak ?? [],
    reasons,
    rule: {
      metric: primary.metric,
      better,
      scale,
      statistic,
      bar,
      floor,
      level,
      adjustedLevel,
      comparisons,
      noise,
      tieBand: [tieLow, tieHigh],
    },
    candidates,
    rank,
  };
}
