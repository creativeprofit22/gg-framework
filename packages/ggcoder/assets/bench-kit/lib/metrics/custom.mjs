// @ts-check
// custom: a number the candidate reports itself (JSON on stdout or in its
// output file, a regex match on stdout), a raw adapter metric under another
// name, or the value a gate measured (e.g. the VMAF score).
import { getField, isFieldPath, parseJsonOutput, readSource, toNumber } from "../sample-io.mjs";
import { gateValueKey, measured, unknownKeys, unmeasured } from "./common.mjs";

export const CUSTOM_SOURCES = Object.freeze([
  "metric",
  "stdout-json",
  "output-json",
  "stdout-regex",
  "gate",
]);

/** @param {any} m */
export function validate(m) {
  const errors = unknownKeys(m, ["source", "field", "pattern", "gate", "scale"]);
  if (!CUSTOM_SOURCES.includes(m.source))
    return [...errors, `source: expected one of ${CUSTOM_SOURCES.join("|")}`];
  if (m.source === "metric" && (typeof m.field !== "string" || !m.field))
    errors.push("field: expected the adapter metric name, e.g. reported.export_seconds");
  if ((m.source === "stdout-json" || m.source === "output-json") && !isFieldPath(m.field))
    errors.push("field: expected a dotted path such as stats.decodeFps");
  if (m.source === "stdout-regex") {
    if (typeof m.pattern !== "string")
      errors.push("pattern: expected a regular expression with one capture group");
    else {
      try {
        new RegExp(m.pattern);
        if (!/\((?!\?)/.test(m.pattern))
          errors.push("pattern: needs a capture group around the number");
      } catch {
        errors.push("pattern: not a valid regular expression");
      }
    }
  }
  if (m.source === "gate" && (typeof m.gate !== "string" || !m.gate))
    errors.push("gate: expected the id of a gate that records a value");
  if (
    m.scale !== undefined &&
    !(typeof m.scale === "number" && Number.isFinite(m.scale) && m.scale !== 0)
  )
    errors.push("scale: expected a non-zero number");
  return errors;
}

/**
 * @param {any} sample
 * @param {any} m
 * @param {import("./common.mjs").MetricContext} ctx
 * @returns {Promise<import("./common.mjs").Extracted>}
 */
export async function extract(sample, m, ctx) {
  const scale = m.scale ?? 1;
  /** @param {number | undefined} v @param {string} why @param {string} label */
  const out = (v, why, label) => (v === undefined ? unmeasured(why) : measured(v * scale, label));
  if (m.source === "metric")
    return out(
      toNumber(sample?.metrics?.[m.field]),
      `the sample has no metric ${m.field}`,
      `adapter metric ${m.field}`,
    );
  if (m.source === "gate") {
    const v = ctx.gateValues.get(gateValueKey(m.gate, sample));
    return out(v, `gate ${m.gate} recorded no value for this sample`, `measured by gate ${m.gate}`);
  }
  const got = await readSource(
    sample,
    ctx.studyDir,
    m.source === "output-json" ? "output" : "stdout",
  );
  if (!got.ok) return unmeasured(got.error.message);
  const text = got.value.bytes.toString("utf8");
  if (m.source === "stdout-regex") {
    const match = new RegExp(m.pattern, "m").exec(text);
    return out(
      toNumber(match?.[1]),
      `pattern ${m.pattern} found no number in ${got.value.from}`,
      `reported by the candidate (${got.value.from})`,
    );
  }
  const json = parseJsonOutput(text);
  if (!json.ok) return unmeasured(`${got.value.from}: ${json.error.message}`);
  return out(
    toNumber(getField(json.value, m.field)),
    `${got.value.from} has no number at ${m.field}`,
    `reported by the candidate (${got.value.from})`,
  );
}
