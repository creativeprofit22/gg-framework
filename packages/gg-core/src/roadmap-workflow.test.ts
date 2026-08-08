import { describe, expect, it } from "vitest";
import {
  ROADMAP_PHASE_DONE_WHEN_ITEM_MAX_LENGTH,
  ROADMAP_PHASE_DONE_WHEN_MAX_ITEMS,
  ROADMAP_PHASE_DRAFT_SUMMARY_MAX_LENGTH,
  ROADMAP_PHASE_GOAL_MAX_LENGTH,
  ROADMAP_PHASE_SOURCE_PROMPT_MAX_LENGTH,
  ROADMAP_PHASE_TITLE_MAX_LENGTH,
  ROADMAP_PROPOSED_PHASES_MAX_ITEMS,
  isRoadmapPhaseDraft,
  isRoadmapPhaseDraftApprovalResult,
  isRoadmapPhaseDraftRejectionResult,
  normalizeRoadmapWorkflowText,
  validateRoadmapPhaseDraftRequest,
  type RoadmapPhaseDraftRequest,
} from "./roadmap-workflow.js";

function request(): RoadmapPhaseDraftRequest {
  return {
    expectedRevision: 7,
    summary: "Add a safe Roadmap workflow",
    phases: [
      {
        title: "Proposal protocol",
        goal: "Share a bounded flat proposal contract.",
        doneWhen: ["Strict runtime validation passes", "Nested fields are rejected"],
        sourcePrompt: "Implement only the shared proposal protocol for this peer phase.",
      },
    ],
  };
}

