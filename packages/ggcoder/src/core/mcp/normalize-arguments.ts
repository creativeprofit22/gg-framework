type Schema = Record<string, unknown>;

function isObject(value: unknown): value is Schema {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// References, branches and dependencies can change whether a property is
// required or nullable. Leave those nodes untouched rather than guessing.
const CONDITIONAL_KEYS = [
  "$ref",
  "$dynamicRef",
  "$recursiveRef",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "dependencies",
  "dependentRequired",
  "dependentSchemas",
  "patternProperties",
];

function isSimpleSchema(schema: unknown): schema is Schema {
  return isObject(schema) && CONDITIONAL_KEYS.every((key) => !Object.hasOwn(schema, key));
}

// Only analyze primitive unions, not arbitrary JSON Schema compositions. Unknown
// keywords deliberately fall back to preserving null, as do structured branches.
const PRIMITIVE_KEYS = new Set([
  "type",
  "anyOf",
  "enum",
  "const",
  "title",
  "description",
  "default",
  "examples",
  "$comment",
  "deprecated",
  "readOnly",
  "writeOnly",
  "format",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
]);
const PRIMITIVE_TYPES = ["string", "number", "integer", "boolean"];

function isNonNullPrimitive(value: unknown): boolean {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function primitiveExcludesNull(schema: unknown, depth = 0): boolean {
  if (
    depth >= 64 ||
    !isObject(schema) ||
    !Object.keys(schema).every((key) => PRIMITIVE_KEYS.has(key))
  )
    return false;

  let proven = false;
  if (Object.hasOwn(schema, "type")) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (types.length === 0 || !types.every((type) => PRIMITIVE_TYPES.includes(type))) return false;
    proven = true;
  }
  if (Object.hasOwn(schema, "enum")) {
    if (
      !Array.isArray(schema.enum) ||
      schema.enum.length === 0 ||
      !schema.enum.every(isNonNullPrimitive)
    )
      return false;
    proven = true;
  }
  if (Object.hasOwn(schema, "const")) {
    if (!isNonNullPrimitive(schema.const)) return false;
    proven = true;
  }
  if (Object.hasOwn(schema, "anyOf")) {
    if (
      !Array.isArray(schema.anyOf) ||
      schema.anyOf.length === 0 ||
      !schema.anyOf.every((branch) => primitiveExcludesNull(branch, depth + 1))
    )
      return false;
    proven = true;
  }
  return proven;
}

function excludesNull(schema: unknown): boolean {
  if (primitiveExcludesNull(schema)) return true;
  if (!isSimpleSchema(schema)) return false;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const nonNullTypes = ["string", "number", "integer", "boolean", "object", "array"];
  return types.length > 0 && types.every((type) => nonNullTypes.includes(type));
}

/**
 * Strict provider schemas encode omitted optional properties as null. Undo
 * that encoding only where the original MCP schema proves the property is
 * optional and non-nullable. This is not validation: required/unknown values,
 * genuine nulls and ambiguous schemas still reach the server unchanged.
 * Never mutate the caller's arguments or schema, or remove array elements.
 */
export function normalizeMcpArguments(value: unknown, schema: unknown, depth = 0): unknown {
  if (depth >= 64 || !isSimpleSchema(schema)) return value;
  if (Array.isArray(value)) {
    if (schema.type !== "array" || !isSimpleSchema(schema.items) || schema.prefixItems)
      return value;
    return value.map((entry) => normalizeMcpArguments(entry, schema.items, depth + 1));
  }
  if (!isObject(value) || schema.type !== "object" || !isObject(schema.properties)) return value;
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) || !schema.required.every((key) => typeof key === "string"))
  ) {
    return value;
  }
  const required = new Set((schema.required ?? []) as string[]);
  const properties = schema.properties;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      // Own-property lookup avoids interpreting __proto__/constructor as schemas.
      if (!Object.hasOwn(properties, key)) return [[key, entry]];
      const property = properties[key];
      if (entry === null && !required.has(key) && excludesNull(property)) return [];
      return [[key, normalizeMcpArguments(entry, property, depth + 1)]];
    }),
  );
}
