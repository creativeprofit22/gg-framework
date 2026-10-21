// @ts-check
// Plain-language explanations. Deterministic sentences for metrics,
// comparisons and verdicts, built only from the study's own numbers, plus
// the glossary. Honesty rules: a tie or a loss is never worded as a win,
// unmeasured values are said to be unmeasured (never zero), sampled readings
// say so, and synthetic stand-ins are always labelled as synthetic.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { DEFAULT_NOISE } from "./compare.mjs";
import { jsonText, writeAtomic } from "./files.mjs";
import { TIME_UNITS } from "./metrics/common.mjs";
import { DEFAULT_UNITS } from "./metrics/index.mjs";
import { err, ok } from "./result.mjs";
import { summarize } from "./stats.mjs";

/** The kit's base glossary, shipped next to lib/. */
export const KIT_GLOSSARY = fileURLToPath(new URL("../glossary.json", import.meta.url));
export const GLOSSARY_SCHEMA = 1;

/**
 * @typedef {{ aliases?: string[], plain: string, example?: string }} GlossaryEntry
 * @typedef {{ schema: number, terms: Record<string, GlossaryEntry> }} Glossary
 * @typedef {{ id: string, label: string, unit: string, better: "lower" | "higher", type: string, time: boolean, explain?: string, description?: string }} MetricInfo
 * @typedef {{ headline: string, meaning: string, details: string[] }} Explained
 * @typedef {Explained & { id: string, name: string, verdict: string }} ExplainedCandidate
 */

// ---------------------------------------------------------------- numbers

/** Insert thousands separators without depending on the machine's locale. @param {number} n */
const group = (n) => {
  const sign = n < 0 ? "-" : "";
  const digits = String(Math.abs(n));
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
};

/**
 * Three significant figures; whole numbers with separators from 1,000 up.
 * @param {number} x
 */
export function formatNumber(x) {
  if (!Number.isFinite(x)) return String(x);
  if (Math.abs(x) >= 1000) return group(Math.round(x));
  if (x === 0) return "0";
  return String(Number(x.toPrecision(3)));
}

/** @param {number} x @param {string} [unit] */
export function formatQuantity(x, unit) {
  if (!unit) return formatNumber(x);
  return unit === "%" ? `${formatNumber(x)}%` : `${formatNumber(x)} ${unit}`;
}

/** A proportion as a whole percentage; never rounds a non-zero share to 0% or a partial one to 100%. @param {number} p */
export function formatPercent(p) {
  if (!Number.isFinite(p)) return String(p);
  if (p > 0 && p < 0.01) return "under 1%";
  if (p < 1 && p > 0.99) return "over 99%";
  return `${Math.round(p * 100)}%`;
}

/** A confidence level such as 0.975 as "97.5%". @param {number} level */
export const formatLevel = (level) => `${Number((level * 100).toFixed(1))}%`;

/** @param {number} n @param {string} one @param {string} [many] */
const plural = (n, one, many = `${one}s`) => `${group(n)} ${n === 1 ? one : many}`;

/** @param {readonly string[]} xs */
const list = (xs) =>
  xs.length <= 1
    ? (xs[0] ?? "")
    : xs.length === 2
      ? `${xs[0]} and ${xs[1]}`
      : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;

/** Ensure a sentence ends with one full stop. @param {string} s */
const sentence = (s) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

// ---------------------------------------------------------------- names

/** @param {any} study @param {string} id */
const candidateDef = (study, id) =>
  (study?.candidates ?? []).find((/** @type {any} */ c) => c?.id === id);

/**
 * A candidate's display name. Synthetic stand-ins always carry the label so
 * they can never be mistaken for the real thing.
 * @param {any} study
 * @param {string} id
 */
export function candidateName(study, id) {
  const c = candidateDef(study, id);
  const label = typeof c?.label === "string" ? c.label.trim() : "";
  // A label that already has brackets, e.g. "Engine A (current)", gets the id in square brackets.
  const base =
    !label || label === id ? id : /[()]/.test(label) ? `${label} [${id}]` : `${label} (${id})`;
  return c?.synthetic === true ? `${base} [synthetic stand-in]` : base;
}

/**
 * Everything needed to talk about a metric.
 * @param {any} study
 * @param {string} metricId
 * @returns {MetricInfo}
 */
