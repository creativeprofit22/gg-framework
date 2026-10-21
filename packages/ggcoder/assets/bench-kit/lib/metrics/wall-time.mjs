// @ts-check
// wall-time: elapsed time as the adapter measured it (process spawn to exit,
// request to last byte, or median per call for in-process functions).
import { TIME_UNITS, fromRaw, unknownKeys, validateUnit } from "./common.mjs";

export const RAW_FIELDS = Object.freeze(["wallMs", "wallMsMean", "ttfbMs"]);

/** @param {any} m */
export function validate(m) {
  const errors = [...unknownKeys(m, ["field"]), ...validateUnit(m, TIME_UNITS, "ms")];
  if (m.field !== undefined && !RAW_FIELDS.includes(m.field))
    errors.push(`field: expected one of ${RAW_FIELDS.join("|")} (default wallMs)`);
  return errors;
}

/** @param {any} sample @param {any} m @returns {Promise<import("./common.mjs").Extracted>} */
export async function extract(sample, m) {
  const unit = /** @type {keyof typeof TIME_UNITS} */ (m.unit ?? "ms");
  const timing = typeof sample?.info?.timing === "string" ? sample.info.timing : undefined;
  return fromRaw(
    sample,
    m.field ?? "wallMs",
    TIME_UNITS[unit],
    "this adapter recorded no wall time",
    timing,
  );
}
