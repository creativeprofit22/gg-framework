import { describe, expect, it } from "vitest";
import { makeStrictToolSchema } from "./strict-tool-schema.js";

// Inputs are hand-written JSON Schemas shaped like `resolveToolSchema` output.
// Expected values follow the provider "structured outputs" rules: every key in
// `properties` must appear in `required`, objects must set
// `additionalProperties: false`, and optional properties become nullable
// unions so the model can emit `null` instead of omitting the key.

describe("makeStrictToolSchema", () => {
  it("makes every property required and forbids additional properties", () => {
    const strict = makeStrictToolSchema({
      type: "object",
      properties: {
        file_path: { type: "string" },
        content: { type: "string" },
      },
      required: ["file_path"],
    });
    expect(strict).toEqual({
      type: "object",
      properties: {
        file_path: { type: "string" },
        content: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      required: ["file_path", "content"],
      additionalProperties: false,
    });
  });

  it("keeps already-nullable properties unwrapped", () => {
    const nullable = { anyOf: [{ type: "number" }, { type: "null" }] };
    const strict = makeStrictToolSchema({
      type: "object",
      properties: { limit: nullable },
    });
    expect(strict.properties).toEqual({ limit: nullable });
  });

  it("strictifies nested objects and array items recursively", () => {
    const strict = makeStrictToolSchema({
      type: "object",
      properties: {
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              old_text: { type: "string" },
              anchor: { type: "string" },
            },
            required: ["old_text"],
          },
        },
      },
      required: ["edits"],
    });
    const items = (strict.properties as Record<string, any>).edits.items;
    expect(items.required).toEqual(["old_text", "anchor"]);
    expect(items.additionalProperties).toBe(false);
    expect(items.properties.anchor).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    });
  });

  it("does not mutate the input schema", () => {
    const input = {
      type: "object",
      properties: { offset: { type: "number" } },
    };
    const snapshot = structuredClone(input);
    makeStrictToolSchema(input);
    expect(input).toEqual(snapshot);
  });

  it("rejects schemas using unsupported keys, per node", () => {
    expect(() =>
      makeStrictToolSchema({
        type: "object",
        properties: { a: { $ref: "#/$defs/a" } },
      }),
    ).toThrow(/unsupported/i);
    expect(() =>
      makeStrictToolSchema({
        type: "object",
        properties: { mode: { oneOf: [{ type: "string" }, { type: "number" }] } },
      }),
    ).toThrow(/unsupported/i);
  });

  it("rejects non-object roots", () => {
    expect(() => makeStrictToolSchema({ type: "string" })).toThrow(/object/i);
  });
});
