// @ts-check
// quality: an external tool scores the output (e.g. VMAF against a reference
// clip) and the score must clear a threshold. The tool's output is parsed by
// a declared format; nothing is guessed. Tools that write a report file use
// the {report} slot; otherwise stdout is parsed.
import { readFile } from "node:fs/promises";

import { getField, isFieldPath, parseJsonOutput, toNumber } from "../sample-io.mjs";
import {
  errored,
  failed,
  isFiniteNumber,
  lastLines,
  pass,
  runGateCommand,
  unknownKeys,
  validateGateCommand,
  validateTimeout,
  withValue,
} from "./common.mjs";

export const QUALITY_FORMATS = Object.freeze(["vmaf-json", "json-field", "number", "regex"]);

/**
 * Pull the score out of tool output per the declared format.
 * @param {string} text
 * @param {{ format: string, field?: string, pattern?: string }} spec
 * @returns {import("../result.mjs").Result<number>}
 */
export function parseScore(text, spec) {
  const fail = (/** @type {string} */ m) =>
    /** @type {const} */ ({ ok: false, error: { code: "SCORE_UNREADABLE", message: m } });
  if (spec.format === "number") {
    const lines = text.trim().split(/\r?\n/).reverse();
    for (const line of lines) {
      const n = toNumber(line.trim());
      if (n !== undefined) return { ok: true, value: n };
    }
    return fail("no line of the output is a plain number");
  }
  if (spec.format === "regex") {
    const m = new RegExp(/** @type {string} */ (spec.pattern), "m").exec(text);
    const n = toNumber(m?.[1]);
    return n === undefined
      ? fail(`pattern ${spec.pattern} found no number`)
      : { ok: true, value: n };
  }
  const json = parseJsonOutput(text);
  if (!json.ok) return fail(json.error.message);
  if (spec.format === "vmaf-json") {
    // libvmaf JSON log: pooled_metrics.vmaf.mean; older ffmpeg/vmaf builds: aggregate.VMAF_score.
    const n =
      toNumber(getField(json.value, "pooled_metrics.vmaf.mean")) ??
      toNumber(getField(json.value, "aggregate.VMAF_score"));
    return n === undefined
      ? fail("no pooled_metrics.vmaf.mean (or aggregate.VMAF_score) in the VMAF output")
      : { ok: true, value: n };
  }
  const n = toNumber(getField(json.value, /** @type {string} */ (spec.field)));
  return n === undefined ? fail(`no number at ${spec.field}`) : { ok: true, value: n };
}

/** @param {any} g */
export function validate(g) {
  const errors = unknownKeys(g, [
    "command",
    "format",
    "field",
    "pattern",
    "min",
    "max",
    "timeoutMs",
    "passEnv",
  ]);
  if (g.command === undefined) errors.push("command: required");
  else errors.push(...validateGateCommand(g));
  if (!QUALITY_FORMATS.includes(g.format))
    errors.push(`format: expected one of ${QUALITY_FORMATS.join("|")}`);
  if (g.format === "json-field" && !isFieldPath(g.field))
    errors.push("field: json-field needs a dotted path, e.g. score.mean");
  if (g.format === "regex") {
    if (typeof g.pattern !== "string")
      errors.push("pattern: regex needs a pattern with one capture group");
    else {
      try {
        new RegExp(g.pattern);
        if (!/\((?!\?)/.test(g.pattern))
          errors.push("pattern: needs a capture group around the number");
      } catch {
        errors.push("pattern: not a valid regular expression");
      }
    }
  }
  for (const k of ["min", "max"])
    if (g[k] !== undefined && !isFiniteNumber(g[k])) errors.push(`${k}: expected a number`);
  if (g.min === undefined && g.max === undefined)
    errors.push("min or max: declare the threshold the score must clear");
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
  const g = ctx.gate;
  const run = await runGateCommand(ctx);
  if (run.problem) return run.problem;
  const r = /** @type {import("../sandbox/process.mjs").ProcessResult} */ (run.result);
  if (r.exitCode !== 0)
    return errored(
      `quality tool exited ${r.exitCode ?? r.signal}${r.stderrTail.trim() ? `: ${lastLines(r.stderrTail)}` : ""}`,
    );
  let text = r.stdoutTail;
  try {
    text = await readFile(/** @type {string} */ (run.report), "utf8");
  } catch {
    // no report file: the tool printed its result
  }
  const score = parseScore(text, g);
  if (!score.ok) return errored(score.error.message);
  const v = score.value;
  if (g.min !== undefined && v < g.min)
    return withValue(failed(`score ${v} is below the minimum ${g.min}`), v);
  if (g.max !== undefined && v > g.max)
    return withValue(failed(`score ${v} is above the maximum ${g.max}`), v);
  return withValue(
    pass(
      `score ${v} clears ${[g.min !== undefined ? `min ${g.min}` : "", g.max !== undefined ? `max ${g.max}` : ""].filter(Boolean).join(" and ")}`,
    ),
    v,
  );
}