export function metricInfo(study, metricId) {
  const m = (study?.metrics ?? []).find((/** @type {any} */ x) => x?.id === metricId) ?? {};
  const type = typeof m.type === "string" ? m.type : "custom";
  const unit =
    typeof m.unit === "string"
      ? m.unit
      : type === "tokens-cost"
        ? m.measure === "cost"
          ? "USD"
          : "tokens"
        : (DEFAULT_UNITS[/** @type {keyof typeof DEFAULT_UNITS} */ (type)] ?? "");
  const primary =
    study?.decision?.primary?.metric === metricId ? study.decision.primary : undefined;
  const better = (primary?.better ?? m.better) === "higher" ? "higher" : "lower";
  return {
    id: metricId,
    label: typeof m.label === "string" && m.label.trim() ? m.label.trim() : metricId,
    unit,
    better,
    type,
    time: Object.hasOwn(TIME_UNITS, unit) || type === "wall-time" || type === "cpu-time",
    ...(typeof m.explain === "string" ? { explain: m.explain } : {}),
    ...(typeof m.description === "string" ? { description: m.description } : {}),
  };
}

// ---------------------------------------------------------------- changes

/**
 * Words for an oriented change, where above 1 (ratio) or above 0
 * (difference) means better. Time metrics say faster/slower; everything else
 * says higher/lower plus whether that is better or worse.
 * @param {number} value
 * @param {MetricInfo} metric
 * @param {"ratio" | "difference"} [scale]
 */
export function describeChange(value, metric, scale = "ratio") {
  const neutral = scale === "ratio" ? 1 : 0;
  if (!Number.isFinite(value) || (scale === "ratio" && !(value > 0))) return "not comparable";
  const same = scale === "ratio" ? Math.abs(Math.log(value)) < 0.005 : Math.abs(value) < 1e-12;
  if (same) return "the same";
  const improved = value > neutral;
  const amount =
    scale === "ratio"
      ? `${formatNumber(improved ? value : 1 / value)}×`
      : formatQuantity(Math.abs(value), metric.unit);
  const goesDown = metric.better === "lower" ? improved : !improved;
  if (metric.time && metric.better === "lower")
    return `${amount} ${improved ? "faster" : "slower"}`;
  return `${amount} ${goesDown ? "lower" : "higher"} (${improved ? "better" : "worse"})`;
}

/**
 * The uncertainty range of a comparison in words.
 * @param {{ lower?: number, upper?: number, level?: number, scale?: "ratio" | "difference" }} ci
 * @param {MetricInfo} metric
 * @param {{ level?: number, comparisons?: number }} [rule]
 */
export function describeRange(ci, metric, rule = {}) {
  if (ci?.lower === undefined || ci?.upper === undefined)
    return "could not be compared: no matching measurements";
  const scale = ci.scale ?? "ratio";
  const lo = describeChange(ci.lower, metric, scale);
  const hi = describeChange(ci.upper, metric, scale);
  const [loAmount, ...loRest] = lo.split(" ");
  const [hiAmount, ...hiRest] = hi.split(" ");
  const sameWords = lo !== "the same" && hi !== "the same" && loRest.join(" ") === hiRest.join(" ");
  const span =
    lo === hi
      ? `likely ${lo}`
      : sameWords
        ? `likely between ${loAmount} and ${hiAmount} ${hiRest.join(" ")}`
        : `likely between ${lo} and ${hi}`;
  const level = ci.level ?? rule.level ?? 0.95;
  const widened =
    (rule.comparisons ?? 1) > 1 && rule.level !== undefined
      ? `, widened from ${formatLevel(rule.level)} because ${plural(/** @type {number} */ (rule.comparisons), "comparison")} were made`
      : "";
  return `${span} (${formatLevel(level)} confidence${widened})`;
}

export const CLASSIFICATION_TEXT = Object.freeze({
  better: "clearly better, beyond run-to-run noise",
  worse: "clearly worse, beyond run-to-run noise",
  "no-change": "no detectable difference: the range includes 'the same'",
  "within-noise": "any difference is smaller than the run-to-run noise",
  unknown: "could not be compared",
});

