// @ts-check
// tokens-cost: model tokens an agent used, or what a run cost. Tokens are
// what the agent CLI reported. Cost has two sources that are never mixed
// silently: "reported" (the agent CLI's own figure) and "estimated" (its
// tokens × a price from .gg/bench.config.json). "reported-else-estimated"
// takes the reported figure when there is one; the report lists which
// sources were used. Missing usage or price is unmeasured, never zero.
//
//   { "id": "tokens", "type": "tokens-cost", "measure": "total-tokens" }
//   { "id": "cost", "type": "tokens-cost", "measure": "cost", "costSource": "reported-else-estimated" }
import { measured, unknownKeys, unmeasured } from "./common.mjs";

export const TOKEN_MEASURES = Object.freeze({
  "input-tokens": "inputTokens",
  "output-tokens": "outputTokens",
  "cache-read-tokens": "cacheReadTokens",
  "cache-write-tokens": "cacheWriteTokens",
  "total-tokens": "totalTokens",
});
export const COST_SOURCES = Object.freeze(["reported", "estimated", "reported-else-estimated"]);
export const TOKEN_UNITS = Object.freeze({ tokens: 1, ktok: 1e3, Mtok: 1e6 });
export const COST_UNITS = Object.freeze({ USD: 1, cents: 0.01 });

/** @param {any} m */
export function validate(m) {
  const e = unknownKeys(m, ["measure", "costSource"]);
  const isCost = m.measure === "cost";
  if (!isCost && !Object.hasOwn(TOKEN_MEASURES, m.measure))
    return [...e, `measure: expected one of ${[...Object.keys(TOKEN_MEASURES), "cost"].join("|")}`];
  if (isCost && !COST_SOURCES.includes(m.costSource))
    e.push(
      `costSource: required for cost, one of ${COST_SOURCES.join("|")} (reported and estimated costs are kept apart)`,
    );
  if (!isCost && m.costSource !== undefined) e.push("costSource: only applies to measure cost");
  const units = isCost ? COST_UNITS : TOKEN_UNITS;
  if (m.unit !== undefined && !Object.hasOwn(units, m.unit))
    e.push(`unit: expected one of ${Object.keys(units).join("|")}`);
  return e;
}

/** Default unit for a tokens-cost metric. @param {any} m */
export const defaultUnit = (m) => (m?.measure === "cost" ? "USD" : "tokens");

/** @param {unknown} v */
const finite = (v) => typeof v === "number" && Number.isFinite(v);

/** @param {any} sample @param {any} m @returns {Promise<import("./common.mjs").Extracted>} */
export async function extract(sample, m) {
  const unit = m.unit ?? defaultUnit(m);
  if (m.measure !== "cost") {
    const field = TOKEN_MEASURES[/** @type {keyof typeof TOKEN_MEASURES} */ (m.measure)];
    const raw = sample?.metrics?.[field];
    if (!finite(raw)) return unmeasured("the agent reported no token usage for this run");
    return measured(
      raw / TOKEN_UNITS[/** @type {keyof typeof TOKEN_UNITS} */ (unit)],
      "reported by the agent CLI",
    );
  }
  const per = COST_UNITS[/** @type {keyof typeof COST_UNITS} */ (unit)];
  const reported = sample?.metrics?.costUsdReported;
  const estimated = sample?.metrics?.costUsdEstimated;
  const price = sample?.info?.cost?.price;
  const estimatedLabel = `estimated from the price table (${price?.key ?? "unknown key"}, prices as of ${price?.asOf ?? "unknown date"})`;
  if (m.costSource !== "estimated" && finite(reported))
    return measured(reported / per, "reported by the agent CLI");
  if (m.costSource !== "reported" && finite(estimated))
    return measured(estimated / per, estimatedLabel);
  if (m.costSource === "reported")
    return unmeasured(
      'the agent CLI reported no cost (use "costSource": "estimated" with a price table to estimate it)',
    );
  return unmeasured(
    typeof sample?.info?.cost?.unpriced === "string"
      ? sample.info.cost.unpriced
      : "no cost was reported or estimated for this run",
  );
}
