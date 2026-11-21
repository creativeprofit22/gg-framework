// @ts-check
// peak-memory: the highest memory use seen. Polled readings are labelled
// "sampled" with their resolution; a short spike between polls can be missed.
import { BYTE_UNITS, fromRaw, unknownKeys, validateUnit } from "./common.mjs";

/** @param {any} m */
export function validate(m) {
  return [...unknownKeys(m, []), ...validateUnit(m, BYTE_UNITS, "B")];
}

/** @param {any} sample @param {any} m @returns {Promise<import("./common.mjs").Extracted>} */
export async function extract(sample, m) {
  const unit = /** @type {keyof typeof BYTE_UNITS} */ (m.unit ?? "B");
  const label =
    typeof sample?.info?.peakMemory?.label === "string" ? sample.info.peakMemory.label : undefined;
  return fromRaw(
    sample,
    "peakMemoryBytes",
    BYTE_UNITS[unit],
    label ?? "this adapter does not measure memory",
    label,
  );
}
