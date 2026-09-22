import { z } from "zod";
import type { Tool } from "../types.js";

type JsonSchema = Record<string, unknown>;

// Tool schemas are immutable within a session. Cache conversion, not raw MCP input.
const schemaCache = new WeakMap<z.ZodType, JsonSchema>();

export function zodToJsonSchema(schema: z.ZodType): JsonSchema {
  const cached = schemaCache.get(schema);
  if (cached) return cached;
  const { $schema: _schema, ...rest } = z.toJSONSchema(schema) as JsonSchema;
  const normalized = normalizeRootForAnthropic(rest);
  schemaCache.set(schema, normalized);
  return normalized;
}

/**
 * Resolve a tool's base JSON Schema before provider adapters: prefer the
 * pre-built `rawInputSchema`, otherwise use the shared Zod conversion.
 * Adapters may then normalize roots, sanitize fields, or enforce strict schemas;
 * this result is not a guarantee of the final schema sent on the wire.
 */
export function resolveToolSchema(tool: Tool): JsonSchema {
  return tool.rawInputSchema ?? zodToJsonSchema(tool.parameters);
}

function isSchema(value: unknown): value is JsonSchema {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function incompatible(reason: string): never {
  throw new Error(`Anthropic tool-schema compatibility: ${reason}`);
}

const annotations = new Set(["title", "description", "$comment", "default", "examples", "$schema"]);
const objectKeywords = new Set(["type", "properties", "required", "additionalProperties"]);

/**
 * Anthropic forbids root oneOf/anyOf/allOf. Project object unions to model hints
 * (branch-dependent required fields remain the runtime validator's job), and
 * intersect object constraints without overwriting colliding property schemas.
 * Nested schemas are never flattened. Unsupported compositions fail locally.
 * Reference expansion is document-local, own-property-only, and bounded.
 */
export function normalizeRootForAnthropic(schema: JsonSchema): JsonSchema {
  if (!["oneOf", "anyOf", "allOf", "$ref"].some((key) => key in schema)) return schema;
  let visits = 0;
  const active = new Set<JsonSchema>();

  function object(value: unknown): JsonSchema {
    if (!isSchema(value)) incompatible("expected an object schema");
    return value;
  }

  function check(node: JsonSchema): void {
    if (node.type !== undefined && node.type !== "object")
      incompatible("composition includes a non-object branch");
    for (const key of Object.keys(node)) {
      if (
        !objectKeywords.has(key) &&
        !annotations.has(key) &&
        key !== "$defs" &&
        key !== "definitions"
      ) {
        incompatible(`cannot safely flatten object keyword ${key}`);
      }
    }
    if (node.properties !== undefined) object(node.properties);
    if (
      node.required !== undefined &&
      (!Array.isArray(node.required) || node.required.some((key) => typeof key !== "string"))
    ) {
      incompatible("invalid required list");
    }
    if (node.additionalProperties !== undefined && typeof node.additionalProperties !== "boolean") {
      incompatible("schema-valued additionalProperties in a composition");
    }
  }

  function props(node: JsonSchema): JsonSchema {
    return (node.properties ?? {}) as JsonSchema;
  }

  function required(node: JsonSchema): string[] {
    return (node.required ?? []) as string[];
  }

  function combine(
    nodes: JsonSchema[],
    union: boolean,
    sharedFields: ReadonlySet<string> = new Set(),
  ): JsonSchema {
    nodes.forEach(check);
    const keys = [...new Set(nodes.flatMap((node) => Object.keys(props(node))))];
    const properties: JsonSchema = Object.create(null);
    for (const key of keys) {
      const variants = nodes
        .filter((node) => Object.hasOwn(props(node), key))
        .map((node) => props(node)[key]);
      // A shared field still exists in variants that leave it unconstrained.
      // Keep that alternative when intersecting the union with its root schema;
      // otherwise one branch's restriction would leak into unrelated variants.
      if (
        union &&
        sharedFields.has(key) &&
        nodes.some(
          (node) => !Object.hasOwn(props(node), key) && node.additionalProperties !== false,
        )
      ) {
        variants.push(true);
      }
      if (variants.some((value) => typeof value !== "boolean" && !isSchema(value)))
        incompatible("invalid property schema");
      const unique = variants.filter(
        (value, index) =>
          variants.findIndex((other) => JSON.stringify(other) === JSON.stringify(value)) === index,
      );
      // Collapse only pure literal schemas, never discard extra nested constraints.
      const literals = unique.every(
        (value) =>
          isSchema(value) &&
          Object.hasOwn(value, "const") &&
          Object.keys(value).every(
            (key) => key === "const" || key === "type" || annotations.has(key),
          ),
      );
      properties[key] =
        unique.length === 1
          ? unique[0]
          : union && literals
            ? { enum: unique.map((value) => (value as JsonSchema).const) }
            : { [union ? "anyOf" : "allOf"]: unique };
    }
    if (!union) {
      // Extending a closed allOf branch would change which keys it prohibits.
      for (const node of nodes) {
        if (
          node.additionalProperties === false &&
          keys.some((key) => !Object.hasOwn(props(node), key))
        ) {
          incompatible("intersection extends a closed object branch");
        }
      }
    }
    const fields = [...new Set(nodes.flatMap(required))].filter(
      (key) => !union || nodes.every((node) => required(node).includes(key)),
    );
    const out: JsonSchema = { type: "object", properties };
    if (fields.length) out.required = fields;
    if (
      union
        ? nodes.every((node) => node.additionalProperties === false)
        : nodes.some((node) => node.additionalProperties === false)
    ) {
      out.additionalProperties = false;
    }
    // Keep annotations and definition containers; conflicting definitions would
    // change local reference meaning, so do not silently pick a winner.
    for (const node of nodes) {
      for (const [key, value] of Object.entries(node)) {
        if (annotations.has(key)) out[key] ??= value;
        if (key === "$defs" || key === "definitions") {
          if (out[key] !== undefined && JSON.stringify(out[key]) !== JSON.stringify(value))
            incompatible("conflicting reference definitions");
          out[key] = value;
        }
      }
    }
    return out;
  }

  function resolve(reference: unknown, document: JsonSchema): unknown {
    if (typeof reference !== "string" || (reference !== "#" && !reference.startsWith("#/")))
      incompatible("only local JSON Pointer references are supported");
    if (reference === "#") return document;
    let target: unknown = document;
    let pointer: string;
    try {
      pointer = decodeURIComponent(reference.slice(2));
    } catch {
      incompatible("invalid local reference encoding");
    }
    for (const segment of pointer.split("/")) {
      if (/~(?:[^01]|$)/.test(segment)) incompatible("invalid local reference escape");
      const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
      if ((!isSchema(target) && !Array.isArray(target)) || !Object.hasOwn(target, key))
        incompatible("unresolved local reference");
      target = (target as JsonSchema)[key];
    }
    return target;
  }

  function visit(
    value: unknown,
    depth: number,
    inheritedFields: ReadonlySet<string> = new Set(),
  ): JsonSchema {
    if (++visits > 256 || depth > 32)
      incompatible("reference/composition expansion limit exceeded");
    const node = object(value);
    if (active.has(node)) incompatible("cyclic root reference/composition");
    active.add(node);
    try {
      const { $ref, oneOf, anyOf, allOf, ...base } = node;
      check(base);
      const sharedFields = new Set([...inheritedFields, ...Object.keys(props(base))]);
      const parts: JsonSchema[] = [];
      if ($ref !== undefined) {
        parts.push(visit(resolve($ref, schema), depth + 1, sharedFields));
      }
      for (const [keyword, branches] of [
        ["allOf", allOf],
        ["oneOf", oneOf],
        ["anyOf", anyOf],
      ] as const) {
        if (branches === undefined) continue;
        if (!Array.isArray(branches) || branches.length === 0 || branches.length > 256)
          incompatible(`invalid or oversized ${keyword}`);
        const resolved = branches.map((branch) => visit(branch, depth + 1, sharedFields));
        parts.push(combine(resolved, keyword !== "allOf", sharedFields));
      }
      if (!parts.length) return { ...base, type: "object" };
      // A metadata-only wrapper is neutral, including a root type: object.
      const hasConstraints = Object.keys(base).some(
        (key) => objectKeywords.has(key) && key !== "type",
      );
      const combined = combine(hasConstraints ? [base, ...parts] : parts, false);
      return { ...base, ...combined };
    } finally {
      active.delete(node);
    }
  }

  const result = visit(schema, 0);
  // Flattening must not strand nested pointers into removed root branches or
  // silently retarget them to a newly merged property. Walk schema locations,
  // not literal data in const/default/examples, and never expand nested refs.
  let inspected = 0;
  const seen = new Set<object>();
  function validateReferences(value: unknown, depth: number): void {
    if (!isSchema(value) || seen.has(value)) return;
    if (++inspected > 4096 || depth > 64) incompatible("nested schema inspection limit exceeded");
    seen.add(value);
    if (value.$id !== undefined)
      incompatible("reference scope changes are not supported in compositions");
    if (value.$ref !== undefined) {
      if (resolve(value.$ref, schema) !== resolve(value.$ref, result))
        incompatible("flattening would change a nested reference target");
    }
    for (const key of [
      "properties",
      "patternProperties",
      "$defs",
      "definitions",
      "dependentSchemas",
    ]) {
      if (isSchema(value[key]))
        for (const child of Object.values(value[key])) validateReferences(child, depth + 1);
    }
    for (const key of [
      "items",
      "additionalProperties",
      "additionalItems",
      "unevaluatedProperties",
      "unevaluatedItems",
      "contains",
      "propertyNames",
      "not",
      "if",
      "then",
      "else",
      "allOf",
      "oneOf",
      "anyOf",
      "prefixItems",
    ]) {
      const child = value[key];
      if (Array.isArray(child)) child.forEach((item) => validateReferences(item, depth + 1));
      else validateReferences(child, depth + 1);
    }
  }
  validateReferences(result, 0);
  return result;
}
