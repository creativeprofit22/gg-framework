// @ts-check
// cpu-time: CPU time (user + system) per call. Only adapters that run code
// in-process measure it today; others report it as unmeasured, never zero.
import { TIME_UNITS, fromRaw, unknownKeys, validateUnit } from "./common.mjs";

/** @param {any} m */
export function validate(m) {
  return [...unknownKeys(m, []), ...validateUnit(m, TIME_UNITS, "ms")];
}

/** @param {any} sample @param {any} m @returns {Promise<import("./common.mjs").Extracted>} */
export async function extract(sample, m) {
  const unit = /** @type {keyof typeof TIME_UNITS} */ (m.unit ?? "ms");
  return fromRaw(
    sample,
    "cpuMs",
    TIME_UNITS[unit],
    "this adapter does not measure CPU time",
    "user + system CPU per call",
  );
}
