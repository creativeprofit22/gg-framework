import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ROADMAP_PHASE_DONE_WHEN_ITEM_MAX_LENGTH,
  ROADMAP_PHASE_DONE_WHEN_MAX_ITEMS,
  ROADMAP_PHASE_DRAFT_SUMMARY_MAX_LENGTH,
  ROADMAP_PHASE_GOAL_MAX_LENGTH,
  ROADMAP_PHASE_SOURCE_PROMPT_MAX_LENGTH,
  ROADMAP_PHASE_TITLE_MAX_LENGTH,
  ROADMAP_PROPOSED_PHASES_MAX_ITEMS,
  type RoadmapPhaseDraftRequest,
} from "@kenkaiiii/gg-core/roadmap-workflow";
import { RoadmapPhaseDraftParams, createRoadmapPhaseDraftTool } from "./roadmap-phase-draft.js";

const phase = {
  title: " Phase one ",
  goal: "\r\n Deliver the first slice. \r\n",
  doneWhen: [" Tests pass ", " Documentation is current "],
  sourcePrompt: " Add a first phase. ",
};

const input = {
  expected_revision: 4,
  summary: " A two-step delivery plan. ",
  phases: [phase],
};

describe("RoadmapPhaseDraftParams", () => {
  it("normalizes a strict flat draft using the shared request field shape", () => {
    expect(RoadmapPhaseDraftParams.parse(input)).toEqual({
      expected_revision: 4,
      summary: "A two-step delivery plan.",
      phases: [
        {
          title: "Phase one",
          goal: "Deliver the first slice.",
          doneWhen: ["Tests pass", "Documentation is current"],
          sourcePrompt: "Add a first phase.",
        },
      ],
    });

    expect(() => RoadmapPhaseDraftParams.parse({ ...input, nested: [] })).toThrow();
    expect(() =>
      RoadmapPhaseDraftParams.parse({
        ...input,
        phases: [{ ...phase, children: [] }],
      }),
    ).toThrow();
  });

  it("enforces all shared bounds and unique non-empty completion criteria", () => {
    const fieldCases = [
      ["summary", ROADMAP_PHASE_DRAFT_SUMMARY_MAX_LENGTH],
      ["title", ROADMAP_PHASE_TITLE_MAX_LENGTH],
      ["goal", ROADMAP_PHASE_GOAL_MAX_LENGTH],
      ["sourcePrompt", ROADMAP_PHASE_SOURCE_PROMPT_MAX_LENGTH],
    ] as const;

    for (const [field, maxLength] of fieldCases) {
      const candidate =
        field === "summary"
          ? { ...input, summary: "x".repeat(maxLength + 1) }
          : { ...input, phases: [{ ...phase, [field]: "x".repeat(maxLength + 1) }] };
      expect(() => RoadmapPhaseDraftParams.parse(candidate), field).toThrow();
    }

    expect(() =>
      RoadmapPhaseDraftParams.parse({
        ...input,
        phases: [
          {
            ...phase,
            doneWhen: ["x".repeat(ROADMAP_PHASE_DONE_WHEN_ITEM_MAX_LENGTH + 1)],
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      RoadmapPhaseDraftParams.parse({
        ...input,
        phases: [{ ...phase, doneWhen: Array(ROADMAP_PHASE_DONE_WHEN_MAX_ITEMS + 1).fill("x") }],
      }),
    ).toThrow();
    expect(() =>
      RoadmapPhaseDraftParams.parse({
        ...input,
        phases: Array(ROADMAP_PROPOSED_PHASES_MAX_ITEMS + 1).fill(phase),
      }),
    ).toThrow();
    expect(() =>
      RoadmapPhaseDraftParams.parse({
        ...input,
        phases: [{ ...phase, doneWhen: ["same", " same "] }],
      }),
    ).toThrow();
    expect(() => RoadmapPhaseDraftParams.parse({ ...input, summary: "  " })).toThrow();
  });

  it("normalizes reference proposals and validates phase links", () => {
    const candidate = {
      ...input,
      proposed_references: [
        {
          reference_key: " source ",
          provider: " GitHub ",
          canonical_url: "https://github.com/KenKaiiii/gg-framework",
          owner: "KenKaiiii",
          repo: "gg-framework",
          path: " packages/gg-core/src/roadmap-workflow.ts ",
          range: { start_line: 2, end_line: 4 },
          relevance: " shared contract ",
        },
      ],
      phases: [{ ...phase, reference_keys: [" source "] }],
    };
    expect(RoadmapPhaseDraftParams.parse(candidate)).toMatchObject({
      proposed_references: [{ reference_key: "source", provider: "github" }],
      phases: [{ reference_keys: ["source"] }],
    });
    expect(() =>
      RoadmapPhaseDraftParams.parse({
        ...candidate,
        phases: [{ ...phase, reference_keys: ["missing"] }],
      }),
    ).toThrow(/unknown reference link/);
  });
});

describe("createRoadmapPhaseDraftTool", () => {
  it("maps expected_revision to the shared request and delegates once", async () => {
    const draft = vi.fn(async (_request: RoadmapPhaseDraftRequest) => ({
      status: "proposal-pending" as const,
      draftId: "proposal-1",
    }));
    const tool = createRoadmapPhaseDraftTool(draft);
    const parsed = RoadmapPhaseDraftParams.parse(input);

    await expect(tool.execute(parsed, {} as never)).resolves.toBe(
      JSON.stringify({ status: "proposal-pending", draftId: "proposal-1" }),
    );
    expect(draft).toHaveBeenCalledWith({
      expectedRevision: 4,
      summary: "A two-step delivery plan.",
      phases: parsed.phases.map((item) => ({ ...item, referenceKeys: [] })),
      proposedReferences: [],
    });
    expect(draft).toHaveBeenCalledOnce();
    expect(tool.name).toBe("roadmap_phase_draft");
  });

  it("exports a bounded transform-free provider schema", () => {
    const tool = createRoadmapPhaseDraftTool(async () => ({ status: "inspection-required" }));
    const exportedSchema = (): Record<string, unknown> =>
      tool.rawInputSchema ?? (z.toJSONSchema(tool.parameters) as Record<string, unknown>);

    expect(exportedSchema).not.toThrow("Transforms cannot be represented in JSON Schema");
    expect(exportedSchema()).toMatchObject({
      type: "object",
      properties: {
        expected_revision: { type: "number", minimum: 0 },
        summary: { maxLength: ROADMAP_PHASE_DRAFT_SUMMARY_MAX_LENGTH },
        phases: {
          minItems: 1,
          maxItems: ROADMAP_PROPOSED_PHASES_MAX_ITEMS,
          items: {
            additionalProperties: false,
            properties: {
              title: { maxLength: ROADMAP_PHASE_TITLE_MAX_LENGTH },
              goal: { maxLength: ROADMAP_PHASE_GOAL_MAX_LENGTH },
              doneWhen: { maxItems: ROADMAP_PHASE_DONE_WHEN_MAX_ITEMS },
              sourcePrompt: { maxLength: ROADMAP_PHASE_SOURCE_PROMPT_MAX_LENGTH },
            },
          },
        },
        proposed_references: {
          maxItems: 20,
          items: {
            additionalProperties: false,
            properties: {
              reference_key: { maxLength: 128 },
              canonical_url: { maxLength: 2_048 },
              pull_request: { minimum: 1 },
            },
          },
        },
      },
      required: ["expected_revision", "summary", "phases"],
      additionalProperties: false,
    });
  });

  it("states the complete draft-only workflow boundary", () => {
    const description = createRoadmapPhaseDraftTool(async () => ({
      status: "inspection-required",
    })).description;

    expect(description).toContain("never write Project Notes or files");
    expect(description).toContain("flat peer phases");
    expect(description).toContain("pending user approval");
    expect(description).toContain("Use roadmap_status for execution progress");
    expect(description).toContain("Ordinary coding requests need no Roadmap action");
  });
});
