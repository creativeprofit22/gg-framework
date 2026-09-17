import { expect, it } from "vitest";
import type { Tool } from "@kenkaiiii/gg-ai";
import { programmaticAssessmentResultV2Schema } from "../core/programmatic/contracts.js";
import { createProgrammaticAdvisoryResultTool } from "./programmatic-advisory-result.js";

it("preserves V2 validation hints through the existing Responses strict-mode fallback", async () => {
  const tool = createProgrammaticAdvisoryResultTool(() => undefined);
  expect(tool.parameters).toBe(programmaticAssessmentResultV2Schema);
  const serializerUrl = new URL(
    "../../../gg-ai/src/providers/openai-responses-core.ts",
    import.meta.url,
  ).href;
  const { serializeResponsesTools } = (await import(serializerUrl)) as {
    serializeResponsesTools: (tools: Tool[], options: { strict: boolean | null }) => unknown[];
  };
  const tools = serializeResponsesTools([tool], { strict: true });
  expect(tools).toHaveLength(1);
  // Nested choices use the provider's existing fallback; host Zod validation remains strict.
  expect(tools[0]).toMatchObject({
    type: "function", name: "programmatic_advisory_result", strict: null,
    parameters: {
      type: "object", additionalProperties: false,
      required: ["version", "kind", "recommendations", "coverage"],
      properties: {
        version: { const: 2 },
        recommendations: { type: "array", maxItems: 10, items: {
          type: "object",
          required: ["version", "kind", "outcome", "rationale", "uncertainty", "evidence", "workflow", "alternatives", "choice"],
          properties: {
            workflow: { type: "object", required: ["trigger", "representativeCase", "inputs", "currentProcess", "output", "successCheck", "affectedSubproject", "mutationBoundary", "repeatability"] },
            alternatives: { type: "array", maxItems: 4 },
            choice: { oneOf: expect.arrayContaining([
              ...["reuse-command", "extend-command", "missing-capability", "manual", "needs-more-evidence"].map((kind) => expect.objectContaining({ properties: expect.objectContaining({ kind: expect.objectContaining({ const: kind }) }) })),
            ]) },
          },
        } },
      },
    },
  });
  const patterns: string[] = [];
  let objectCount = 0;
  function visit(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (node.type === "object") {
      objectCount++;
      expect(node.additionalProperties).toBe(false);
      expect(node.properties).toBeDefined();
      for (const key of (node.required ?? []) as string[]) {
        expect(node.properties).toHaveProperty(key);
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "pattern" && typeof child === "string") patterns.push(child);
      visit(child);
    }
  }
  visit(tools);
  expect(objectCount).toBeGreaterThan(10);
  expect(patterns.length).toBeGreaterThan(0);
  for (const pattern of patterns) {
    expect(pattern).not.toMatch(/\(\?(?:[=!]|<[=!])/);
    expect(() => new RegExp(pattern, "u")).not.toThrow();
  }
});