/** @param {string | undefined} c */
export const explainClassification = (c) =>
  CLASSIFICATION_TEXT[/** @type {keyof typeof CLASSIFICATION_TEXT} */ (c)] ??
  CLASSIFICATION_TEXT.unknown;

// ---------------------------------------------------------------- metrics

const METRIC_TYPE_TEXT = Object.freeze({
  "wall-time": "how long one run takes from start to finish, by the clock",
  "cpu-time":
    "how much processor time one run uses; it can exceed the clock time when several cores work at once",
  "peak-memory":
    "the most memory one run used at any moment; it is read every few milliseconds, so very short spikes can be missed",
  "output-size": "how big the output is",
  "tokens-cost":
    "model tokens an agent used, or what a run cost: either the cost the agent itself reported or an estimate from a price table you supplied (prices are never guessed)",
  custom: "a number the candidate or a measuring tool reports",
  rating:
    "a score people gave each output in a blind test, without knowing which candidate made it",
});

/**
 * What a metric means, in one sentence.
 * @param {any} study
 * @param {string} metricId
 */
export function explainMetric(study, metricId) {
  const m = metricInfo(study, metricId);
  const what =
    m.explain ??
    m.description ??
    METRIC_TYPE_TEXT[/** @type {keyof typeof METRIC_TYPE_TEXT} */ (m.type)] ??
    METRIC_TYPE_TEXT.custom;
  const unit = m.unit ? `measured in ${m.unit}, ` : "";
  return sentence(`${m.label}: ${what} (${unit}${m.better} is better)`);
}

/**
 * The study's own numbers for one metric, one line per candidate. Missing
 * values are reported as unmeasured with the reason, never as zero.
 * @param {{
 *   study: any,
 *   metricId: string,
 *   data: Record<string, Record<string, Record<string, number[]>>>,
 *   unmeasured?: Record<string, Record<string, { count: number, reasons: string[] }>>,
 *   labels?: Record<string, string[]>,
 * }} input
 * @returns {string[]}
 */
export function explainMetricResult({ study, metricId, data, unmeasured = {}, labels = {} }) {
  const m = metricInfo(study, metricId);
  const lines = [explainMetric(study, metricId)];
  const label = labels[metricId] ?? [];
  if (label.length) lines.push(sentence(`These readings are ${list(label)}`));
  for (const c of study?.candidates ?? []) {
    const byItem = data?.[c.id]?.[metricId] ?? {};
    const items = Object.keys(byItem)
      .filter((k) => (byItem[k] ?? []).length > 0)
      .sort();
    const values = items.flatMap((k) => byItem[k] ?? []);
    const s = summarize(values);
    const name = candidateName(study, c.id);
    const missing = unmeasured?.[c.id]?.[metricId];
    const gap = missing?.count
      ? ` ${plural(missing.count, "sample")} not measured: ${list(missing.reasons)}; shown as unmeasured, not as zero.`
      : "";
    if (s.n === 0 || s.p50 === undefined) {
      lines.push(
        sentence(
          `${name}: not measured${missing?.reasons.length ? ` (${list(missing.reasons)})` : ""}`,
        ),
      );
      continue;
    }
    const tail = s.p95 !== undefined && s.n >= 5 ? `, p95 ${formatQuantity(s.p95, m.unit)}` : "";
    const noisy =
      s.cv !== undefined && s.cv > 0.1 ? `; noisy: runs vary by about ${formatPercent(s.cv)}` : "";
    lines.push(
      `${name}: median ${formatQuantity(s.p50, m.unit)}${tail} from ${plural(s.n, "measurement")} on ${plural(items.length, "input")}${noisy}.${gap}`,
    );
  }
  return lines;
}

/**
 * Lines for metrics that were not measured, per candidate.
 * @param {any} study
 * @param {Record<string, Record<string, { count: number, reasons: string[] }>>} [unmeasured]
 */
export function explainUnmeasured(study, unmeasured = {}) {
  /** @type {string[]} */
  const lines = [];
  for (const c of study?.candidates ?? []) {
    const byMetric = unmeasured[c.id] ?? {};
    for (const metricId of Object.keys(byMetric).sort()) {
      const u = byMetric[metricId];
      if (!u?.count) continue;
      lines.push(
        sentence(
          `${metricInfo(study, metricId).label} was not measured for ${candidateName(study, c.id)} in ${plural(u.count, "sample")} (${list(u.reasons)}); it is shown as unmeasured, not as zero`,
        ),
      );
    }
  }
  return lines;
}

