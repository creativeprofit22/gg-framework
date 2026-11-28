import { describe, expect, it } from "vitest";
import { normalizeMcpArguments } from "./normalize-arguments.js";

describe("normalizeMcpArguments", () => {
  it.each([
    { anyOf: [{ type: "string" }, { type: "integer" }] },
    { anyOf: [{ type: ["string", "boolean"] }, { type: "number" }] },
    { anyOf: [{ enum: ["all", 1, false] }, { const: "none" }] },
    { anyOf: [{ anyOf: [{ type: "string" }, { const: 0 }] }, { type: "boolean" }] },
    { enum: ["all", 1, false] },
    { const: "none" },
  ])("undoes converter-added nulls only for optional proven primitives: %j", async (property) => {
    // Exercise current converter source without expanding this package's rootDir.
    const converterUrl = new URL(
      "../../../../gg-ai/src/utils/strict-tool-schema.ts",
      import.meta.url,
    ).href;
    const { makeStrictToolSchema } = (await import(converterUrl)) as {
      makeStrictToolSchema: (schema: Record<string, unknown>) => Record<string, unknown>;
    };
    const schema = {
      type: "object",
      properties: { filter: property, required: property },
      required: ["required"],
    };
    const original = structuredClone(schema);
    expect(makeStrictToolSchema(schema)).toMatchObject({
      properties: { filter: { anyOf: [property, { type: "null" }] } },
      required: ["filter", "required"],
    });
    const args = { filter: null, required: null };
    expect(normalizeMcpArguments(args, schema)).toEqual({ required: null });
    expect(args).toEqual({ filter: null, required: null });
    expect(schema).toEqual(original);
    expect(normalizeMcpArguments({ filter: 0 }, schema)).toEqual({ filter: 0 });
  });

  it.each([
    { type: "null" },
    { type: ["integer", "null"] },
    { enum: ["all", null] },
    { const: null },
    {},
    true,
    { type: "unknown" },
    { type: "string", unknownConstraint: true },
    { type: "string", properties: {} },
    { $recursiveRef: "#value", type: "string" },
    { $ref: "#/$defs/value", type: "string" },
    { $dynamicRef: "#value", type: "string" },
    { if: {}, then: { type: "string" } },
    { allOf: [{ type: "string" }] },
    { type: "object" },
    { type: "array", items: { type: "string" } },
    { properties: { path: { type: "string" } } },
    { enum: [{ path: "value" }] },
    { const: [1] },
    { enum: [] },
    { anyOf: [] },
    { anyOf: "invalid" },
  ])("retains null when a union branch is nullable or unproven: %j", (branch) => {
    const args = { filter: null };
    expect(
      normalizeMcpArguments(args, {
        type: "object",
        properties: { filter: { anyOf: [{ type: "string" }, branch] } },
      }),
    ).toEqual(args);
  });
  it("bounds nested union analysis", () => {
    let property: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 64; i++) property = { anyOf: [property] };
    expect(
      normalizeMcpArguments(
        { filter: null },
        {
          type: "object",
          properties: { filter: property },
        },
      ),
    ).toEqual({ filter: null });
  });

  it("preserves primitive-union array slots and handles declared special keys", () => {
    const property = { anyOf: [{ type: "string" }, { type: "integer" }] };
    const args = JSON.parse('{"__proto__":null,"constructor":null,"entries":[null,1]}');
    const schema = {
      type: "object",
      properties: Object.fromEntries([
        ["__proto__", property],
        ["constructor", property],
        ["entries", { type: "array", items: property }],
      ]),
    };
    const result = normalizeMcpArguments(args, schema);
    expect(result).toEqual({ entries: [null, 1] });
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(args).toEqual(JSON.parse('{"__proto__":null,"constructor":null,"entries":[null,1]}'));
  });

  it("preserves required, nullable, unknown and unconstrained nulls and concrete values", () => {
    const schema = {
      type: "object",
      properties: {
        required: { type: "string" },
        nullable: { type: ["string", "null"] },
        union: { anyOf: [{ type: "string" }, { type: "null" }] },
        unconstrained: {},
        optional: { type: "string" },
        zero: { type: "integer" },
        empty: { type: "string" },
        disabled: { type: "boolean" },
      },
      required: ["required"],
    };
    const args = {
      required: null,
      nullable: null,
      union: null,
      unconstrained: null,
      unknown: null,
      optional: null,
      zero: 0,
      empty: "",
      disabled: false,
    };
    const original = structuredClone(args);
    const originalSchema = structuredClone(schema);
    const { optional: _optional, ...expected } = args;
    expect(normalizeMcpArguments(args, schema)).toEqual(expected);
    expect(args).toEqual(original);
    expect(schema).toEqual(originalSchema);
  });

  it("normalizes nested objects and array objects without dropping array slots", () => {
    const child = { type: "object", properties: { path: { type: "string" } } };
    const schema = {
      type: "object",
      properties: { nested: child, entries: { type: "array", items: child } },
    };
    expect(
      normalizeMcpArguments({ nested: { path: null }, entries: [null, { path: null }] }, schema),
    ).toEqual({ nested: {}, entries: [null, {}] });
  });

  it.each([
    { $ref: "#/$defs/requiredFields" },
    { allOf: [{ required: ["path"] }] },
    { anyOf: [{ required: ["path"] }, { required: ["other"] }] },
    { oneOf: [{ required: ["path"] }] },
    { if: { required: ["other"] }, then: { required: ["path"] } },
    { dependentRequired: { other: ["path"] } },
    { patternProperties: { path: { type: "null" } } },
    { required: "path" },
  ])("leaves ambiguous object constraints untouched: %j", (constraints) => {
    const args = { path: null, other: "present" };
    expect(
      normalizeMcpArguments(args, {
        type: "object",
        properties: { path: { type: "string" } },
        ...constraints,
      }),
    ).toEqual(args);
  });

  it("preserves referenced properties and tuple items", () => {
    const args = { reference: null, tuple: [{ path: null }] };
    expect(
      normalizeMcpArguments(args, {
        type: "object",
        properties: {
          reference: { $ref: "#/$defs/nullable", type: "string" },
          tuple: {
            type: "array",
            items: [{ type: "object", properties: { path: { type: "string" } } }],
          },
        },
      }),
    ).toEqual(args);
  });

  it("preserves special JSON keys without changing prototypes", () => {
    const args = JSON.parse('{"__proto__":{"polluted":true},"constructor":null,"path":null}');
    const result = normalizeMcpArguments(args, {
      type: "object",
      properties: { path: { type: "string" } },
    });
    expect(result).toEqual(JSON.parse('{"__proto__":{"polluted":true},"constructor":null}'));
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });
});
