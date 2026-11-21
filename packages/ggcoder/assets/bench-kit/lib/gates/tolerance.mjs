// @ts-check
// tolerance: a number (or array of numbers) the candidate produced must be
// close to the expected one. Close means within `abs` OR within `rel`.
import { readFile } from "node:fs/promises";
import path from "node:path";

import { getField, isFieldPath, parseJsonOutput, readSource, toNumber } from "../sample-io.mjs";
import {
  errored,
  failed,
  isFiniteNumber,
  pass,
  scopeOf,
  unknownKeys,
  withValue,
} from "./common.mjs";

export const TOLERANCE_SOURCES = Object.freeze(["metric", "stdout-json", "output-json"]);

/** @param {any} g */
export function validate(g) {
  const errors = unknownKeys(g, ["source", "field", "target", "expectedField", "abs", "rel"]);
  if (scopeOf(g) !== "sample")
    errors.push('scope: a tolerance gate checks each sample; use "scope": "sample"');
  if (!TOLERANCE_SOURCES.includes(g.source))
    errors.push(`source: expected one of ${TOLERANCE_SOURCES.join("|")}`);
  if (
    g.source === "metric"
      ? typeof g.field !== "string" || !g.field
      : g.field !== undefined && !isFieldPath(g.field)
  )
    errors.push(
      g.source === "metric"
        ? "field: expected the adapter metric name, e.g. wallMs"
        : "field: expected a dotted path such as result.frames[0]",
    );
  if (g.expectedField !== undefined && !isFieldPath(g.expectedField))
    errors.push("expectedField: expected a dotted path");
  if (
    g.target !== undefined &&
    !isFiniteNumber(g.target) &&
    !(Array.isArray(g.target) && g.target.every(isFiniteNumber))
  )
    errors.push("target: expected a number or an array of numbers");
  for (const k of ["abs", "rel"])
    if (g[k] !== undefined && !(isFiniteNumber(g[k]) && g[k] >= 0))
      errors.push(`${k}: expected a number >= 0`);
  if (g.abs === undefined && g.rel === undefined)
    errors.push("abs or rel: declare at least one tolerance");
  return errors;
}

/** @param {unknown} v @returns {number[] | undefined} */
function numbers(v) {
  if (Array.isArray(v)) {
    const xs = v.map(toNumber);
    return xs.every((x) => x !== undefined) ? /** @type {number[]} */ (xs) : undefined;
  }
  const x = toNumber(v);
  return x === undefined ? undefined : [x];
}

/** @param {import("./common.mjs").GateContext} ctx @returns {Promise<import("./common.mjs").GateResult>} */
export async function check(ctx) {
  const g = ctx.gate;
  /** @type {unknown} */
  let raw;
  if (g.source === "metric") {
    raw = ctx.sample?.metrics?.[g.field];
    if (raw === undefined) return errored(`the sample has no metric ${g.field}`);
  } else {
    const got = await readSource(
      ctx.sample,
      ctx.studyDir,
      g.source === "stdout-json" ? "stdout" : "output",
    );
    if (!got.ok) return errored(got.error.message);
    const json = parseJsonOutput(got.value.bytes.toString("utf8"));
    if (!json.ok) return failed(`${got.value.from}: ${json.error.message}`);
    raw = g.field ? getField(json.value, g.field) : json.value;
  }
  const actual = numbers(raw);
  if (!actual) return failed(`${g.field ?? "value"} is not a number or list of numbers`);

  /** @type {unknown} */
  let rawTarget = g.target;
  if (rawTarget === undefined) {
    if (!ctx.item?.expectedFile)
      return errored(
        `no target: the gate has none and item ${ctx.sample?.item} has no expectedFile`,
      );
    let text;
    try {
      text = await readFile(path.join(ctx.workloadDir, ctx.item.expectedFile), "utf8");
    } catch {
      return errored(`expected file ${ctx.item.expectedFile} is unreadable`);
    }
    const json = parseJsonOutput(text);
    if (!json.ok) return errored(`expected file ${ctx.item.expectedFile} is not JSON`);
    const field = g.expectedField ?? (g.source === "metric" ? undefined : g.field);
    rawTarget = field ? getField(json.value, field) : json.value;
  }
  const target = numbers(rawTarget);
  if (!target) return errored("the target is not a number or list of numbers");
  if (target.length !== actual.length)
    return failed(`got ${actual.length} value(s), expected ${target.length}`);

  const abs = g.abs ?? 0;
  const rel = g.rel ?? 0;
  let worst = 0;
  for (let i = 0; i < actual.length; i++) {
    const a = /** @type {number} */ (actual[i]);
    const t = /** @type {number} */ (target[i]);
    const diff = Math.abs(a - t);
    worst = Math.max(worst, diff);
    if (diff > abs && diff > rel * Math.abs(t)) {
      const where = actual.length > 1 ? ` at position ${i}` : "";
      return withValue(
        failed(
          `${a} is ${diff} away from ${t}${where} (allowed: ${[g.abs !== undefined ? `±${abs}` : "", g.rel !== undefined ? `±${rel * 100}%` : ""].filter(Boolean).join(" or ")})`,
        ),
        actual.length === 1 ? a : undefined,
      );
    }
  }
  return withValue(
    pass(
      actual.length === 1
        ? `${actual[0]} is within tolerance of ${target[0]}`
        : `all ${actual.length} values within tolerance (largest gap ${worst})`,
    ),
    actual.length === 1 ? actual[0] : undefined,
  );
}
