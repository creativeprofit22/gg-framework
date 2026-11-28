// @ts-check
// schema: the candidate's JSON output must match a JSON Schema. A small,
// documented subset is supported; any other keyword is refused at validation
// time instead of being silently ignored.
import { readFile } from "node:fs/promises";
import path from "node:path";

import { canonicalJson } from "../protocol.mjs";
import { SOURCES, parseJsonOutput, readSource } from "../sample-io.mjs";
import { errored, failed, isObject, pass, scopeOf, unknownKeys } from "./common.mjs";

export const SCHEMA_KEYWORDS = Object.freeze([
  "$schema",
  "title",
  "description",
  "type",
  "enum",
  "const",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
]);
const TYPES = ["object", "array", "string", "number", "integer", "boolean", "null"];

/**
 * Check that a schema only uses supported keywords.
 * @param {unknown} schema
 * @param {string} at
 * @returns {string[]}
 */
export function checkSchema(schema, at = "schema") {
  if (typeof schema === "boolean") return [];
  if (!isObject(schema)) return [`${at}: expected an object`];
  /** @type {string[]} */
  const errors = [];
  for (const k of Object.keys(schema).sort())
    if (!SCHEMA_KEYWORDS.includes(k))
      errors.push(`${at}.${k}: unsupported keyword (supported: ${SCHEMA_KEYWORDS.join(", ")})`);
  const types = [schema.type ?? []].flat();
  for (const t of types)
    if (!TYPES.includes(t)) errors.push(`${at}.type: unknown type ${JSON.stringify(t)}`);
  if (schema.pattern !== undefined) {
    try {
      new RegExp(schema.pattern, "u");
    } catch {
      errors.push(`${at}.pattern: not a valid regular expression`);
    }
  }
  if (
    schema.required !== undefined &&
    !(Array.isArray(schema.required) && schema.required.every((r) => typeof r === "string"))
  )
    errors.push(`${at}.required: expected an array of names`);
  if (schema.properties !== undefined) {
    if (!isObject(schema.properties)) errors.push(`${at}.properties: expected an object`);
    else
      for (const [k, v] of Object.entries(schema.properties))
        errors.push(...checkSchema(v, `${at}.properties.${k}`));
  }
  if (schema.items !== undefined) errors.push(...checkSchema(schema.items, `${at}.items`));
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean")
    errors.push(...checkSchema(schema.additionalProperties, `${at}.additionalProperties`));
  return errors;
}

/** @param {unknown} v */
const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

/**
 * Validate a value; returns the first few problems with JSON paths.
 * @param {unknown} value
 * @param {any} schema
 * @param {string} at
 * @param {string[]} out
 */
export function validateValue(value, schema, at = "$", out = []) {
  if (out.length >= 5) return out;
  if (schema === true) return out;
  if (schema === false) {
    out.push(`${at}: no value allowed here`);
    return out;
  }
  const t = typeOf(value);
  const types = [schema.type ?? []].flat();
  if (
    types.length &&
    !types.some(
      (/** @type {string} */ want) =>
        want === t ||
        (want === "integer" && Number.isInteger(value)) ||
        (want === "number" && t === "number"),
    )
  ) {
    out.push(`${at}: expected ${types.join(" or ")}, got ${t}`);
    return out;
  }
  if (schema.const !== undefined && canonicalJson(value) !== canonicalJson(schema.const))
    out.push(`${at}: expected ${JSON.stringify(schema.const)}`);
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((/** @type {unknown} */ e) => canonicalJson(e) === canonicalJson(value))
  )
    out.push(
      `${at}: expected one of ${schema.enum.map((/** @type {unknown} */ e) => JSON.stringify(e)).join(", ")}`,
    );
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum)
      out.push(`${at}: ${value} is below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum)
      out.push(`${at}: ${value} is above ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum)
      out.push(`${at}: ${value} must be above ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum)
      out.push(`${at}: ${value} must be below ${schema.exclusiveMaximum}`);
  }
  if (typeof value === "string") {
    const n = [...value].length;
    if (schema.minLength !== undefined && n < schema.minLength)
      out.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && n > schema.maxLength)
      out.push(`${at}: longer than ${schema.maxLength}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value))
      out.push(`${at}: does not match ${schema.pattern}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      out.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      out.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.items !== undefined)
      value.forEach((v, i) => validateValue(v, schema.items, `${at}[${i}]`, out));
  }
  if (isObject(value)) {
    for (const r of schema.required ?? [])
      if (!Object.hasOwn(value, r)) out.push(`${at}: missing required ${r}`);
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(value)) {
      if (Object.hasOwn(props, k)) validateValue(v, props[k], `${at}.${k}`, out);
      else if (schema.additionalProperties !== undefined)
        validateValue(v, schema.additionalProperties, `${at}.${k}`, out);
    }
  }
  return out;
}

/** @param {any} g */
export function validate(g) {
  const errors = unknownKeys(g, ["source", "schema", "schemaFile"]);
  if (scopeOf(g) !== "sample")
    errors.push('scope: a schema gate checks each sample; use "scope": "sample"');
  if (g.source !== undefined && !SOURCES.includes(g.source))
    errors.push(`source: expected one of ${SOURCES.join("|")}`);
  if ((g.schema === undefined) === (g.schemaFile === undefined))
    errors.push("schema or schemaFile: declare exactly one");
  if (g.schema !== undefined) errors.push(...checkSchema(g.schema));
  if (
    g.schemaFile !== undefined &&
    (typeof g.schemaFile !== "string" ||
      path.isAbsolute(g.schemaFile) ||
      g.schemaFile.split(/[\\/]/).includes(".."))
  )
    errors.push("schemaFile: expected a path inside the study folder");
  return errors;
}

/** @param {import("./common.mjs").GateContext} ctx @returns {Promise<import("./common.mjs").GateResult>} */
export async function check(ctx) {
  const g = ctx.gate;
  let schema = g.schema;
  if (schema === undefined) {
    try {
      schema = JSON.parse(await readFile(path.join(ctx.studyDir, g.schemaFile), "utf8"));
    } catch {
      return errored(`schema file ${g.schemaFile} is missing or not JSON`);
    }
    const bad = checkSchema(schema);
    if (bad.length) return errored(`schema file ${g.schemaFile}: ${bad[0]}`);
  }
  const got = await readSource(ctx.sample, ctx.studyDir, g.source ?? "output");
  if (!got.ok) return errored(got.error.message);
  const json = parseJsonOutput(got.value.bytes.toString("utf8"));
  if (!json.ok) return failed(`${got.value.from}: ${json.error.message}`);
  const problems = validateValue(json.value, schema);
  return problems.length
    ? failed(`${got.value.from} breaks the schema: ${problems.join("; ")}`)
    : pass(`${got.value.from} matches the schema`);
}