/**
 * Lines stating how readings were taken (e.g. "sampled, 50 ms resolution").
 * @param {any} study
 * @param {Record<string, string[]>} [labels]
 */
export function explainLabels(study, labels = {}) {
  return Object.keys(labels)
    .sort()
    .filter((id) => (labels[id] ?? []).length)
    .map((id) => sentence(`${metricInfo(study, id).label} readings are ${list(labels[id] ?? [])}`));
}

/** @param {{ planned?: number, completed?: number, errored?: number, notRun?: number } | undefined} c */
export function explainCounts(c) {
  if (!c) return "No sample counts were recorded.";
  const planned = c.planned ?? 0;
  const parts = [`${group(c.completed ?? 0)} of ${plural(planned, "planned sample")} completed`];
  if (c.errored) parts.push(`${group(c.errored)} errored`);
  if (c.notRun) parts.push(`${group(c.notRun)} did not run`);
  const tail = c.errored
    ? "; errored samples count against the candidate and are never re-run"
    : "";
  return sentence(`${parts.join(", ")}${tail}`);
}

// ---------------------------------------------------------------- verdicts

/** Concrete next steps for the reasons a study or candidate is undecided. @param {readonly string[]} reasons */
export function nextSteps(reasons) {
  /** @type {string[]} */
  const steps = [];
  /** @param {string} s */
  const add = (s) => {
    if (!steps.includes(s)) steps.push(s);
  };
  for (const r of reasons) {
    if (/A\/A/.test(r) && /not been run/.test(r)) add("Run the A/A (same-vs-same) check.");
    else if (/A\/A|same-vs-same/.test(r))
      add(
        "Quiet the machine (close other apps, plug in power) or add repeats, then repeat the A/A check.",
      );
    else if (/errored/.test(r))
      add(
        "Fix what makes samples error, then start a fresh run; errored samples are never re-run selectively.",
      );
    else if (/could not be checked/.test(r))
      add("Make the failing check runnable, then run again.");
    else if (/too wide/.test(r)) add("Add repeats or reduce noise, then run again.");
    else if (/no comparable|no matching|could not be compared/.test(r))
      add("Make sure every candidate produces the deciding measurement on the same inputs.");
    else add("Resolve the reasons above, then run again.");
  }
  return steps;
}

/**
 * The decision rule in words.
 * @param {any} decision
 * @param {MetricInfo} metric
 * @param {string} [against] reference name, when it should be mentioned
 */
function ruleText(decision, metric, against) {
  const rule = decision.rule ?? {};
  const scale = rule.scale ?? "ratio";
  const neutral = scale === "ratio" ? 1 : 0;
  const bar = rule.bar ?? neutral;
  const floor = rule.floor ?? neutral;
  const need =
    bar === neutral ? "any improvement" : `at least ${describeChange(bar, metric, scale)}`;
  const above = floor === neutral ? "'no difference'" : describeChange(floor, metric, scale);
  return `${need} on ${metric.label}${against ? ` against ${against}` : ""}, with the whole range above ${above}`;
}

/**
 * The pre-registered rule as one plain sentence, with the tie-break.
 * @param {any} decision output of decide()
 * @param {any} study
 */
export function explainRule(decision, study) {
  const metric = metricInfo(study, decision.rule?.metric);
  const refName = candidateName(study, decision.reference);
  const secondary = (study?.decision?.secondary ?? [])
    .filter((/** @type {any} */ s) => s?.mustNotRegressBeyond !== undefined)
    .map(
      (/** @type {any} */ s) =>
        `${metricInfo(study, s.metric).label} may not get more than ${formatNumber(s.mustNotRegressBeyond)}× worse`,
    );
  const tb = /** @type {string[]} */ (decision.tieBreak ?? []);
  const parts = [
    sentence(`A candidate replaces ${refName} only with ${ruleText(decision, metric)}`),
  ];
  if (secondary.length) parts.push(sentence(`Also, ${list(secondary)}`));
  parts.push(
    tb.length
      ? sentence(`On a tie, choose by: ${list(tb)}; otherwise keep ${refName}`)
      : sentence(`On a tie, keep ${refName}`),
  );
  return parts.join(" ");
}

