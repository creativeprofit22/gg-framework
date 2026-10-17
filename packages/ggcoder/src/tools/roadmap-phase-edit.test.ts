import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ROADMAP_PHASE_DONE_WHEN_ITEM_MAX_LENGTH,
  ROADMAP_PHASE_DONE_WHEN_MAX_ITEMS,
  ROADMAP_PHASE_DRAFT_SUMMARY_MAX_LENGTH,
  ROADMAP_PHASE_GOAL_MAX_LENGTH,
  ROADMAP_PHASE_SOURCE_PROMPT_MAX_LENGTH,
  ROADMAP_PHASE_TITLE_MAX_LENGTH,
  type RoadmapPhaseEditRequest,
} from "@kenkaiiii/gg-core/roadmap-workflow";
import { RoadmapPhaseEditParams, createRoadmapPhaseEditTool } from "./roadmap-phase-edit.js";

const input = {
  expected_revision: 4,
  phase_id: " phase-1 ",
  summary: " Tighten the first phase. ",
  goal: "\r\n Deliver a narrower slice. \r\n",
};

function pendingEdit() {
  return vi.fn(async (_request: RoadmapPhaseEditRequest) => ({
    status: "proposal-pending" as const,
    draftId: "proposal-1",
  }));
}

describe("RoadmapPhaseEditParams", () => {
  it("normalizes a strict single-phase edit", () => {
    expect(RoadmapPhaseEditParams.parse(input)).toEqual({
      expected_revision: 4,
      phase_id: "phase-1",
      summary: "Tighten the first phase.",
      goal: "Deliver a narrower slice.",
    });
    expect(() => RoadmapPhaseEditParams.parse({ ...input, status: "done" })).toThrow();
    expect(() => RoadmapPhaseEditParams.parse({ ...input, phases: [] })).toThrow();
  });

  it("requires at least one editable field", () => {
    const { goal: _goal, ...withoutFields } = input;
    expect(() => RoadmapPhaseEditParams.parse(withoutFields)).toThrow(/at least one/);
  });

  it("enforces the same bounds as add drafts", () => {
    const fieldCases = [
      ["summary", ROADMAP_PHASE_DRAFT_SUMMARY_MAX_LENGTH],
      ["title", ROADMAP_PHASE_TITLE_MAX_LENGTH],
      ["goal", ROADMAP_PHASE_GOAL_MAX_LENGTH],
      ["sourcePrompt", ROADMAP_PHASE_SOURCE_PROMPT_MAX_LENGTH],
    ] as const;
    for (const [field, maxLength] of fieldCases) {
      expect(
        () => RoadmapPhaseEditParams.parse({ ...input, [field]: "x".repeat(maxLength + 1) }),
        field,
      ).toThrow();
      expect(() => RoadmapPhaseEditParams.parse({ ...input, [field]: "  " }), field).toThrow();
    }
    expect(() =>
      RoadmapPhaseEditParams.parse({
        ...input,
        doneWhen: ["x".repeat(ROADMAP_PHASE_DONE_WHEN_ITEM_MAX_LENGTH + 1)],
      }),
    ).toThrow();
    expect(() =>
      RoadmapPhaseEditParams.parse({
        ...input,
        doneWhen: Array.from({ length: ROADMAP_PHASE_DONE_WHEN_MAX_ITEMS + 1 }, (_, i) => `c${i}`),
      }),
    ).toThrow();
    expect(() => RoadmapPhaseEditParams.parse({ ...input, doneWhen: [] })).toThrow();
    expect(() =>
      RoadmapPhaseEditParams.parse({ ...input, doneWhen: ["same", " same "] }),
    ).toThrow();
    expect(() => RoadmapPhaseEditParams.parse({ ...input, phase_id: " " })).toThrow();
    expect(() => RoadmapPhaseEditParams.parse({ ...input, expected_revision: -1 })).toThrow();
    expect(() => RoadmapPhaseEditParams.parse({ ...input, expected_revision: 1.5 })).toThrow();
    expect(() => RoadmapPhaseEditParams.parse({ ...input, title: null })).toThrow();
  });
});

describe("createRoadmapPhaseEditTool", () => {
  it("maps snake_case input to the shared request with only supplied fields", async () => {
    const edit = pendingEdit();
    const tool = createRoadmapPhaseEditTool(edit);
    const parsed = tool.parameters.parse({
      ...input,
      doneWhen: [" Tests pass ", "Docs updated"],
    });

    await expect(tool.execute(parsed, {} as never)).resolves.toBe(
      JSON.stringify({ status: "proposal-pending", draftId: "proposal-1" }),
    );
    expect(edit).toHaveBeenCalledOnce();
    expect(edit.mock.calls[0]?.[0]).toEqual({
      expectedRevision: 4,
      summary: "Tighten the first phase.",
      phaseId: "phase-1",
      goal: "Deliver a narrower slice.",
      doneWhen: ["Tests pass", "Docs updated"],
    });
    expect(tool.name).toBe("roadmap_phase_edit");
  });

  it("exports a bounded transform-free provider schema", () => {
    const tool = createRoadmapPhaseEditTool(pendingEdit());
    const exportedSchema = (): Record<string, unknown> =>
      tool.rawInputSchema ?? (z.toJSONSchema(tool.parameters) as Record<string, unknown>);

    expect(exportedSchema).not.toThrow();
    expect(exportedSchema()).toMatchObject({
      type: "object",
      properties: {
        expected_revision: { type: "number", minimum: 0 },
        phase_id: { minLength: 1 },
        summary: { maxLength: ROADMAP_PHASE_DRAFT_SUMMARY_MAX_LENGTH },
        title: { maxLength: ROADMAP_PHASE_TITLE_MAX_LENGTH },
        goal: { maxLength: ROADMAP_PHASE_GOAL_MAX_LENGTH },
        doneWhen: { minItems: 1, maxItems: ROADMAP_PHASE_DONE_WHEN_MAX_ITEMS },
        sourcePrompt: { maxLength: ROADMAP_PHASE_SOURCE_PROMPT_MAX_LENGTH },
      },
      required: ["expected_revision", "phase_id", "summary"],
      additionalProperties: false,
    });
  });

  it("states the proposal-only approval boundary", () => {
    const { description } = createRoadmapPhaseEditTool(pendingEdit());
    expect(description).toContain("never write Project Notes or files");
    expect(description).toContain("Call roadmap_inspect immediately first");
    expect(description).toContain("Include only the fields that change");
    expect(description).toContain("Done, archived, and deleted phases cannot be edited");
    expect(description).toContain("Never delete and redraft");
    expect(description).toContain("Never loosen completion criteria");
    expect(description).toContain("pending user approval");
  });
});
