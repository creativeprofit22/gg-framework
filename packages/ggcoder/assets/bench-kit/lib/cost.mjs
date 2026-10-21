// @ts-check
// Prices and cost. Prices come ONLY from `.gg/bench.config.json`; the kit
// never guesses one. Reported cost (what the agent CLI itself said) and
// estimated cost (tokens × a price you supplied) are kept apart, and every
// estimate records which price it used and when that price was checked.
//
//   "prices": {
//     "anthropic/claude-sonnet-5-5": {
//       "inputPerMTok": 3, "outputPerMTok": 15, "cacheReadPerMTok": 0.3, "cacheWritePerMTok": 3.75,
//       "source": "https://www.anthropic.com/pricing", "asOf": "2026-10-01"
//     }
//   }

const RATE_FIELDS = Object.freeze([
  "inputPerMTok",
  "outputPerMTok",
  "cacheReadPerMTok",
  "cacheWritePerMTok",
]);
const PRICE_KEYS = Object.freeze([...RATE_FIELDS, "source", "asOf"]);

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
/** @param {unknown} v */
const isRate = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * Check a price table. Returns every problem.
 * @param {unknown} prices
 * @returns {string[]}
 */
export function validatePrices(prices) {
  if (prices === undefined) return [];
  if (!isObject(prices)) return ["prices: expected an object of model keys to prices"];
  /** @type {string[]} */
  const e = [];
  for (const [key, p] of Object.entries(prices).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const at = `prices.${key}`;
    if (!isObject(p)) {
      e.push(`${at}: expected an object`);
      continue;
    }
    for (const k of Object.keys(p).sort())
      if (!PRICE_KEYS.includes(k)) e.push(`${at}.${k}: unknown price field`);
    for (const k of ["inputPerMTok", "outputPerMTok"])
      if (!isRate(p[k])) e.push(`${at}.${k}: expected a price in USD per million tokens`);
    for (const k of ["cacheReadPerMTok", "cacheWritePerMTok"])
      if (p[k] !== undefined && !isRate(p[k]))
        e.push(`${at}.${k}: expected a price in USD per million tokens`);
    for (const k of ["source", "asOf"])
      if (typeof p[k] !== "string" || !p[k].trim())
        e.push(`${at}.${k}: required, so every estimate says where its price came from`);
  }
  return e;
}

/**
 * The price-table key for an agent candidate: `pricing` when set, else
 * "provider/model", else the model.
 * @param {any} adapter
 * @returns {string | undefined}
 */
export function priceKey(adapter) {
  if (typeof adapter?.pricing === "string") return adapter.pricing;
  if (typeof adapter?.model !== "string") return undefined;
  return typeof adapter.provider === "string"
    ? `${adapter.provider}/${adapter.model}`
    : adapter.model;
}

/**
 * Estimate a sample's cost from its token usage. Anything that cannot be
 * priced exactly (no price, no usage, cache tokens without a cache price)
 * comes back unpriced with the reason; it is never filled in.
 * @param {import("./transcript.mjs").Usage | undefined} usage
 * @param {Record<string, any> | undefined} prices
 * @param {string | undefined} key
 * @returns {{ usd: number, price: { key: string, source: string, asOf: string } } | { unpriced: string }}
 */
export function estimateCost(usage, prices, key) {
  if (key === undefined)
    return { unpriced: "the candidate names no model or pricing key, so no price applies" };
  const p = prices?.[key];
  if (!isObject(p))
    return {
      unpriced: `no price for "${key}" in .gg/bench.config.json; prices are never guessed`,
    };
  if (usage?.inputTokens === undefined || usage.outputTokens === undefined)
    return { unpriced: "the agent reported no input/output token usage" };
  let usd = (usage.inputTokens * p.inputPerMTok + usage.outputTokens * p.outputPerMTok) / 1e6;
  for (const [tokens, rate, label] of /** @type {const} */ ([
    [usage.cacheReadTokens, "cacheReadPerMTok", "cache-read"],
    [usage.cacheWriteTokens, "cacheWritePerMTok", "cache-write"],
  ])) {
    if (!tokens) continue;
    if (!isRate(p[rate]))
      return {
        unpriced: `"${key}" has no ${label} price but the agent used ${tokens} ${label} tokens`,
      };
    usd += (tokens * p[rate]) / 1e6;
  }
  return { usd, price: { key, source: p.source, asOf: p.asOf } };
}

/**
 * The best known cost of a finished sample: reported first, then estimated.
 * @param {Record<string, number> | undefined} metrics
 * @returns {{ usd: number, source: "reported" | "estimated" } | undefined}
 */
export function knownCost(metrics) {
  if (isRate(metrics?.costUsdReported))
    return { usd: /** @type {number} */ (metrics?.costUsdReported), source: "reported" };
  if (isRate(metrics?.costUsdEstimated))
    return { usd: /** @type {number} */ (metrics?.costUsdEstimated), source: "estimated" };
  return undefined;
}