/**
 * Plain explanation of one candidate's result.
 * @param {any} decision output of decide()
 * @param {any} study
 * @param {string} id
 * @returns {ExplainedCandidate}
 */
export function explainCandidate(decision, study, id) {
  const entry = decision.candidates?.[id] ?? { id, reasons: [] };
  const verdict = String(entry.verdict ?? "INCONCLUSIVE");
  const name = candidateName(study, id);
  const refName = candidateName(study, decision.reference);
  const metric = metricInfo(study, decision.rule?.metric);
  const rule = decision.rule ?? {};
  const range = entry.primary ? describeRange(entry.primary.ci, metric, rule) : undefined;
  const reasons = /** @type {string[]} */ (entry.reasons ?? []);
  /** @type {string[]} */
  const details = [];
  if (entry.counts) details.push(explainCounts(entry.counts));
  if (entry.primary)
    details.push(
      sentence(`${metric.label}: ${explainClassification(entry.primary.classification)}`),
    );
  for (const s of entry.secondary ?? []) {
    // metricInfo only knows the primary's override; use the orientation decide() measured with.
    const base = metricInfo(study, s.metric);
    const better = s.better ?? s.ci?.better ?? base.better;
    /** @type {MetricInfo} */
    const sm = { ...base, better: better === "higher" ? "higher" : "lower" };
    const limit = s.regressed ? ` — worse than the allowed ${formatNumber(s.limit)}× limit` : "";
    details.push(sentence(`${sm.label}: ${describeRange(s.ci, sm, rule)}${limit}`));
  }

  /** @type {string} */
  let headline;
  /** @type {string} */
  let meaning;
  const why = reasons.length ? `: ${reasons.join("; ")}` : "";
  switch (verdict) {
    case "REFERENCE":
      headline = `${name} is the reference: every other candidate is compared with it.`;
      meaning = "It stays unless another candidate clears the rule you set before the run.";
      break;
    case "GATED-OUT":
      headline = sentence(`${name} is ruled out (GATED-OUT)${why}`);
      meaning =
        "Its measurements do not count, however good they look; fix the failing check or drop it.";
      break;
    case "WIN":
      if (decision.verdict === "INCONCLUSIVE") {
        headline = `${sentence(`${name} measured ahead of ${refName} on ${metric.label}: ${range}`)} It cannot be called a win yet.`;
        meaning = sentence(
          `Do not switch yet; first resolve: ${(decision.reasons ?? []).join("; ")}`,
        );
      } else {
        headline = sentence(`${name} clears the rule (WIN): ${metric.label} ${range}`);
        meaning =
          decision.winner === id
            ? "This is the candidate to switch to, if the trade-offs listed below are acceptable."
            : sentence(
                `It also cleared the rule, but ${candidateName(study, decision.winner)} ranked best more often`,
              );
      }
      break;
    case "TIE":
      headline = sentence(
        `${name} and ${refName} are tied on ${metric.label} (TIE): the difference is ${range}, inside the band treated as 'the same'`,
      );
      meaning = sentence(`This is not a win for either. ${tieAdvice(decision, study)}`);
      break;
    case "NO-WIN":
      headline = sentence(
        `${name} does not clear the rule (NO-WIN): ${metric.label} ${range ?? "was not compared"}${why}`,
      );
      meaning = sentence(
        `Keep ${refName} rather than ${name}; the rule needs ${ruleText(decision, metric)}`,
      );
      break;
    default:
      headline = sentence(
        `${name} cannot be judged yet (INCONCLUSIVE)${why}${range ? `; ${metric.label} ${range}` : ""}`,
      );
      meaning = sentence(
        `Do not decide on ${name} from this run. ${nextSteps(reasons).join(" ") || "Resolve the reasons above, then run again."}`,
      );
  }
  return { id, name, verdict, headline, meaning, details };
}

/** @param {any} decision @param {any} study */
function tieAdvice(decision, study) {
  const ref = candidateName(study, decision.reference);
  const tb = /** @type {string[]} */ (decision.tieBreak ?? []);
  return tb.length
    ? `Choose using the tie-break you wrote down, in order: ${list(tb)}. If that does not settle it, keep ${ref}`
    : `No tie-break was written down, so keep ${ref}`;
}