describe("Roadmap workflow protocol", () => {
  it("accepts and normalizes a canonical flat request", () => {
    const candidate = request();
    candidate.summary = "  Cafe\u0301\r\nworkflow  ";
    candidate.phases[0]!.title = "  Protocol  ";

    expect(validateRoadmapPhaseDraftRequest(candidate)).toEqual({
      ok: true,
      value: {
        ...candidate,
        summary: "Café\nworkflow",
        phases: [{ ...candidate.phases[0], title: "Protocol", referenceKeys: [] }],
        proposedReferences: [],
      },
    });
    expect(normalizeRoadmapWorkflowText(" x\r\ny ")).toBe("x\ny");
  });

  it.each([
    ["root", { ...request(), extra: true }, "$"],
    ["phase", { ...request(), phases: [{ ...request().phases[0], children: [] }] }, "phases[0]"],
    [
      "nested parent",
      { ...request(), phases: [{ ...request().phases[0], parentId: "p" }] },
      "phases[0]",
    ],
    [
      "nested slices",
      { ...request(), phases: [{ ...request().phases[0], subphases: [] }] },
      "phases[0]",
    ],
  ])("rejects unknown or nested keys at %s", (_name, candidate, path) => {
    expect(validateRoadmapPhaseDraftRequest(candidate)).toMatchObject({
      ok: false,
      error: { path },
    });
  });

  it("requires a non-negative integer inspected revision", () => {
    for (const expectedRevision of [-1, 1.5, Number.NaN, "1"]) {
      expect(validateRoadmapPhaseDraftRequest({ ...request(), expectedRevision })).toMatchObject({
        ok: false,
        error: { path: "expectedRevision" },
      });
    }
  });

  it.each([
    ["summary", ROADMAP_PHASE_DRAFT_SUMMARY_MAX_LENGTH],
    ["title", ROADMAP_PHASE_TITLE_MAX_LENGTH],
    ["goal", ROADMAP_PHASE_GOAL_MAX_LENGTH],
    ["sourcePrompt", ROADMAP_PHASE_SOURCE_PROMPT_MAX_LENGTH],
  ] as const)("enforces normalized %s character bounds", (field, maximum) => {
    const exact = request();
    if (field === "summary") exact.summary = ` ${"x".repeat(maximum)} `;
    else exact.phases[0]![field] = ` ${"x".repeat(maximum)} `;
    expect(validateRoadmapPhaseDraftRequest(exact).ok).toBe(true);

    const oversized = request();
    if (field === "summary") oversized.summary = "x".repeat(maximum + 1);
    else oversized.phases[0]![field] = "x".repeat(maximum + 1);
    expect(validateRoadmapPhaseDraftRequest(oversized).ok).toBe(false);

    const blank = request();
    if (field === "summary") blank.summary = " \r\n ";
    else blank.phases[0]![field] = " \t ";
    expect(validateRoadmapPhaseDraftRequest(blank).ok).toBe(false);
  });

  it("counts Unicode code points rather than UTF-16 units", () => {
    const candidate = request();
    candidate.phases[0]!.title = "😀".repeat(ROADMAP_PHASE_TITLE_MAX_LENGTH);
    expect(validateRoadmapPhaseDraftRequest(candidate).ok).toBe(true);
    candidate.phases[0]!.title += "😀";
    expect(validateRoadmapPhaseDraftRequest(candidate).ok).toBe(false);
  });

  it("enforces phase and completion-criterion limits", () => {
    const tooManyPhases = request();
    tooManyPhases.phases = Array.from(
      { length: ROADMAP_PROPOSED_PHASES_MAX_ITEMS + 1 },
      () => request().phases[0]!,
    );
    expect(validateRoadmapPhaseDraftRequest(tooManyPhases)).toMatchObject({
      ok: false,
      error: { path: "phases" },
    });

    const tooManyCriteria = request();
    tooManyCriteria.phases[0]!.doneWhen = Array.from(
      { length: ROADMAP_PHASE_DONE_WHEN_MAX_ITEMS + 1 },
      (_, index) => `criterion ${index}`,
    );
    expect(validateRoadmapPhaseDraftRequest(tooManyCriteria)).toMatchObject({
      ok: false,
      error: { path: "phases[0].doneWhen" },
    });

    const oversizedCriterion = request();
    oversizedCriterion.phases[0]!.doneWhen = [
      "x".repeat(ROADMAP_PHASE_DONE_WHEN_ITEM_MAX_LENGTH + 1),
    ];
    expect(validateRoadmapPhaseDraftRequest(oversizedCriterion)).toMatchObject({
      ok: false,
      error: { path: "phases[0].doneWhen[0]" },
    });
  });

  it("rejects completion criteria that collide after normalization", () => {
    const candidate = request();
    candidate.phases[0]!.doneWhen = ["Café", "  Cafe\u0301  "];
    expect(validateRoadmapPhaseDraftRequest(candidate)).toMatchObject({
      ok: false,
      error: { path: "phases[0].doneWhen[1]" },
    });
  });

  it("normalizes and links structured references", () => {
    const candidate = {
      ...request(),
      proposedReferences: [
        {
          referenceKey: " source ",
          provider: " GitHub ",
          canonicalUrl: "https://github.com/KenKaiiii/gg-framework/",
          owner: "KenKaiiii",
          repo: "gg-framework",
          path: " packages/gg-core/src/roadmap-workflow.ts ",
          range: { startLine: 1, endLine: 10 },
          relevance: "  Shared contract  ",
        },
      ],
      phases: [{ ...request().phases[0], referenceKeys: [" source "] }],
    };

    expect(validateRoadmapPhaseDraftRequest(candidate)).toEqual({
      ok: true,
      value: {
        ...request(),
        proposedReferences: [
          {
            referenceKey: "source",
            provider: "github",
            tool: null,
            canonicalUrl: "https://github.com/KenKaiiii/gg-framework",
            owner: "KenKaiiii",
            repo: "gg-framework",
            revision: null,
            path: "packages/gg-core/src/roadmap-workflow.ts",
            range: { startLine: 1, endLine: 10 },
            issue: null,
            pullRequest: null,
            query: null,
            anchor: null,
            relevance: "Shared contract",
          },
        ],
        phases: [{ ...request().phases[0], referenceKeys: ["source"] }],
      },
    });
  });

  it.each([
    ["duplicate key", ["a", "a"], "proposedReferences[1].referenceKey"],
    ["duplicate identity", ["a", "b"], "proposedReferences[1].canonicalUrl"],
  ])("rejects %s", (_name, keys, path) => {
    const references = keys.map((referenceKey) => ({
      referenceKey,
      provider: "github",
      canonicalUrl: "https://github.com/KenKaiiii/gg-framework",
      owner: "KenKaiiii",
      repo: "gg-framework",
      relevance: "contract",
    }));
    expect(
      validateRoadmapPhaseDraftRequest({
        ...request(),
        proposedReferences: references,
        phases: [{ ...request().phases[0], referenceKeys: [keys[0]!] }],
      }),
    ).toMatchObject({ ok: false, error: { path } });
  });

  it("rejects unknown, duplicate, and unlinked phase reference keys", () => {
    const reference = {
      referenceKey: "source",
      provider: "github",
      canonicalUrl: "https://github.com/KenKaiiii/gg-framework",
      owner: "KenKaiiii",
      repo: "gg-framework",
      relevance: "contract",
    };
    for (const referenceKeys of [["missing"], ["source", "source"]]) {
      expect(
        validateRoadmapPhaseDraftRequest({
          ...request(),
          proposedReferences: [reference],
          phases: [{ ...request().phases[0], referenceKeys }],
        }).ok,
      ).toBe(false);
    }
    expect(
      validateRoadmapPhaseDraftRequest({ ...request(), proposedReferences: [reference] }),
    ).toMatchObject({
      ok: false,
      error: { path: "proposedReferences[0].referenceKey" },
    });
  });

  it("reuses Notes reference semantics for ranges and GitHub coordinates", () => {
    const base = {
      referenceKey: "source",
      provider: "github",
      canonicalUrl: "https://github.com/KenKaiiii/gg-framework",
      owner: "wrong-owner",
      repo: "gg-framework",
      relevance: "contract",
    };
    expect(
      validateRoadmapPhaseDraftRequest({
        ...request(),
        proposedReferences: [base],
        phases: [{ ...request().phases[0], referenceKeys: ["source"] }],
      }),
    ).toMatchObject({ ok: false, error: { path: "proposedReferences[0].canonicalUrl" } });
    expect(
      validateRoadmapPhaseDraftRequest({
        ...request(),
        proposedReferences: [{ ...base, owner: "KenKaiiii", range: { startLine: 2, endLine: 1 } }],
        phases: [{ ...request().phases[0], referenceKeys: ["source"] }],
      }),
    ).toMatchObject({ ok: false, error: { path: "proposedReferences[0].range.endLine" } });
  });

  it("strictly validates pending drafts and immutable generated IDs", () => {
    const draft = {
      id: "draft-1",
      projectKey: "c:/work",
      basedOnRevision: 7,
      createdAt: "2026-08-05T12:00:00.000Z",
      createdBySessionId: "session-1",
      summary: request().summary,
      references: [],
      phases: [{ phaseId: "phase-1", ...request().phases[0], referenceIds: [] }],
      status: "pending",
    };
    expect(isRoadmapPhaseDraft(draft)).toBe(true);
    expect(isRoadmapPhaseDraft({ ...draft, phases: [{ ...draft.phases[0], order: 1 }] })).toBe(
      false,
    );
    expect(isRoadmapPhaseDraft({ ...draft, phases: [draft.phases[0], draft.phases[0]] })).toBe(
      false,
    );
  });

  it("keeps approval and rejection result unions closed", () => {
    expect(
      isRoadmapPhaseDraftApprovalResult({ status: "created", revision: 8, phaseIds: ["p1"] }),
    ).toBe(true);
    expect(
      isRoadmapPhaseDraftApprovalResult({
        status: "stale-revision",
        expectedRevision: 7,
        currentRevision: 8,
      }),
    ).toBe(true);
    expect(
      isRoadmapPhaseDraftApprovalResult({ status: "created", revision: 8, phaseIds: [] }),
    ).toBe(false);
    expect(isRoadmapPhaseDraftApprovalResult({ status: "future-result" })).toBe(false);
    expect(isRoadmapPhaseDraftRejectionResult({ status: "rejected" })).toBe(true);
    expect(
      isRoadmapPhaseDraftRejectionResult({ status: "already-decided", decision: "approved" }),
    ).toBe(true);
    expect(isRoadmapPhaseDraftRejectionResult({ status: "rejected", feedback: "hidden" })).toBe(
      false,
    );
  });
});
