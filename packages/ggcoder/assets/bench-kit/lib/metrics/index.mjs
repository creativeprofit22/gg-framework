// @ts-check
// Metric registry and extraction. Maps each study metric (with its own id
// and unit) onto the raw numbers adapters recorded, producing the
// data[candidate][metric][item] = number[] shape the decision rule reads.
// A value that was not measured is recorded as unmeasured with a reason,
// never as zero.
import { gateValueKey } from "./common.mjs";
import * as cpuTime from "./cpu-time.mjs";
import * as custom from "./custom.mjs";
import * as outputSize from "./output-size.mjs";
import * as peakMemory from "./peak-memory.mjs";
import * as rating from "./rating.mjs";
import * as tokensCost from "./tokens-cost.mjs";
import * as wallTime from "./wall-time.mjs";

/**
 * @typedef {{ validate: (m: any) => string[], extract: (sample: any, m: any, ctx: import("./common.mjs").MetricContext) => Promise<import("./common.mjs").Extracted> }} MetricModule
 * @typedef {{ count: number, reasons: string[] }} Unmeasured
 */

/** @type {Readonly<Record<string, MetricModule>>} */
export const METRICS = Object.freeze({
  "wall-time": wallTime,
  "cpu-time": cpuTime,
  "peak-memory": peakMemory,
  "output-size": outputSize,
  "tokens-cost": tokensCost,
  custom,
  rating,
});

/** Default unit per metric type, for reports. */
export const DEFAULT_UNITS = Object.freeze({
  "wall-time": "ms",
  "cpu-time": "ms",
  "peak-memory": "B",
  "output-size": "B",
});

/** Validators for validateStudy's `registries.metrics`. @param {Record<string, MetricModule>} [extra] */
export function metricValidators(extra = {}) {
  return Object.fromEntries(
    Object.entries({ ...METRICS, ...extra }).map(([type, m]) => [type, { validate: m.validate }]),
  );
}

/** @param {any} a @param {any} b */
const bySampleOrder = (a, b) =>
  String(a.runId ?? "").localeCompare(String(b.runId ?? "")) || (a.index ?? 0) - (b.index ?? 0);

/**
 * Extract every study metric from the completed measured samples.
 * @param {{
 *   study: any,
 *   samples: any[],
 *   studyDir: string,
 *   gateChecks?: import("../gates/index.mjs").GateCheck[],
 *   registry?: Record<string, MetricModule>,
 * }} options
 */
export async function extractMetrics({
  study,
  samples,
  studyDir,
  gateChecks = [],
  registry = METRICS,
}) {
  /** @type {Map<string, number>} */
  const gateValues = new Map();
  for (const c of gateChecks)
    if (c.value !== undefined && c.index !== undefined)
      gateValues.set(gateValueKey(c.gate, c), c.value);
  const ctx = { studyDir, gateValues };

  /** @type {Record<string, Record<string, Record<string, number[]>>>} */
  const data = {};
  /** @type {Record<string, Record<string, Unmeasured>>} */
  const missing = {};
  /** @type {Record<string, string[]>} */
  const labels = {};

  const done = samples
    .filter((s) => s.phase === "measure" && s.status === "ok")
    .sort(bySampleOrder);
  for (const m of study.metrics) {
    const module = registry[m.type];
    /** @type {Set<string>} */
    const seen = new Set();
    for (const s of done) {
      const r = module
        ? await module.extract(s, m, ctx)
        : { unmeasured: `metric type ${m.type} is not available in this kit version` };
      if (r.value === undefined) {
        const u = ((missing[s.candidate] ??= {})[m.id] ??= { count: 0, reasons: [] });
        u.count++;
        const reason = r.unmeasured ?? "not measured";
        if (!u.reasons.includes(reason)) u.reasons.push(reason);
        continue;
      }
      (((data[s.candidate] ??= {})[m.id] ??= {})[s.item] ??= []).push(r.value);
      if (r.label) seen.add(r.label);
    }
    labels[m.id] = [...seen].sort();
  }
  return { data, unmeasured: missing, labels };
}
