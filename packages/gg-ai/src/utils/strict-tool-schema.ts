/**
 * Provider-side constrained sampling ("strict" tool schemas).
 *
 * OpenAI-style strict tool definitions make the provider guarantee that tool
 * arguments conform to the JSON Schema at sampling time, killing the whole
 * class of malformed tool calls that today cost a retry round-trip (and a
 * 3-strikes turn abort) before the args ever reach Zod validation.
 *
 * Strict mode imposes rules the schemas Zod emits do not satisfy on their own:
 *
 *   1. Every key in `properties` must be listed in `required`.
 *   2. Objects must set `additionalProperties: false`.
 *   3. Optional properties must become nullable unions — a required key the
 *      model cannot omit has to be representable as `null`.
 *   4. Compositional keywords (`$ref`, `oneOf`, `allOf`, `patternProperties`,
 *      …) are rejected by the provider.
 *
 * `makeStrictToolSchema` rewrites a resolved schema into that subset. Schemas
 * that cannot be expressed (refs, unions of objects, tuples) throw
 * `UnsupportedStrictSchemaError` so the caller can silently fall back to the
 * non-strict schema — "prefer", never "require".
 */

type JsonSchema = Record<string, unknown>;

export class UnsupportedStrictSchemaError extends Error {}

const UNSUPPORTED_KEYS = [
  "$ref",
  "$defs",
  "definitions",
  "allOf",
  "oneOf",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
  "unevaluatedProperties",
  "propertyNames",
  "contains",
  "prefixItems",
  "not",
  "if",
  "then",
  "else",
] as const;

function isSchemaObject(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStructured(value: unknown): boolean {
  if (!isSchemaObject(value)) return false;
  const types =
    typeof value.type === "string" ? [value.type] : Array.isArray(value.type) ? value.type : [];
  return (
    types.includes("object") ||
    types.includes("array") ||
    value.properties !== undefined ||
    value.items !== undefined
  );
}

function allowsNull(schema: unknown): boolean {
  if (!isSchemaObject(schema)) return false;
  if (schema.type === "null" || (Array.isArray(schema.type) && schema.type.includes("null")))
    return true;
  if (schema.const === null || (Array.isArray(schema.enum) && schema.enum.includes(null)))
    return true;
  return Array.isArray(schema.anyOf) && schema.anyOf.some((variant) => allowsNull(variant));
}

function makeNodeStrict(schema: unknown): void {
  if (!isSchemaObject(schema)) {
    throw new UnsupportedStrictSchemaError("boolean schemas are unsupported");
  }
  for (const key of UNSUPPORTED_KEYS) {
    if (schema[key] !== undefined) {
      throw new UnsupportedStrictSchemaError(`${key} schemas are unsupported`);
    }
  }

  if (schema.anyOf !== undefined) {
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) {
      throw new UnsupportedStrictSchemaError("anyOf must contain at least one schema");
    }
    for (const variant of schema.anyOf) {
      if (isStructured(variant)) {
        throw new UnsupportedStrictSchemaError("object and array unions are unsupported");
      }
      makeNodeStrict(variant);
    }
  }

  if (schema.items !== undefined) {
    if (Array.isArray(schema.items)) {
      throw new UnsupportedStrictSchemaError("tuple schemas are unsupported");
    }
    makeNodeStrict(schema.items);
  }

  const isObjectSchema = schema.type === "object";
  if (schema.properties !== undefined && !isObjectSchema) {
    throw new UnsupportedStrictSchemaError("properties require type object");
  }
  if (!isObjectSchema) return;
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    throw new UnsupportedStrictSchemaError(
      "schema-valued or true additionalProperties is unsupported",
    );
  }
  if (schema.properties !== undefined && !isSchemaObject(schema.properties)) {
    throw new UnsupportedStrictSchemaError("object properties must be a schema map");
  }

  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  for (const [key, property] of Object.entries(properties)) {
    makeNodeStrict(property);
    if (!required.has(key) && !allowsNull(property)) {
      properties[key] = { anyOf: [property, { type: "null" }] };
    }
  }
  schema.required = Object.keys(properties);
  schema.additionalProperties = false;
}

/**
 * Providers whose tool-calling endpoints document `strict: true` on function
 * definitions. Everything else routed through the OpenAI-compatible transport
 * (DeepSeek, GLM, Moonshot, local servers, …) is left alone: they either
 * reject or silently ignore the flag, and we gain nothing by sending it.
 */
export function supportsStrictToolSampling(provider: string): boolean {
  return provider === "openai";
}

/**
 * Rewrite a resolved tool schema into the strict subset. Throws
 * {@link UnsupportedStrictSchemaError} when the schema cannot be expressed;
 * callers fall back to the unmodified schema.
 */
export function makeStrictToolSchema(schema: JsonSchema): JsonSchema {
  const cloned = structuredClone(schema);
  if (!isSchemaObject(cloned)) {
    throw new UnsupportedStrictSchemaError("root schema must be an object");
  }
  makeNodeStrict(cloned);
  if (cloned.type !== "object") {
    throw new UnsupportedStrictSchemaError("root schema must have type object");
  }
  return cloned;
}
