import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createRoadmapStatusTool } from "./roadmap-status.js";

describe("roadmap_status provider schema", () => {
  it("exports a transform-free raw input schema while preserving runtime normalization", () => {
    const tool = createRoadmapStatusTool("gg-coder", async () => ({
      result: "committed",
      phaseId: "phase-1",
      revision: 1,
      statusOutcome: "evidence-only",
      phaseTransitionOutcome: "evidence-only",
      proposals: [],
    }));

    const exportedSchema = (): Record<string, unknown> =>
      tool.rawInputSchema ?? (z.toJSONSchema(tool.parameters) as Record<string, unknown>);

    expect(exportedSchema).not.toThrow("Transforms cannot be represented in JSON Schema");
    expect(exportedSchema()).toMatchObject({
      type: "object",
      properties: {
        transition: { enum: ["pending", "in-progress", "blocked", "done"] },
        verification_bindings: {
          type: "array",
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              criterion_id: { type: "string", pattern: "^[a-f0-9]{64}$" },
              execution_id: { type: "string", minLength: 1, maxLength: 128 },
            },
            required: ["criterion_id", "execution_id"],
            additionalProperties: false,
          },
        },
        blocker: {
          type: "string",
          description: expect.stringContaining("concrete reason work cannot continue"),
        },
        required_external_action: {
          type: "string",
          description: expect.stringContaining(
            "exact decision or action required from a person or external actor",
          ),
        },
      },
      required: ["update_id", "phase_id", "expected_revision", "progress", "transition"],
    });
    expect(
      (exportedSchema().properties as Record<string, { description?: string }>).blocker
        ?.description,
    ).toContain("Do not report recoverable or transient tool failures as blockers");

    expect(
      tool.parameters.parse({
        update_id: " update-1 ",
        phase_id: " phase-1 ",
        expected_revision: 1,
        progress: "\r\n Done \r\n",
        transition: "in-progress",
      }),
    ).toMatchObject({
      update_id: "update-1",
      phase_id: "phase-1",
      progress: "Done",
      evidence: [],
      verification: null,
      proposed_references: [],
    });
  });

  it("requires expected_revision before accepting any state-mutating update", () => {
    const tool = createRoadmapStatusTool("gg-coder", async () => ({
      result: "committed",
      phaseId: "phase-1",
      revision: 1,
      statusOutcome: "evidence-only",
      phaseTransitionOutcome: "evidence-only",
      proposals: [],
    }));

    expect(
      tool.parameters.safeParse({
        update_id: "update-1",
        phase_id: "phase-1",
        progress: "Done",
        transition: "in-progress",
      }).success,
    ).toBe(false);
  });

  it("accepts Done with a passed report without execution bindings", () => {
    const tool = createRoadmapStatusTool("gg-coder", async () => ({
      result: "committed",
      phaseId: "phase-1",
      revision: 2,
      statusOutcome: "completion-pending",
      phaseTransitionOutcome: "completion-pending",
      completionIntentId: "completion-intent-1",
      proposals: [],
    }));
    const doneInput = {
      update_id: "completion-intent-1",
      phase_id: "phase-1",
      expected_revision: 1,
      progress: "Completed and verified.",
      transition: "done" as const,
      evidence: ["pnpm test exited successfully"],
      verification: { result: "passed" as const },
    };

    expect(
      tool.parameters.safeParse({
        ...doneInput,
        verification_bindings: [{ criterion_id: "a".repeat(64), execution_id: "execution-1" }],
      }).success,
    ).toBe(true);
    expect(tool.parameters.safeParse(doneInput).success).toBe(true);
    expect(tool.parameters.safeParse({ ...doneInput, evidence: [] }).success).toBe(false);
    expect(
      tool.parameters.safeParse({
        ...doneInput,
        verification_bindings: [{ criterion_id: "a".repeat(64), execution_id: "execution-1" }],
        verification: { result: "failed", reason: "Tests failed" },
      }).success,
    ).toBe(false);
  });
});