/**
 * Plain explanation of the study verdict.
 * @param {any} decision output of decide()
 * @param {any} study
 * @param {{ unmeasured?: Record<string, Record<string, { count: number, reasons: string[] }>>, labels?: Record<string, string[]> }} [extras]
 * @returns {Explained & { verdict: string, nextSteps: string[] }}
 */
export function explainVerdict(decision, study, extras = {}) {
  const metric = metricInfo(study, decision.rule?.metric);
  const refName = candidateName(study, decision.reference);
  const ruleLine = ruleText(decision, metric, refName);
  const verdict = String(decision.verdict);
  /** @type {string[]} */
  const details = [];
  /** @type {string[]} */
  let steps = [];
  /** @type {string} */
  let headline;
  /** @type {string} */
  let meaning;
  /** @type {string[]} */
  const ids = (study?.candidates ?? []).map((/** @type {any} */ c) => String(c.id));

  if (verdict === "WIN") {
    const winner = decision.winner;
    const w = decision.candidates?.[winner];
    const name = candidateName(study, winner);
    headline = `WIN: switch to ${name}. It cleared the rule you set before the run.`;
    meaning = sentence(
      `On ${metric.label} against ${refName}, ${name} is ${describeRange(w?.primary?.ci ?? {}, metric, decision.rule)}. The rule asked for ${ruleLine}`,
    );
    for (const r of decision.reasons ?? []) details.push(sentence(r));
  } else if (verdict === "TIE") {
    headline = `TIE: no candidate is meaningfully better than ${refName} on ${metric.label}.`;
    meaning = sentence(`This is a tie, not a win. ${tieAdvice(decision, study)}`);
  } else if (verdict === "NO-WIN") {
    headline = `NO-WIN: keep ${refName}.`;
    meaning = sentence(`No candidate cleared the rule: ${ruleLine}`);
  } else {
    const reasons = /** @type {string[]} */ (decision.reasons ?? []);
    headline = "INCONCLUSIVE: do not decide from this run yet.";
    steps = nextSteps(reasons);
    meaning = sentence(
      `${reasons.length ? `Why: ${reasons.join("; ")}.` : ""} ${steps.join(" ")}`.trim() ||
        "The data cannot settle the question yet",
    );
  }

  const noise = decision.rule?.noise ?? DEFAULT_NOISE;
  if ((decision.rule?.scale ?? "ratio") === "ratio")
    details.push(
      sentence(`Differences under ${formatPercent(noise)} are treated as run-to-run noise`),
    );

  const rank = decision.rank ?? {};
  for (const id of Object.keys(rank).sort(
    (a, b) => (rank[b] ?? 0) - (rank[a] ?? 0) || a.localeCompare(b),
  )) {
    const note = verdict === "WIN" && id === decision.winner ? "" : " (a ranking, not a verdict)";
    details.push(
      sentence(
        `${candidateName(study, id)} ranked best on ${metric.label} in ${formatPercent(rank[id] ?? 0)} of resamples${note}`,
      ),
    );
  }
  for (const id of ids) {
    const e = decision.candidates?.[id];
    if (e?.verdict === "GATED-OUT")
      details.push(
        sentence(`${candidateName(study, id)} was ruled out: ${(e.reasons ?? []).join("; ")}`),
      );
  }
  const synthetic = ids.filter((id) => candidateDef(study, id)?.synthetic === true);
  if (synthetic.length)
    details.push(
      sentence(
        `${list(synthetic.map((id) => candidateName(study, id)))} ${synthetic.length === 1 ? "is a synthetic stand-in" : "are synthetic stand-ins"}, not the real thing; confirm on the real candidate before deciding`,
      ),
    );
  details.push(...explainLabels(study, extras.labels));
  details.push(...explainUnmeasured(study, extras.unmeasured));
  return { verdict, headline, meaning, details, nextSteps: steps };
}

/**
 * Explain a whole decision: the verdict, then each candidate in study order.
 * @param {any} decision
 * @param {any} study
 * @param {{ unmeasured?: Record<string, Record<string, { count: number, reasons: string[] }>>, labels?: Record<string, string[]> }} [extras]
 */
