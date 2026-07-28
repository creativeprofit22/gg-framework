import { describe, expect, it, vi } from "vitest";
import { RoadmapStatusParams, createRoadmapStatusTool } from "./roadmap-status.js";

const base = {
  update_id: " update-1 ",
  phase_id: " phase-1 ",
  progress: "  Implemented the repository seam.  ",
};

describe("RoadmapStatusParams", () => {
  it.each(["pending", "in-progress"] as const)("accepts and normalizes %s", (transition) => {
    expect(RoadmapStatusParams.parse({ ...base, transition })).toMatchObject({
      update_id: "update-1",
      phase_id: "phase-1",
      transition,
      progress: "Implemented the repository seam.",
      evidence: [],
      proposed_references: [],
    });
  });

  it("requires a blocker only for blocked reports", () => {
    expect(() => RoadmapStatusParams.parse({ ...base, transition: "blocked" })).toThrow();
    expect(
      RoadmapStatusParams.parse({ ...base, transition: "blocked", blocker: " Waiting on CI " }),
    ).toMatchObject({ blocker: "Waiting on CI" });
    expect(() =>
      RoadmapStatusParams.parse({ ...base, transition: "pending", blocker: "not allowed" }),
    ).toThrow();
  });

  it("requires evidence for review and has no Done transition", () => {
    expect(() => RoadmapStatusParams.parse({ ...base, transition: "review" })).toThrow();
    expect(
      RoadmapStatusParams.parse({
        ...base,
        transition: "review",
        evidence: [" pnpm test passed "],
      }).evidence,
    ).toEqual(["pnpm test passed"]);
    expect(() => RoadmapStatusParams.parse({ ...base, transition: "done" })).toThrow();
  });

  it("normalizes optional reference coordinates to null", () => {
    const parsed = RoadmapStatusParams.parse({
      ...base,
      transition: "in-progress",
      proposed_references: [
        {
          provider: " GitHub ",
          canonical_url: " https://github.com/owner/repo ",
          owner: " owner ",
          repo: " repo ",
          relevance: " Repository implementation ",
        },
      ],
    });
    expect(parsed.proposed_references[0]).toEqual({
      provider: "github",
      tool: null,
      canonical_url: "https://github.com/owner/repo",
      owner: "owner",
      repo: "repo",
      revision: null,
      path: null,
      range: null,
      issue: null,
      pull_request: null,
      query: null,
      anchor: null,
      relevance: "Repository implementation",
    });
  });

  it("rejects malformed reference coordinates atomically", () => {
    expect(() =>
      RoadmapStatusParams.parse({
        ...base,
        transition: "in-progress",
        proposed_references: [
          {
            provider: "github",
            canonical_url: "https://github.com/owner/repo/issues/1",
            owner: "owner",
            repo: "repo",
            range: { start_line: 10, end_line: 2 },
            issue: 1,
            pull_request: 2,
            relevance: "bad",
          },
        ],
      }),
    ).toThrow();
  });
});

describe("createRoadmapStatusTool", () => {
  it("attributes the actor and returns compact JSON", async () => {
    const record = vi.fn(async ({ actor, input }) => ({
      result: "committed",
      phaseId: input.phase_id,
      actor,
    }));
    const tool = createRoadmapStatusTool("ken", record);
    const input = RoadmapStatusParams.parse({ ...base, transition: "pending" });

    await expect(tool.execute(input, {} as never)).resolves.toBe(
      JSON.stringify({ result: "committed", phaseId: "phase-1", actor: "ken" }),
    );
    expect(record).toHaveBeenCalledWith({ actor: "ken", input });
    expect(tool.name).toBe("roadmap_status");
  });
});
