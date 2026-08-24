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
        transition: { enum: ["pending", "in-progress", "blocked", "review"] },
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
      final_review: null,
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

  it("rejects final_review outside a review transition", () => {
    const tool = createRoadmapStatusTool("ken-autopilot", async () => ({
      result: "completion-review-committed",
      phaseId: "phase-1",
      revision: 2,
      statusOutcome: "evidence-only",
      proposals: [],
      gateOutcome: "done",
      unmetGateCodes: [],
    }));

    const result = tool.parameters.safeParse({
      update_id: "review-1",
      phase_id: "phase-1",
      expected_revision: 1,
      progress: "Reviewed the phase.",
      transition: "in-progress",
      evidence: ["Inspected implementation evidence"],
      final_review: {
        review_id: "final-review-1",
        decision: "accepted",
        evidence: ["Inspected implementation evidence"],
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["final_review"],
            message: "final_review requires transition=review",
          }),
        ]),
      );
    }
  });
});
