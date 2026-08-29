import { describe, expect, it, vi } from "vitest";
import {
  RoadmapStatusParams,
  createRoadmapStatusTool,
  type RoadmapStatusToolContext,
  type RoadmapStatusToolResult,
} from "./roadmap-status.js";

const base = {
  update_id: " update-1 ",
  phase_id: " phase-1 ",
  expected_revision: 1,
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
      verification: null,
      proposed_references: [],
    });
  });

  it("requires separate reason and external action only for blocked reports", () => {
    expect(() => RoadmapStatusParams.parse({ ...base, transition: "blocked" })).toThrow();
    expect(
      RoadmapStatusParams.parse({
        ...base,
        transition: "blocked",
        blocker: " Access is unavailable. ",
        required_external_action: " Grant this session repository access. ",
      }),
    ).toMatchObject({
      blocker: "Access is unavailable.",
      required_external_action: "Grant this session repository access.",
    });
    expect(() =>
      RoadmapStatusParams.parse({ ...base, transition: "in-progress", blocker: "not allowed" }),
    ).toThrow();
  });

  it("requires passed verification and evidence for Done", () => {
    expect(() => RoadmapStatusParams.parse({ ...base, transition: "done" })).toThrow();
    expect(
      RoadmapStatusParams.parse({
        ...base,
        transition: "done",
        evidence: [" pnpm test exited successfully "],
        verification: { result: "passed" },
      }),
    ).toMatchObject({
      transition: "done",
      evidence: ["pnpm test exited successfully"],
      verification: { result: "passed" },
    });
    expect(() =>
      RoadmapStatusParams.parse({
        ...base,
        transition: "done",
        evidence: ["pnpm test failed"],
        verification: { result: "failed", reason: "Tests failed" },
      }),
    ).toThrow();
  });

  it("normalizes optional reference coordinates", () => {
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
    expect(parsed.proposed_references[0]).toMatchObject({
      provider: "github",
      canonical_url: "https://github.com/owner/repo",
      owner: "owner",
      repo: "repo",
      relevance: "Repository implementation",
    });
  });
});

describe("createRoadmapStatusTool", () => {
  it("attributes coding ownership and returns compact JSON", async () => {
    const record = vi.fn(
      async ({ input }: RoadmapStatusToolContext): Promise<RoadmapStatusToolResult> => ({
        result: "phase-not-bound",
        phaseId: input.phase_id,
      }),
    );
    const tool = createRoadmapStatusTool("gg-coder", record);
    const input = RoadmapStatusParams.parse({ ...base, transition: "pending" });

    await expect(tool.execute(input, {} as never)).resolves.toBe(
      JSON.stringify({ result: "phase-not-bound", phaseId: "phase-1" }),
    );
    expect(record).toHaveBeenCalledWith({ actor: "gg-coder", input });
    expect(tool.description).toContain("completion waits for owning run settlement");
  });
});