export function explainDecision(decision, study, extras = {}) {
  /** @type {string[]} */
  const ids = (study?.candidates ?? []).map((/** @type {any} */ c) => String(c.id));
  return {
    verdict: explainVerdict(decision, study, extras),
    candidates: ids.map((/** @type {string} */ id) => explainCandidate(decision, study, id)),
  };
}

// ---------------------------------------------------------------- honesty

const WIN_WORDS =
  /\b(win|wins|winner|winning|won|beat|beats|beaten|outperforms?|outperformed|superior|clears? the rule|cleared the rule)\b/gi;
// Negations and conditionals ("unless another candidate clears the rule") do not claim a win.
const NEGATION =
  /\b(no|not|never|cannot|can't|without|neither|nor|isn't|wasn't|doesn't|didn't|don't|unless|if|whether)\b|n't\b/i;

/**
 * Find wording that claims a win where the verdict is not a win. Verdict
 * tokens such as NO-WIN and negated phrases ("not a win", "did not clear
 * the rule") are allowed. Also checks that synthetic candidates are never
 * named without saying so.
 * @param {string} text
 * @param {{ verdict: string, synthetic?: string[] }} context
 * @returns {string[]} problems; empty when the wording is honest
 */
export function auditWording(text, { verdict, synthetic = [] }) {
  /** @type {string[]} */
  const problems = [];
  if (verdict !== "WIN") {
    const cleaned = text.replace(/\bNO-WIN\b/g, "NOWIN");
    for (const m of cleaned.matchAll(WIN_WORDS)) {
      const before = cleaned.slice(0, m.index).split(/\s+/).slice(-4).join(" ");
      if (!NEGATION.test(before))
        problems.push(`"${m[0]}" claims a win but the verdict is ${verdict}`);
    }
  }
  for (const id of synthetic) {
    const mention = new RegExp(
      `(^|[^\\w-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w-]|$)`,
    );
    for (const line of text.split("\n"))
      if (mention.test(line) && !/synthetic/i.test(line))
        problems.push(`${id} is synthetic but is named without saying so`);
  }
  return [...new Set(problems)];
}

/**
 * Audit every sentence of an explained decision.
 * @param {ReturnType<typeof explainDecision>} explained
 * @param {any} study
 */
export function auditDecision(explained, study) {
  const synthetic = (study?.candidates ?? [])
    .filter((/** @type {any} */ c) => c.synthetic === true)
    .map((/** @type {any} */ c) => String(c.id));
  const v = explained.verdict;
  const problems = auditWording([v.headline, v.meaning, ...v.details].join("\n"), {
    verdict: v.verdict,
    synthetic,
  });
  for (const c of explained.candidates) {
    const effective = c.verdict === "WIN" && v.verdict !== "INCONCLUSIVE" ? "WIN" : c.verdict;
    problems.push(
      ...auditWording([c.headline, c.meaning, ...c.details].join("\n"), {
        verdict: effective,
        synthetic,
      }),
    );
  }
  return [...new Set(problems)];
}

// ---------------------------------------------------------------- glossary

/** @param {unknown} g @returns {string[]} */
export function validateGlossary(g) {
  /** @type {string[]} */
  const problems = [];
  const obj = /** @type {any} */ (g);
  if (!obj || typeof obj !== "object" || Array.isArray(obj))
    return ["expected an object with schema and terms"];
  if (obj.schema !== GLOSSARY_SCHEMA) problems.push(`schema: expected ${GLOSSARY_SCHEMA}`);
  if (!obj.terms || typeof obj.terms !== "object" || Array.isArray(obj.terms))
    return [...problems, "terms: expected an object"];
  for (const [term, e] of Object.entries(obj.terms)) {
    const entry = /** @type {any} */ (e);
    if (term !== term.trim().toLowerCase() || !term)
      problems.push(`terms.${term}: keys must be lower-case and trimmed`);
    if (!entry || typeof entry.plain !== "string" || !entry.plain.trim())
      problems.push(`terms.${term}.plain: expected a non-empty string`);
    if (entry?.example !== undefined && typeof entry.example !== "string")
      problems.push(`terms.${term}.example: expected a string`);
    if (
      entry?.aliases !== undefined &&
      !(
        Array.isArray(entry.aliases) &&
        entry.aliases.every((/** @type {unknown} */ a) => typeof a === "string")
      )
    )
      problems.push(`terms.${term}.aliases: expected an array of strings`);
  }
  return problems;
}

