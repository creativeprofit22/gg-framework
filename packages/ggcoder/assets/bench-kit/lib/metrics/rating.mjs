// @ts-check
// rating: blind human scores. They do not come from samples; `rate import`
// unblinds a filled-in pack and the report reads the saved scores. Per
// sample this metric is therefore always unmeasured, with a reason that says
// where the numbers come from.
import { unknownKeys, unmeasured } from "./common.mjs";

const ID = /^[A-Za-z0-9_.-]{1,64}$/;

/** @param {any} m */
export function validate(m) {
  const errors = unknownKeys(m, ["packs"]);
  if (
    m.packs !== undefined &&
    !(
      Array.isArray(m.packs) &&
      m.packs.length > 0 &&
      m.packs.every((/** @type {unknown} */ p) => typeof p === "string" && ID.test(p))
    )
  )
    errors.push("packs: expected a non-empty list of rating pack ids");
  return errors;
}

/** @returns {Promise<import("./common.mjs").Extracted>} */
export async function extract() {
  return unmeasured("comes from blind ratings (`rate import`), not from samples");
}
