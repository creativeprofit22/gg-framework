// @ts-check
// Shared metric helpers: units, result shapes, config checks.

/** Milliseconds per time unit. */
export const TIME_UNITS = Object.freeze({ ns: 1e-6, us: 1e-3, ms: 1, s: 1000, min: 60_000 });
/** Bytes per size unit. KB/MB/GB are decimal (SI); KiB/MiB/GiB are binary. */
export const BYTE_UNITS = Object.freeze({
  B: 1,
  KB: 1e3,
  MB: 1e6,
  GB: 1e9,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
});

/**
 * @typedef {{ value?: number, unmeasured?: string, label?: string }} Extracted
 * @typedef {{ studyDir: string, gateValues: Map<string, number> }} MetricContext
 */

/** @param {number} value @param {string} [label] @returns {Extracted} */
export const measured = (value, label) => (label ? { value, label } : { value });
/** @param {string} reason @returns {Extracted} */
export const unmeasured = (reason) => ({ unmeasured: reason });

/** Key under which a gate's value for one sample is looked up. @param {string} gate @param {any} sample */
export const gateValueKey = (gate, sample) =>
  `${gate}\u0000${sample.runId ?? ""}\u0000${sample.index ?? 0}`;

/**
 * Reject unknown keys (a typo would silently change what is measured).
 * @param {Record<string, any>} m
 * @param {readonly string[]} own
 */
export function unknownKeys(m, own) {
  const shared = ["id", "type", "unit", "better", "label", "description", "explain"];
  return Object.keys(m)
    .filter((k) => !shared.includes(k) && !own.includes(k))
    .sort()
    .map((k) => `${k}: unknown option for a ${m.type} metric`);
}

/** @param {any} m @param {Readonly<Record<string, number>>} units @param {string} fallback */
export function validateUnit(m, units, fallback) {
  if (m.unit === undefined || Object.hasOwn(units, m.unit)) return [];
  return [`unit: expected one of ${Object.keys(units).join("|")} (default ${fallback})`];
}

/**
 * Read a raw adapter metric and convert from its base unit.
 * @param {any} sample
 * @param {string} field
 * @param {number} perUnit  base units per declared unit
 * @param {string} missing  reason when the adapter did not record it
 * @param {string} [label]
 * @returns {Extracted}
 */
export function fromRaw(sample, field, perUnit, missing, label) {
  const raw = sample?.metrics?.[field];
  if (typeof raw !== "number" || !Number.isFinite(raw)) return unmeasured(missing);
  return measured(raw / perUnit, label);
}
