// @ts-check
// output-size: total bytes the candidate wrote to its output (file or folder).
import { BYTE_UNITS, fromRaw, unknownKeys, validateUnit } from "./common.mjs";

/** @param {any} m */
export function validate(m) {
  return [...unknownKeys(m, []), ...validateUnit(m, BYTE_UNITS, "B")];
}

/** @param {any} sample @param {any} m @returns {Promise<import("./common.mjs").Extracted>} */
export async function extract(sample, m) {
  const unit = /** @type {keyof typeof BYTE_UNITS} */ (m.unit ?? "B");
  return fromRaw(sample, "outputBytes", BYTE_UNITS[unit], "this sample saved no output");
}
