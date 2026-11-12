// @ts-check
// command: a custom check script decides. It must print one JSON object
// {"pass": true|false, "value"?: number, "reason"?: string} on stdout (the
// last JSON line counts). No JSON, or a contradiction between the JSON and
// the exit code, means the gate could not be checked: errored, never passed.
import { parseJsonOutput, toNumber } from "../sample-io.mjs";
import {
  errored,
  failed,
  isObject,
  lastLines,
  pass,
  runGateCommand,
  unknownKeys,
  validateGateCommand,
  validateTimeout,
  withValue,
} from "./common.mjs";

/** @param {any} g */
export function validate(g) {
  const errors = unknownKeys(g, ["command", "timeoutMs", "passEnv"]);
  if (g.command === undefined) errors.push("command: required");
  else errors.push(...validateGateCommand(g));
  errors.push(...validateTimeout(g.timeoutMs));
  if (
    g.passEnv !== undefined &&
    !(
      Array.isArray(g.passEnv) &&
      g.passEnv.every(
        (/** @type {unknown} */ n) => typeof n === "string" && /^[A-Za-z_][A-Za-z0-9_()]*$/.test(n),
      )
    )
  )
    errors.push("passEnv: expected an array of variable names");
  return errors;
}

/** @param {import("./common.mjs").GateContext} ctx @returns {Promise<import("./common.mjs").GateResult>} */
export async function check(ctx) {
  const run = await runGateCommand(ctx);
  if (run.problem) return run.problem;
  const r = /** @type {import("../sandbox/process.mjs").ProcessResult} */ (run.result);
  const json = parseJsonOutput(r.stdoutTail);
  if (!json.ok || !isObject(json.value) || typeof json.value.pass !== "boolean")
    return errored(
      `check script printed no {"pass": true|false} JSON (exit ${r.exitCode ?? r.signal})${r.stderrTail.trim() ? `: ${lastLines(r.stderrTail)}` : ""}`,
    );
  const verdict = json.value;
  const value = toNumber(verdict.value);
  const reason =
    typeof verdict.reason === "string" && verdict.reason.trim() ? verdict.reason.trim() : undefined;
  if (verdict.pass && r.exitCode !== 0)
    return errored(`check script said pass but exited ${r.exitCode ?? r.signal}`);
  return withValue(
    verdict.pass ? pass(reason ?? "check script passed") : failed(reason ?? "check script failed"),
    value,
  );
}
