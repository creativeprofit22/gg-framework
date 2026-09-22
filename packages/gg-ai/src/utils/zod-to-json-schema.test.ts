import { describe, it, expect } from "vitest";
import { z } from "zod";
import { normalizeRootForAnthropic, zodToJsonSchema } from "./zod-to-json-schema.js";

describe("Anthropic object compositions", () => {
  it.each(["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__", "prototype"])(
    "preserves own special field %s, literals and required membership",
    (key) => {
      const prototypeBefore = Object.getOwnPropertyDescriptors(Object.prototype);
      for (const keyword of ["oneOf", "anyOf"]) {
        for (const requiredInBoth of [true, false]) {
          // Parse as MCP JSON so __proto__ is an own field, not object-literal syntax.
          const schema = JSON.parse(JSON.stringify({
            [keyword]: ["a", "b"].map((value, index) => ({
              type: "object",
              properties: { [key]: { type: "string", const: value } },
              required: requiredInBoth || index === 0 ? [key] : [],
            })),
          }));
          const before = structuredClone(schema);
          const result = normalizeRootForAnthropic(schema);
          const properties = result.properties as Record<string, unknown>;
          expect(Object.keys(properties)).toEqual([key]);
          expect(Object.hasOwn(properties, key)).toBe(true);
          expect(properties[key]).toEqual({ enum: ["a", "b"] });
          expect(result.required ?? []).toEqual(requiredInBoth ? [key] : []);
          expect(JSON.parse(JSON.stringify(result)).properties[key]).toEqual({ enum: ["a", "b"] });
          expect(schema).toEqual(before);
        }
      }
      expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(prototypeBefore);
    },
  );

  it("does not mistake an inherited member for an own branch field", () => {
    const schema = JSON.parse(`{
      "oneOf": [
        {"type":"object","properties":{"constructor":{"type":"string","const":"a"}},"required":["constructor"]},
        {"type":"object","properties":{"toString":{"type":"string","const":"b"}},"required":["toString"]}
      ]
    }`);
    const result = normalizeRootForAnthropic(schema);
    expect(result.properties).toEqual({
      constructor: { type: "string", const: "a" },
      toString: { type: "string", const: "b" },
    });
    expect(result.required ?? []).toEqual([]);
  });
  it.each([
    [{ type: "string", const: "auto" }, { type: "integer", minimum: 1 }],
    [{ type: "string" }, { type: "number" }],
    [{ type: "string", const: "auto" }, { type: "string" }],
    [{ const: "read" }, { enum: ["list", "write"], type: "string" }],
    [{ const: "read" }, { const: "write", type: "string", minLength: 2 }],
    [{ const: "read" }, true],
  ])("keeps property alternatives separate: %j / %j", (first, second) => {
    for (const keyword of ["oneOf", "anyOf"]) {
      const schema = {
        [keyword]: [first, second].map((value) => ({
          type: "object",
          properties: { value },
          required: ["value"],
        })),
      };
      const before = structuredClone(schema);
      expect(normalizeRootForAnthropic(schema)).toEqual({
        type: "object",
        properties: { value: { anyOf: [first, second] } },
        required: ["value"],
      });
      expect(schema).toEqual(before);
    }
  });

  it("compacts pure mixed-type literals without keeping one alternative's type", () => {
    expect(normalizeRootForAnthropic({
      oneOf: [
        { properties: { kind: { type: "string", const: "auto" } } },
        { properties: { kind: { type: "integer", const: 1 } } },
        { properties: { kind: { type: "boolean", const: false } } },
      ],
    }).properties).toEqual({ kind: { enum: ["auto", 1, false] } });
  });
  it.each([
    { oneOf: [{ $ref: "https://example.invalid/schema" }] },
    { oneOf: [{ $ref: "#/$defs/missing" }] },
    { $defs: { loop: { $ref: "#/$defs/loop" } }, allOf: [{ $ref: "#/$defs/loop" }] },
    { anyOf: [{ type: "string" }, { type: "object" }] },
    { allOf: [] },
    {
      allOf: [
        { type: "object", additionalProperties: false },
        { properties: { x: { type: "string" } } },
      ],
    },
    { oneOf: [{ type: "object", minProperties: 1 }] },
    { oneOf: [{ $ref: "#/$defs/__proto__" }], $defs: {} },
  ])("rejects unsupported compositions locally: %j", (schema) => {
    expect(() => normalizeRootForAnthropic(schema)).toThrow(/Anthropic tool-schema compatibility/);
  });

  it("preserves recursive nested definitions without expanding them", () => {
    const node = { type: "object", properties: { next: { $ref: "#/$defs/node" } } };
    const schema = { $defs: { node }, allOf: [{ properties: { tree: { $ref: "#/$defs/node" } } }] };
    expect(normalizeRootForAnthropic(schema)).toMatchObject({
      $defs: { node },
      properties: { tree: { $ref: "#/$defs/node" } },
    });
  });

  it("rejects nested references stranded by flattening and root reference cycles", () => {
    expect(() =>
      normalizeRootForAnthropic({
        allOf: [{ properties: { x: { $ref: "#/allOf/0/properties/y" }, y: { type: "string" } } }],
      }),
    ).toThrow(/unresolved local reference/);
    expect(() => normalizeRootForAnthropic({ $ref: "#" })).toThrow(/cyclic/);
  });

  it("bounds deep and broad expansion", () => {
    let schema: Record<string, unknown> = { type: "object" };
    for (let i = 0; i < 40; i++) schema = { allOf: [schema] };
    expect(() => normalizeRootForAnthropic(schema)).toThrow(/limit/);
    expect(() =>
      normalizeRootForAnthropic({ anyOf: Array.from({ length: 256 }, () => ({ type: "object" })) }),
    ).toThrow(/limit/);
  });

  it("decodes escaped local pointers and preserves property alternatives", () => {
    const result = normalizeRootForAnthropic({
      $defs: { "a/b~c": { properties: { value: { type: "string", minLength: 2 } } } },
      anyOf: [
        { $ref: "#/$defs/a~1b~0c" },
        { properties: { value: { type: "integer", minimum: 1 } } },
      ],
    });
    expect(result.properties).toEqual({
      value: {
        anyOf: [
          { type: "string", minLength: 2 },
          { type: "integer", minimum: 1 },
        ],
      },
    });
  });

  it.each(["oneOf", "anyOf"])("preserves shared fields and requirements for %s", (keyword) => {
    const schema = {
      type: "object",
      title: "Workspace actions",
      $defs: { workspace: { type: "string", minLength: 1 } },
      properties: {
        workspace: { $ref: "#/$defs/workspace" },
        limit: { type: "integer", minimum: 1 },
      },
      required: ["workspace"],
      [keyword]: [
        {
          properties: { action: { const: "read" }, limit: { maximum: 10 }, path: { type: "string" } },
          required: ["action", "path"],
        },
        { properties: { action: { const: "list" }, limit: { maximum: 100 } }, required: ["action"] },
      ],
    };
    const before = structuredClone(schema);
    expect(normalizeRootForAnthropic(schema)).toEqual({
      type: "object",
      title: schema.title,
      $defs: schema.$defs,
      properties: {
        workspace: schema.properties.workspace,
        limit: { allOf: [schema.properties.limit, { anyOf: [{ maximum: 10 }, { maximum: 100 }] }] },
        action: { enum: ["read", "list"] },
        path: { type: "string" },
      },
      required: ["workspace", "action"],
    });
    expect(schema).toEqual(before);
  });

  it.each(["oneOf", "anyOf"])("does not narrow an open variant's shared field in %s", (keyword) => {
    const schema = {
      properties: { limit: { type: "integer", minimum: 1 } },
      [keyword]: [
        { properties: { action: { const: "read" }, limit: { maximum: 10 } } },
        { properties: { action: { const: "list" } } },
      ],
    };
    expect(normalizeRootForAnthropic(schema).properties).toEqual({
      limit: { allOf: [schema.properties.limit, { anyOf: [{ maximum: 10 }, true] }] },
      action: { enum: ["read", "list"] },
    });
  });

  it("keeps root constraints alongside combined compositions", () => {
    const result = normalizeRootForAnthropic({
      type: "object",
      properties: { common: { type: "string" } },
      required: ["common"],
      allOf: [{ properties: { count: { type: "integer" } }, required: ["count"] }],
      oneOf: [
        { properties: { action: { const: "a" } }, required: ["action"] },
        { properties: { action: { const: "b" } }, required: ["action"] },
      ],
    });
    expect(result).toEqual({
      type: "object",
      properties: {
        common: { type: "string" },
        count: { type: "integer" },
        action: { enum: ["a", "b"] },
      },
      required: ["common", "count", "action"],
    });
  });
  it.each(["oneOf", "anyOf"])(
    "resolves local %s branches and preserves nested unions",
    (keyword) => {
      const nested = { anyOf: [{ type: "string" }, { type: "number" }] };
      const schema = {
        type: "object",
        $defs: {
          a: {
            type: "object",
            properties: { action: { const: "a" }, value: nested },
            required: ["action"],
          },
          b: { properties: { action: { const: "b" }, value: nested }, required: ["action"] },
        },
        [keyword]: [{ $ref: "#/$defs/a" }, { $ref: "#/$defs/b" }],
      };
      const before = structuredClone(schema);
      expect(normalizeRootForAnthropic(schema)).toMatchObject({
        type: "object",
        properties: { action: { enum: ["a", "b"] }, value: nested },
        required: ["action"],
      });
      expect(normalizeRootForAnthropic(schema)).not.toHaveProperty(keyword);
      expect(schema).toEqual(before);
    },
  );

  it("intersects properties and required fields without losing nested constraints", () => {
    const schema = {
      allOf: [
        { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
        {
          properties: { value: { minLength: 2 }, count: { type: "integer" } },
          required: ["count"],
        },
      ],
    };
    expect(normalizeRootForAnthropic(schema)).toEqual({
      type: "object",
      properties: {
        value: { allOf: [{ type: "string" }, { minLength: 2 }] },
        count: { type: "integer" },
      },
      required: ["value", "count"],
    });
  });
});

describe("zodToJsonSchema", () => {
  it("converts a simple string schema", () => {
    const result = zodToJsonSchema(z.string());
    expect(result).toHaveProperty("type", "string");
  });

  it("converts an object schema with multiple fields", () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
      active: z.boolean(),
    });
    const result = zodToJsonSchema(schema);
    expect(result).toHaveProperty("type", "object");
    expect(result).toHaveProperty("properties");
    const props = result.properties as Record<string, unknown>;
    expect(props).toHaveProperty("name");
    expect(props).toHaveProperty("age");
    expect(props).toHaveProperty("active");
  });

  it("includes description from .describe()", () => {
    const schema = z.string().describe("A user's full name");
    const result = zodToJsonSchema(schema);
    expect(result).toHaveProperty("type", "string");
    expect(result).toHaveProperty("description", "A user's full name");
  });

  it("handles optional fields correctly", () => {
    const schema = z.object({
      required: z.string(),
      optional: z.string().optional(),
    });
    const result = zodToJsonSchema(schema);
    expect(result).toHaveProperty("type", "object");
    const required = result.required as string[];
    expect(required).toContain("required");
    expect(required).not.toContain("optional");
  });

  it("strips the $schema key from output", () => {
    const schema = z.string();
    const result = zodToJsonSchema(schema);
    expect(result).not.toHaveProperty("$schema");
  });

  it("handles nested object and array schemas", () => {
    const schema = z.object({
      tags: z.array(z.string()),
      address: z.object({
        street: z.string(),
        city: z.string(),
      }),
    });
    const result = zodToJsonSchema(schema);
    expect(result).toHaveProperty("type", "object");

    const props = result.properties as Record<string, Record<string, unknown>>;

    // Array field
    expect(props.tags).toHaveProperty("type", "array");
    expect(props.tags).toHaveProperty("items");

    // Nested object field
    expect(props.address).toHaveProperty("type", "object");
    const addressProps = props.address.properties as Record<string, unknown>;
    expect(addressProps).toHaveProperty("street");
    expect(addressProps).toHaveProperty("city");
  });

  it("includes min/max constraints on number schemas", () => {
    const schema = z.number().min(1).max(100);
    const result = zodToJsonSchema(schema);
    expect(result).toHaveProperty("type", "number");
    expect(result).toHaveProperty("minimum", 1);
    expect(result).toHaveProperty("maximum", 100);
  });

  it("flattens root discriminated unions (Anthropic disallows oneOf/anyOf at root)", () => {
    const schema = z.discriminatedUnion("action", [
      z.object({ action: z.literal("create"), name: z.string() }),
      z.object({ action: z.literal("delete"), id: z.string() }),
    ]);
    const result = zodToJsonSchema(schema);
    // Anthropic requires root type='object' AND no oneOf/anyOf/allOf at root.
    expect(result).toHaveProperty("type", "object");
    expect(result).not.toHaveProperty("oneOf");
    expect(result).not.toHaveProperty("anyOf");
    expect(result).not.toHaveProperty("allOf");
    // Discriminator collapses to enum.
    const props = result.properties as Record<string, Record<string, unknown>>;
    expect(props.action.enum).toEqual(["create", "delete"]);
    // All branch fields are present (model gets the full hint).
    expect(props).toHaveProperty("name");
    expect(props).toHaveProperty("id");
    // Required = intersection across branches: only `action` is in every branch.
    expect(result.required).toEqual(["action"]);
  });

  it("flattens root z.union too", () => {
    const schema = z.union([
      z.object({ kind: z.literal("a"), value: z.string() }),
      z.object({ kind: z.literal("b"), value: z.number() }),
    ]);
    const result = zodToJsonSchema(schema);
    expect(result).toHaveProperty("type", "object");
    expect(result).not.toHaveProperty("oneOf");
    expect(result).not.toHaveProperty("anyOf");
    const props = result.properties as Record<string, Record<string, unknown>>;
    expect(props.kind.enum).toEqual(["a", "b"]);
    const alternatives = schema.options.map((option) => z.toJSONSchema(option).properties!.value);
    expect(props.value).toEqual({ anyOf: alternatives });
    expect(schema.parse({ kind: "a", value: "text" })).toEqual({ kind: "a", value: "text" });
    expect(schema.parse({ kind: "b", value: 42 })).toEqual({ kind: "b", value: 42 });
    expect(schema.safeParse({ kind: "a", value: 42 }).success).toBe(false);
  });

  it("a property required in only one branch becomes optional in the flat schema", () => {
    const schema = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("a"), aOnly: z.string() }),
      z.object({ kind: z.literal("b"), bOnly: z.string() }),
    ]);
    const result = zodToJsonSchema(schema);
    // Only `kind` is required in BOTH branches.
    expect(result.required).toEqual(["kind"]);
  });

  it("does not override an explicit root type", () => {
    const schema = z.object({ name: z.string() });
    const result = zodToJsonSchema(schema);
    expect(result.type).toBe("object");
    expect(result).not.toHaveProperty("oneOf");
    expect(result).not.toHaveProperty("anyOf");
  });
});
