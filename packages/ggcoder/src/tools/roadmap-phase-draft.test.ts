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

// Sanitized production OpenAI payload from the native run on 2026-09-10.
const capturedReference = {
  reference_key: "typescript-source",
  provider: "github",
  tool: null,
  canonical_url: "https://github.com/microsoft/TypeScript",
  owner: "microsoft",
  repo: "TypeScript",
  revision: null,
  path: null,
  range: null,
  issue: null,
  pull_request: null,
  query: null,
  anchor: null,
  relevance: "Public source identity used only to verify reference preservation",
};
const capturedPayload = {
  expected_revision: 1,
  summary: "Native recovery verification 20260910",
  phases: ["Recovery alpha", "Recovery beta"].map((title) => ({
    title,
    goal: "Verify explicit approval on a disposable project",
    doneWhen: ["Native approval creates this phase exactly once"],
    sourcePrompt: "Synthetic verification only; do not implement",
    reference_keys: ["typescript-source"],
  })),
  proposed_references: [capturedReference],
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

  it("treats omitted optional reference fields identically to explicit nulls", () => {
    const omitted = {
      ...capturedPayload,
      proposed_references: [
        {
          reference_key: "typescript-source",
          provider: "github",
          canonical_url: "https://github.com/microsoft/TypeScript",
          owner: "microsoft",
          repo: "TypeScript",
          relevance: "Public source identity used only to verify reference preservation",
        },
      ],
    };
    expect(RoadmapPhaseDraftParams.parse(omitted)).toEqual(capturedPayload);
  });

  it.each([
    ["tool", " search ", "search"],
    ["revision", " main ", "main"],
    ["path", " README.md ", "README.md"],
    ["query", " TypeScript ", "TypeScript"],
    ["anchor", " overview ", "overview"],
    ["range", { start_line: 2, end_line: 4 }, { start_line: 2, end_line: 4 }],
    ["issue", 1, 1],
    ["pull_request", 2, 2],
  ] as const)("preserves a valid optional reference %s", (field, value, expected) => {
    const parsed = RoadmapPhaseDraftParams.parse({
      ...capturedPayload,
      proposed_references: [{ ...capturedReference, path: "README.md", [field]: value }],
    });
    expect(parsed.proposed_references).toEqual([
      { ...capturedReference, path: "README.md", [field]: expected },
    ]);
  });

  it.each(["tool", "revision", "path", "query", "anchor"])(
    "rejects malformed non-null optional reference %s values",
    (field) => {
      for (const value of ["", "   ", "x".repeat(4_097), 1, false, {}, []]) {
        const result = RoadmapPhaseDraftParams.safeParse({
          ...capturedPayload,
          proposed_references: [{ ...capturedReference, [field]: value }],
        });
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ path: ["proposed_references", 0, field] }),
            ]),
          );
        }
      }
    },
  );

  it.each([
    ["range", { start_line: 4, end_line: 2 }],
    ["range", "2-4"],
    ["issue", 0],
    ["issue", "1"],
    ["pull_request", -1],
    ["pull_request", 1.5],
  ] as const)("still rejects malformed optional reference %s coordinates", (field, value) => {
    expect(
      RoadmapPhaseDraftParams.safeParse({
        ...capturedPayload,
        proposed_references: [{ ...capturedReference, [field]: value }],
      }).success,
    ).toBe(false);
  });

  it.each(["reference_key", "provider", "canonical_url", "owner", "repo", "relevance"])(
    "does not treat required reference %s as optional",
    (field) => {
      expect(
        RoadmapPhaseDraftParams.safeParse({
          ...capturedPayload,
          proposed_references: [{ ...capturedReference, [field]: null }],
        }).success,
      ).toBe(false);
    },
  );

  it("does not relax null handling outside optional reference coordinates", () => {
    expect(RoadmapPhaseDraftParams.safeParse({ ...capturedPayload, summary: null }).success).toBe(
      false,
    );
    expect(
      RoadmapPhaseDraftParams.safeParse({ ...capturedPayload, proposed_references: null }).success,
    ).toBe(false);
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
  it("validates the captured provider null fields and forwards the normalized reference", async () => {
    const draft = vi.fn(async (_request: RoadmapPhaseDraftRequest) => ({
      status: "proposal-pending" as const,
      draftId: "proposal-1",
    }));
    const tool = createRoadmapPhaseDraftTool(draft);
    // Use the production validation boundary, without stripping provider nulls.
    const parsed = tool.parameters.parse(capturedPayload);
    expect(parsed).toEqual(capturedPayload);
    await tool.execute(parsed, {} as never);
    expect(draft).toHaveBeenCalledOnce();
    expect(draft.mock.calls[0]![0].proposedReferences).toEqual([
      {
        referenceKey: "typescript-source",
        provider: "github",
        tool: null,
        canonicalUrl: "https://github.com/microsoft/TypeScript",
        owner: "microsoft",
        repo: "TypeScript",
        revision: null,
        path: null,
        range: null,
        issue: null,
        pullRequest: null,
        query: null,
        anchor: null,
        relevance: "Public source identity used only to verify reference preservation",
      },
    ]);
  });

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
