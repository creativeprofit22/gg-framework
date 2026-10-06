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
      verification_bindings: [],
    });
  });

  it.each([{ evidence: undefined }, { evidence: [] }])(
    "rejects non-Done passed verification with missing evidence %j",
    ({ evidence }) => {
      for (const transition of ["pending", "in-progress", "blocked"] as const) {
        const result = RoadmapStatusParams.safeParse({
          ...base,
          transition,
          evidence,
          verification: { result: "passed" },
          ...(transition === "blocked"
            ? { blocker: "Access denied", required_external_action: "Grant access" }
            : {}),
        });
        expect(result.success).toBe(false);
        if (!result.success)
          expect(result.error.issues).toEqual(
            expect.arrayContaining([expect.objectContaining({ path: ["evidence"] })]),
          );
      }
    },
  );

  it("requires supporting prose for progress and Done reports", () => {
    expect(
      RoadmapStatusParams.parse({
        ...base,
        transition: "in-progress",
        evidence: ["Check passed"],
        verification: { result: "passed" },
      }).evidence,
    ).toEqual(["Check passed"]);
    expect(
      RoadmapStatusParams.parse({
        ...base,
        transition: "done",
        evidence: ["Required documentation sections are present"],
        verification: { result: "passed" },
      }).evidence,
    ).toEqual(["Required documentation sections are present"]);
  });

  it.each(["failed", "exception-requested"])("preserves %s reason requirements", (result) => {
    expect(
      RoadmapStatusParams.safeParse({
        ...base,
        transition: "in-progress",
        verification: { result },
      }).success,
    ).toBe(false);
    expect(
      RoadmapStatusParams.safeParse({
        ...base,
        transition: "in-progress",
        verification: { result, reason: "Check unavailable" },
      }).success,
    ).toBe(true);
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

  it("accepts null placeholders while requiring an honest completion report", () => {
    const input = {
      ...base,
      transition: "done",
      evidence: ["Documentation reviewed"],
      proposed_references: null,
      blocker: null,
      required_external_action: null,
      verification: { result: "passed", reason: null },
      verification_bindings: [{ criterion_id: "a".repeat(64), execution_id: "execution-1" }],
    };
    expect(RoadmapStatusParams.parse(input)).toMatchObject({
      transition: "done",
      verification: { result: "passed" },
      evidence: ["Documentation reviewed"],
    });
    for (const verification_bindings of [undefined, null, []]) {
      expect(RoadmapStatusParams.safeParse({ ...input, verification_bindings }).success).toBe(true);
    }
    for (const invalid of [
      { evidence: null },
      { evidence: [] },
      { verification: { result: "failed", reason: null } },
      { verification: { result: "passed", reason: "not allowed" } },
      { blocker: "not allowed" },
      { required_external_action: "not allowed" },
      { transition: "blocked" },
      { unexpected: null },
    ])
      expect(RoadmapStatusParams.safeParse({ ...input, ...invalid }).success).toBe(false);
  });

  it("requires passed verification but accepts shared historical executions for Done", () => {
    expect(() => RoadmapStatusParams.parse({ ...base, transition: "done" })).toThrow();
    expect(
      RoadmapStatusParams.parse({
        ...base,
        transition: "done",
        evidence: [" Seven bounded checks passed. "],
        verification_bindings: [
          { criterion_id: ` ${"a".repeat(64)} `, execution_id: " execution-1 " },
        ],
        verification: { result: "passed" },
      }),
    ).toMatchObject({
      transition: "done",
      evidence: ["Seven bounded checks passed."],
      verification_bindings: [{ criterion_id: "a".repeat(64), execution_id: "execution-1" }],
      verification: { result: "passed" },
    });
    expect(
      RoadmapStatusParams.safeParse({
        ...base,
        transition: "done",
        evidence: ["One check covers both criteria"],
        verification_bindings: [
          { criterion_id: "a".repeat(64), execution_id: "execution-1" },
          { criterion_id: "b".repeat(64), execution_id: "execution-1" },
        ],
        verification: { result: "passed" },
      }).success,
    ).toBe(true);
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
    expect(tool.description).toContain('transition: "done" records Done immediately');
    expect(tool.description).not.toMatch(/owning run|classifier-approved|per criterion/);
  });
});
