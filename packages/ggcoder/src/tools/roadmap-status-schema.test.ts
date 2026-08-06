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
      required: ["update_id", "phase_id", "progress", "transition"],
    });
    expect(
      (exportedSchema().properties as Record<string, { description?: string }>).blocker
        ?.description,
    ).toContain("Do not report recoverable or transient tool failures as blockers");

    expect(
      tool.parameters.parse({
        update_id: " update-1 ",
        phase_id: " phase-1 ",
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
});
