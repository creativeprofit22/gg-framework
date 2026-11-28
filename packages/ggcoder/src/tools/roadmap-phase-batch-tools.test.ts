import { describe, expect, it, vi } from "vitest";
import { ROADMAP_PHASE_BATCH_MAX_ITEMS } from "@kenkaiiii/gg-core/roadmap-workflow";
import {
  RoadmapPhaseEditParams,
  createRoadmapPhaseEditTool,
  type RoadmapPhaseEditToolRequest,
} from "./roadmap-phase-edit.js";
import {
  RoadmapPhaseMoveParams,
  createRoadmapPhaseMoveTool,
  type RoadmapPhaseMoveToolRequest,
} from "./roadmap-phase-move.js";

const pending = { status: "proposal-pending" as const, draftId: "proposal-1" };

describe("roadmap_phase_edit batch form", () => {
  const base = { expected_revision: 4, summary: " Tighten two phases " };

  it("maps edits to one batch request with only supplied fields", async () => {
    const edit = vi.fn(async (_request: RoadmapPhaseEditToolRequest) => pending);
    const tool = createRoadmapPhaseEditTool(edit);
    const parsed = tool.parameters.parse({
      ...base,
      edits: [
        { phase_id: " a ", title: " New A " },
        { phase_id: "b", doneWhen: [" Tests pass "], depends_on: [] },
      ],
    });
    await tool.execute(parsed, {} as never);
    expect(edit.mock.calls[0]?.[0]).toEqual({
      expectedRevision: 4,
      summary: "Tighten two phases",
      edits: [
        { phaseId: "a", title: "New A" },
        { phaseId: "b", doneWhen: ["Tests pass"], dependsOn: [] },
      ],
    });
  });

  it("requires exactly one form", () => {
    const edits = [{ phase_id: "a", title: "x" }];
    expect(() => RoadmapPhaseEditParams.parse({ ...base, phase_id: "a", edits })).toThrow(
      /either phase_id/,
    );
    expect(() => RoadmapPhaseEditParams.parse({ ...base, title: "x", edits })).toThrow(/not both/);
    expect(() => RoadmapPhaseEditParams.parse({ ...base, title: "x" })).toThrow(/phase_id/);
    expect(() => RoadmapPhaseEditParams.parse({ ...base, edits: [] })).toThrow();
  });

  it("validates each entry with the single-edit rules", () => {
    expect(() =>
      RoadmapPhaseEditParams.parse({
        ...base,
        edits: [
          { phase_id: "a", title: "x" },
          { phase_id: "a", goal: "y" },
        ],
      }),
    ).toThrow(/edits\[1\]\.phaseId/);
    expect(() => RoadmapPhaseEditParams.parse({ ...base, edits: [{ phase_id: "a" }] })).toThrow(
      /at least one/,
    );
    expect(() =>
      RoadmapPhaseEditParams.parse({ ...base, edits: [{ phase_id: "a", depends_on: ["a"] }] }),
    ).toThrow(/itself/);
    expect(() =>
      RoadmapPhaseEditParams.parse({
        ...base,
        edits: [{ phase_id: "a", title: "x", summary: "nested" }],
      }),
    ).toThrow();
    expect(() =>
      RoadmapPhaseEditParams.parse({
        ...base,
        edits: Array.from({ length: ROADMAP_PHASE_BATCH_MAX_ITEMS + 1 }, (_, index) => ({
          phase_id: `p${index}`,
          title: "x",
        })),
      }),
    ).toThrow();
  });

  it("documents the batch form and its roadmap-scope inspection", () => {
    const { description } = createRoadmapPhaseEditTool(vi.fn());
    expect(description).toContain("send one proposal with edits");
    expect(description).toContain('scope "roadmap"');
    expect(description).toContain("approves or rejects it as a whole");
  });
});

describe("roadmap_phase_move batch form", () => {
  const base = { expected_revision: 4, summary: "Reorder" };

  it("maps moves to one batch request in listed order", async () => {
    const move = vi.fn(async (_request: RoadmapPhaseMoveToolRequest) => pending);
    const tool = createRoadmapPhaseMoveTool(move);
    await tool.execute(
      tool.parameters.parse({
        ...base,
        moves: [
          { phase_id: " d ", before_phase_id: "a" },
          { phase_id: "c", after_phase_id: "d" },
        ],
      }),
      {} as never,
    );
    expect(move.mock.calls[0]?.[0]).toEqual({
      expectedRevision: 4,
      summary: "Reorder",
      moves: [
        { phaseId: "d", beforePhaseId: "a" },
        { phaseId: "c", afterPhaseId: "d" },
      ],
    });
  });

  it("keeps the single form unchanged", async () => {
    const move = vi.fn(async (_request: RoadmapPhaseMoveToolRequest) => pending);
    const tool = createRoadmapPhaseMoveTool(move);
    await tool.execute(
      tool.parameters.parse({ ...base, phase_id: "c", before_phase_id: "a" }),
      {} as never,
    );
    expect(move.mock.calls[0]?.[0]).toEqual({
      expectedRevision: 4,
      summary: "Reorder",
      phaseId: "c",
      beforePhaseId: "a",
    });
  });

  it("requires exactly one form and valid steps", () => {
    const moves = [{ phase_id: "d", before_phase_id: "a" }];
    expect(() => RoadmapPhaseMoveParams.parse({ ...base, phase_id: "c", moves })).toThrow(
      /not both/,
    );
    expect(() => RoadmapPhaseMoveParams.parse({ ...base, after_phase_id: "c", moves })).toThrow(
      /not both/,
    );
    expect(() => RoadmapPhaseMoveParams.parse(base)).toThrow(/phase_id/);
    expect(() => RoadmapPhaseMoveParams.parse({ ...base, moves: [{ phase_id: "d" }] })).toThrow(
      /exactly one/,
    );
    expect(() =>
      RoadmapPhaseMoveParams.parse({
        ...base,
        moves: [
          { phase_id: "d", before_phase_id: "a" },
          { phase_id: "d", after_phase_id: "b" },
        ],
      }),
    ).toThrow(/at most once/);
  });

  it("exports the moves schema and documents the step order", () => {
    const tool = createRoadmapPhaseMoveTool(vi.fn());
    expect(tool.rawInputSchema).toMatchObject({
      required: ["expected_revision", "summary"],
      properties: {
        moves: {
          type: "array",
          maxItems: ROADMAP_PHASE_BATCH_MAX_ITEMS,
          items: { required: ["phase_id"], additionalProperties: false },
        },
      },
    });
    expect(tool.description).toContain("each relative to the order left by the previous step");
  });
});
