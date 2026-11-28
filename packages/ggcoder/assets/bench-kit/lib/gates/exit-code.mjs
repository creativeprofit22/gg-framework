// @ts-check
// exit-code: the candidate's process must exit with an expected code.
import { errored, failed, isObject, pass, scopeOf, unknownKeys } from "./common.mjs";

/** @param {any} g */
export function validate(g) {
  const errors = unknownKeys(g, ["expect"]);
  if (scopeOf(g) !== "sample")
    errors.push('scope: an exit-code gate checks each sample; use "scope": "sample"');
  const e = g.expect;
  if (
    e !== undefined &&
    !Number.isInteger(e) &&
    !(Array.isArray(e) && e.length > 0 && e.every(Number.isInteger))
  )
    errors.push("expect: expected an integer or a non-empty array of integers");
  return errors;
}

/** @param {import("./common.mjs").GateContext} ctx @returns {Promise<import("./common.mjs").GateResult>} */
export async function check(ctx) {
  const expected = ctx.gate.expect === undefined ? [0] : [ctx.gate.expect].flat();
  const info = isObject(ctx.sample?.info) ? ctx.sample.info : {};
  const code = Number.isInteger(info.exitCode) ? info.exitCode : ctx.sample?.metrics?.exitCode;
  if (!Number.isInteger(code)) {
    if (info.signal) return failed(`process was killed by ${info.signal}`);
    return errored("this adapter does not report an exit code");
  }
  return expected.includes(code)
    ? pass(`exited ${code}`)
    : failed(`exited ${code}, expected ${expected.join(" or ")}`);
}