/**
 * Read and validate a glossary file. A missing file is an empty glossary.
 * @param {string} file
 * @returns {Promise<import("./result.mjs").Result<Glossary>>}
 */
export async function readGlossary(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT")
      return ok({ schema: GLOSSARY_SCHEMA, terms: {} });
    return err("GLOSSARY_UNREADABLE", `cannot read ${file}: ${/** @type {Error} */ (e).message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return err(
      "GLOSSARY_INVALID",
      `${file} is not valid JSON: ${/** @type {Error} */ (e).message}`,
    );
  }
  const problems = validateGlossary(parsed);
  return problems.length
    ? err("GLOSSARY_INVALID", `${file} has problems: ${problems.join("; ")}`, problems)
    : ok(/** @type {Glossary} */ (parsed));
}

/**
 * Project terms add to (and may reword) the kit's terms.
 * @param {Glossary} base
 * @param {Glossary} [project]
 * @returns {Glossary}
 */
export function mergeGlossaries(base, project) {
  return { schema: GLOSSARY_SCHEMA, terms: { ...base.terms, ...(project?.terms ?? {}) } };
}

/** @param {string} s */
const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Look a term up by name or alias.
 * @param {Glossary} glossary
 * @param {string} query
 * @returns {import("./result.mjs").Result<{ term: string } & GlossaryEntry>}
 */
export function explainTerm(glossary, query) {
  const q = norm(query);
  const keys = Object.keys(glossary.terms).sort();
  const hit =
    keys.find((k) => k === q) ??
    keys.find((k) => (glossary.terms[k]?.aliases ?? []).some((a) => norm(a) === q));
  if (hit) return ok({ term: hit, .../** @type {GlossaryEntry} */ (glossary.terms[hit]) });
  const suggestions = q
    ? keys
        .filter(
          (k) =>
            k.includes(q) ||
            q.includes(k) ||
            (glossary.terms[k]?.aliases ?? []).some((a) => norm(a).includes(q)),
        )
        .slice(0, 5)
    : [];
  return err(
    "TERM_UNKNOWN",
    `"${query}" is not in the glossary${suggestions.length ? `; did you mean ${list(suggestions)}?` : ""}`,
    { suggestions },
  );
}

/**
 * Add a term. Refuses to silently replace an existing term or alias.
 * @param {Glossary} glossary
 * @param {string} term
 * @param {GlossaryEntry} entry
 * @param {{ replace?: boolean }} [options]
 * @returns {import("./result.mjs").Result<Glossary>}
 */
export function addTerm(glossary, term, entry, { replace = false } = {}) {
  const key = norm(term);
  const next = { schema: GLOSSARY_SCHEMA, terms: { ...glossary.terms, [key]: entry } };
  const problems = validateGlossary(next);
  if (problems.length) return err("GLOSSARY_INVALID", problems.join("; "), problems);
  if (!replace && Object.hasOwn(glossary.terms, key))
    return err("TERM_EXISTS", `"${key}" is already in the glossary`);
  const wanted = new Set([key, ...(entry.aliases ?? []).map(norm)]);
  const taken = Object.entries(glossary.terms).find(
    ([k, e]) => k !== key && (wanted.has(k) || (e.aliases ?? []).some((a) => wanted.has(norm(a)))),
  );
  if (taken)
    return err("TERM_EXISTS", `"${key}" or one of its aliases is already used by "${taken[0]}"`);
  return ok(next);
}

/**
 * Write a glossary atomically with LF line endings and sorted terms.
 * @param {string} file
 * @param {Glossary} glossary
 * @returns {Promise<import("./result.mjs").Result<string>>}
 */
export async function writeGlossary(file, glossary) {
  const problems = validateGlossary(glossary);
  if (problems.length) return err("GLOSSARY_INVALID", problems.join("; "), problems);
  const sorted = Object.fromEntries(
    Object.keys(glossary.terms)
      .sort()
      .map((k) => [k, glossary.terms[k]]),
  );
  return writeAtomic(file, jsonText({ schema: GLOSSARY_SCHEMA, terms: sorted }));
}
