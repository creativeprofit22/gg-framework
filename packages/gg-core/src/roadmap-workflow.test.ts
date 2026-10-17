import { describe, expect, it } from "vitest";
import {
  ROADMAP_PHASE_DONE_WHEN_ITEM_MAX_LENGTH,
  ROADMAP_PHASE_DONE_WHEN_MAX_ITEMS,
  ROADMAP_PHASE_DRAFT_SUMMARY_MAX_LENGTH,
  ROADMAP_PHASE_GOAL_MAX_LENGTH,
  ROADMAP_PHASE_SOURCE_PROMPT_MAX_LENGTH,
  ROADMAP_PHASE_TITLE_MAX_LENGTH,
  ROADMAP_PROPOSED_PHASES_MAX_ITEMS,
  ROADMAP_PHASE_EDIT_BEFORE_MAX_LENGTH,
  applyRoadmapPhaseEdit,
  buildRoadmapPhaseEditChanges,
  classifyRoadmapPhaseEditability,
  isRoadmapInspectionOutcome,
  isRoadmapPhaseDraft,
  isRoadmapPhaseDraftApprovalResult,
  isRoadmapPhaseDraftRejectionResult,
  isRoadmapPhaseEditDraft,
  normalizeRoadmapWorkflowText,
  validateRoadmapPhaseDraft,
  validateRoadmapPhaseDraftRequest,
  validateRoadmapPhaseEditRequest,
  type RoadmapPhaseDraftRequest,
  type RoadmapPhaseEditDraft,
} from "./roadmap-workflow.js";
import { validateNotesDocumentV3, type NotesDocumentV3, type NotesPhase } from "./project-notes.js";

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

function inspectionWithVerification(latestVerification: unknown) {
  return {
    status: "ok",
    inspection: {
      projectKey: "/work/app",
      revision: 3,
      phases: [
        {
          id: "phase-1",
          title: "Phase",
          goal: "Goal",
          doneWhen: ["Checks pass"],
          order: 0,
          status: "review",
          archivedAt: null,
          hasBoundSession: true,
          latestProgress: "Later progress",
          latestBlocker: null,
          latestVerification,
          latestReview: null,
          hasUserStatusOverride: false,
        },
      ],
    },
  };
}

const verificationReport = {
  status: "passed",
  reason: null,
  evidence: ["reports/checks.md: focused checks passed"],
  updateId: "update-1",
  timestamp: "2026-08-05T12:00:00.000Z",
  progress: "Verification completed",
};

describe("Roadmap inspection verification", () => {
  it.each(["passed", "failed", "exception-requested"])(
    "accepts historical %s reports",
    (status) => {
      expect(
        isRoadmapInspectionOutcome(
          inspectionWithVerification({
            ...verificationReport,
            status,
            reason: status === "passed" ? null : "Reason",
          }),
        ),
      ).toBe(true);
    },
  );

  it("accepts null and exact legacy summaries without inventing evidence", () => {
    for (const report of [null, { status: "passed", reason: null }]) {
      expect(isRoadmapInspectionOutcome(inspectionWithVerification(report))).toBe(true);
    }
    // Historical records may legitimately have no evidence; inspection is not a Done gate.
    expect(
      isRoadmapInspectionOutcome(
        inspectionWithVerification({ ...verificationReport, evidence: [] }),
      ),
    ).toBe(true);
  });

  it("accepts the persisted evidence, progress, and reason bounds", () => {
    expect(
      isRoadmapInspectionOutcome(
        inspectionWithVerification({
          ...verificationReport,
          evidence: Array.from({ length: 20 }, () => "x".repeat(4_096)),
          progress: "x".repeat(4_096),
          reason: "x".repeat(1_024),
        }),
      ),
    ).toBe(true);
  });

  it.each([
    { evidence: Array.from({ length: 21 }, () => "report") },
    { evidence: ["x".repeat(4_097)] },
    { evidence: [""] },
    { evidence: [" "] },
    { evidence: [42] },
    { evidence: null },
    { progress: "x".repeat(4_097) },
    { progress: " " },
    { progress: null },
    { reason: "x".repeat(1_025) },
    { reason: 42 },
    { timestamp: "not-a-date" },
    { timestamp: null },
    { updateId: " " },
    { updateId: 42 },
    { status: "unknown" },
    { sourcePrompt: "hidden" },
    { sessionPath: "/hidden" },
  ])("rejects malformed or oversized report fields: %j", (invalid) => {
    expect(
      isRoadmapInspectionOutcome(inspectionWithVerification({ ...verificationReport, ...invalid })),
    ).toBe(false);
  });

  it("accepts an optional phase sourcePrompt string and rejects other phase keys", () => {
    const withPhase = (extra: Record<string, unknown>) => {
      const outcome = inspectionWithVerification(null);
      outcome.inspection.phases[0] = { ...outcome.inspection.phases[0]!, ...extra };
      return outcome;
    };
    expect(isRoadmapInspectionOutcome(withPhase({ sourcePrompt: "Full saved prompt" }))).toBe(true);
    expect(isRoadmapInspectionOutcome(withPhase({ sourcePrompt: "" }))).toBe(true);
    expect(isRoadmapInspectionOutcome(withPhase({ sourcePrompt: 42 }))).toBe(false);
    expect(isRoadmapInspectionOutcome(withPhase({ sourcePrompt: undefined }))).toBe(false);
    expect(isRoadmapInspectionOutcome(withPhase({ sessionPath: "/hidden" }))).toBe(false);
  });

  it("rejects missing fields and partial legacy upgrades", () => {
    for (const key of Object.keys(verificationReport)) {
      const partial: Record<string, unknown> = { ...verificationReport };
      delete partial[key];
      expect(isRoadmapInspectionOutcome(inspectionWithVerification(partial))).toBe(false);
    }
    expect(
      isRoadmapInspectionOutcome(
        inspectionWithVerification({
          status: "passed",
          reason: null,
          evidence: ["report"],
        }),
      ),
    ).toBe(false);
  });
});

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

  it("normalizes and bounds the uncited-sources reason", () => {
    expect(
      validateRoadmapPhaseDraftRequest({ ...request(), sourcesNotCited: "  Only confirmed.  " }),
    ).toMatchObject({ ok: true, value: { sourcesNotCited: "Only confirmed." } });
    const withoutReason = validateRoadmapPhaseDraftRequest(request());
    expect(withoutReason.ok && "sourcesNotCited" in withoutReason.value).toBe(false);
    expect(
      validateRoadmapPhaseDraftRequest({ ...request(), sourcesNotCited: "x".repeat(1_024) }).ok,
    ).toBe(true);
    expect(
      validateRoadmapPhaseDraftRequest({ ...request(), sourcesNotCited: "x".repeat(1_025) }),
    ).toMatchObject({ ok: false, error: { path: "sourcesNotCited" } });
    expect(validateRoadmapPhaseDraftRequest({ ...request(), sourcesNotCited: "   " }).ok).toBe(
      false,
    );
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
    expect(isRoadmapPhaseDraft({ ...draft, sourcesNotCited: null })).toBe(true);
    expect(isRoadmapPhaseDraft({ ...draft, sourcesNotCited: "Only confirmed." })).toBe(true);
    expect(isRoadmapPhaseDraft({ ...draft, sourcesNotCited: "" })).toBe(false);
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

function notesPhase(overrides: Partial<NotesPhase> = {}): NotesPhase {
  return {
    id: "phase-1",
    title: "Proposal protocol",
    goal: "Share a bounded flat proposal contract.",
    doneWhen: ["Strict runtime validation passes"],
    order: 0,
    status: "not-started",
    sourcePrompt: "Implement only the shared proposal protocol.",
    referenceIds: [],
    session: null,
    reminder: null,
    attentionReason: null,
    createdAt: "2026-08-05T10:00:00.000Z",
    updatedAt: "2026-08-05T11:00:00.000Z",
    completedAt: null,
    archivedAt: null,
    overrides: { status: null, referenceIds: null },
    pendingAutomaticLifecycleTransition: null,
    lifecycleEvents: [],
    roadmapEvents: [],
    ...overrides,
  };
}

function notesDocument(phases: NotesPhase[]): NotesDocumentV3 {
  return {
    version: 3,
    reference: "",
    currentFocus: "",
    tasks: [],
    handoff: { text: "", updatedAt: null, readAt: null },
    updatedAt: "2026-08-05T11:00:00.000Z",
    legacyImportedAt: null,
    phases,
    references: [],
  };
}

function editDraft(overrides: Partial<RoadmapPhaseEditDraft> = {}): RoadmapPhaseEditDraft {
  return {
    kind: "edit",
    id: "draft-edit-1",
    projectKey: "c:/work",
    basedOnRevision: 7,
    createdAt: "2026-08-05T12:00:00.000Z",
    createdBySessionId: "session-1",
    summary: "Clarify the protocol phase",
    phaseId: "phase-1",
    phaseTitle: "Proposal protocol",
    basedOnUpdatedAt: "2026-08-05T11:00:00.000Z",
    changes: [
      { field: "goal", before: "Share a bounded flat proposal contract.", after: "Share it." },
      {
        field: "doneWhen",
        before: ["Strict runtime validation passes"],
        after: ["Strict runtime validation passes", "Edits are reviewed"],
      },
    ],
    status: "pending",
    ...overrides,
  };
}

describe("Roadmap phase edit protocol", () => {
  it("accepts and normalizes an edit request with at least one field", () => {
    expect(
      validateRoadmapPhaseEditRequest({
        expectedRevision: 7,
        summary: "  Reword  ",
        phaseId: "phase-1",
        title: "  Cafe\u0301  ",
      }),
    ).toEqual({
      ok: true,
      value: { expectedRevision: 7, summary: "Reword", phaseId: "phase-1", title: "Café" },
    });
    expect(
      validateRoadmapPhaseEditRequest({ expectedRevision: 7, summary: "Reword", phaseId: "p" }),
    ).toMatchObject({ ok: false, error: { path: "$" } });
    expect(
      validateRoadmapPhaseEditRequest({
        expectedRevision: 7,
        summary: "Reword",
        phaseId: "p",
        title: "x",
        referenceKeys: [],
      }),
    ).toMatchObject({ ok: false, error: { path: "$" } });
  });

  it.each([
    ["title", ROADMAP_PHASE_TITLE_MAX_LENGTH],
    ["goal", ROADMAP_PHASE_GOAL_MAX_LENGTH],
    ["sourcePrompt", ROADMAP_PHASE_SOURCE_PROMPT_MAX_LENGTH],
  ] as const)("applies add-draft %s limits to edit requests", (field, maximum) => {
    const base = { expectedRevision: 1, summary: "Edit", phaseId: "phase-1" };
    expect(validateRoadmapPhaseEditRequest({ ...base, [field]: "x".repeat(maximum) }).ok).toBe(
      true,
    );
    expect(
      validateRoadmapPhaseEditRequest({ ...base, [field]: "x".repeat(maximum + 1) }),
    ).toMatchObject({ ok: false, error: { path: field } });
    expect(validateRoadmapPhaseEditRequest({ ...base, [field]: "  " }).ok).toBe(false);
  });

  it("applies add-draft completion-criterion limits to edit requests", () => {
    const base = { expectedRevision: 1, summary: "Edit", phaseId: "phase-1" };
    for (const doneWhen of [
      [],
      Array.from({ length: ROADMAP_PHASE_DONE_WHEN_MAX_ITEMS + 1 }, (_, i) => `c${i}`),
      ["x".repeat(ROADMAP_PHASE_DONE_WHEN_ITEM_MAX_LENGTH + 1)],
      ["Café", "Cafe\u0301"],
    ]) {
      expect(validateRoadmapPhaseEditRequest({ ...base, doneWhen }).ok).toBe(false);
    }
  });

  it("builds only changed fields in canonical order", () => {
    const phase = notesPhase();
    expect(
      buildRoadmapPhaseEditChanges(phase, {
        expectedRevision: 1,
        summary: "Edit",
        phaseId: phase.id,
        sourcePrompt: "New prompt",
        doneWhen: [...phase.doneWhen],
        title: phase.title,
        goal: "New goal",
      }),
    ).toEqual([
      { field: "goal", before: phase.goal, after: "New goal" },
      { field: "sourcePrompt", before: phase.sourcePrompt, after: "New prompt" },
    ]);
    expect(
      buildRoadmapPhaseEditChanges(phase, {
        expectedRevision: 1,
        summary: "Edit",
        phaseId: phase.id,
        title: phase.title,
      }),
    ).toEqual([]);
  });

  it("strictly validates edit drafts and keeps legacy create drafts valid", () => {
    expect(isRoadmapPhaseDraft(editDraft())).toBe(true);
    const valid = validateRoadmapPhaseDraft(editDraft());
    expect(valid.ok && isRoadmapPhaseEditDraft(valid.value)).toBe(true);
    // Notes may hold empty goals; `before` is loose, `after` uses add-draft limits.
    expect(
      isRoadmapPhaseDraft(editDraft({ changes: [{ field: "goal", before: "", after: "Goal" }] })),
    ).toBe(true);
    expect(
      isRoadmapPhaseDraft(
        editDraft({
          changes: [
            {
              field: "goal",
              before: "x".repeat(ROADMAP_PHASE_EDIT_BEFORE_MAX_LENGTH),
              after: "Goal",
            },
          ],
        }),
      ),
    ).toBe(true);

    for (const invalid of [
      editDraft({ changes: [] }),
      editDraft({ changes: [{ field: "goal", before: "Same", after: "Same" }] }),
      editDraft({ changes: [{ field: "goal", before: "Old", after: "" }] }),
      editDraft({
        changes: [{ field: "title", before: "Old", after: "x".repeat(201) }],
      }),
      editDraft({
        changes: [{ field: "doneWhen", before: ["a"], after: ["a"] }],
      }),
      editDraft({
        changes: [
          { field: "sourcePrompt", before: "a", after: "b" },
          { field: "title", before: "a", after: "b" },
        ],
      }),
      editDraft({
        changes: [
          { field: "goal", before: "a", after: "b" },
          { field: "goal", before: "a", after: "c" },
        ],
      }),
      editDraft({ basedOnUpdatedAt: "not-a-date" }),
      { ...editDraft(), phases: [] },
      { ...editDraft(), status: "approved" },
    ]) {
      expect(isRoadmapPhaseDraft(invalid)).toBe(false);
    }

    const legacy = {
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
    const legacyResult = validateRoadmapPhaseDraft(legacy);
    expect(legacyResult.ok && !isRoadmapPhaseEditDraft(legacyResult.value)).toBe(true);
    expect(isRoadmapPhaseDraft({ ...legacy, kind: "create" })).toBe(false);
  });

  it("classifies non-editable phases", () => {
    expect(classifyRoadmapPhaseEditability(undefined)).toBe("missing");
    expect(
      classifyRoadmapPhaseEditability(
        notesPhase({ deletion: { version: 1, currentDeletionId: "deletion-1", events: [] } }),
      ),
    ).toBe("deleted");
    expect(classifyRoadmapPhaseEditability(notesPhase({ status: "done" }))).toBe("done");
    expect(
      classifyRoadmapPhaseEditability(notesPhase({ archivedAt: "2026-08-05T12:00:00.000Z" })),
    ).toBe("archived");
    expect(
      classifyRoadmapPhaseEditability(
        notesPhase({ deletion: { version: 1, currentDeletionId: null, events: [] } }),
      ),
    ).toBeNull();
    expect(classifyRoadmapPhaseEditability(notesPhase({ status: "in-progress" }))).toBeNull();
  });

  it("applies an edit to one phase with a strictly later timestamp", () => {
    const other = notesPhase({ id: "phase-2", order: 1, title: "Other" });
    const document = notesDocument([notesPhase(), other]);
    const result = applyRoadmapPhaseEdit(document, editDraft(), "2026-08-05T13:00:00.000Z");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.document.phases[0]).toEqual({
      ...notesPhase(),
      goal: "Share it.",
      doneWhen: ["Strict runtime validation passes", "Edits are reviewed"],
      updatedAt: "2026-08-05T13:00:00.000Z",
    });
    expect(result.document.phases[1]).toEqual(other);
    expect(result.document.updatedAt).toBe("2026-08-05T13:00:00.000Z");
    expect(validateNotesDocumentV3(result.document).ok).toBe(true);
    // The input document is not mutated.
    expect(document.phases[0]).toEqual(notesPhase());

    const skewed = applyRoadmapPhaseEdit(document, editDraft(), "2026-08-05T10:00:00.000Z");
    expect(skewed.status === "ok" && skewed.document.phases[0]?.updatedAt).toBe(
      "2026-08-05T11:00:00.001Z",
    );
  });

  it("refuses edits when the target phase changed or is no longer editable", () => {
    const at = "2026-08-05T13:00:00.000Z";
    expect(
      applyRoadmapPhaseEdit(
        notesDocument([notesPhase({ updatedAt: "2026-08-05T11:30:00.000Z" })]),
        editDraft(),
        at,
      ),
    ).toEqual({ status: "phase-changed", phaseId: "phase-1" });
    expect(
      applyRoadmapPhaseEdit(notesDocument([notesPhase({ goal: "Edited in UI" })]), editDraft(), at),
    ).toEqual({ status: "phase-changed", phaseId: "phase-1" });
    expect(
      applyRoadmapPhaseEdit(notesDocument([notesPhase({ status: "done" })]), editDraft(), at),
    ).toEqual({ status: "phase-not-editable", phaseId: "phase-1", reason: "done" });
    expect(applyRoadmapPhaseEdit(notesDocument([]), editDraft(), at)).toEqual({
      status: "phase-not-editable",
      phaseId: "phase-1",
      reason: "missing",
    });
  });

  it("accepts the edit approval outcomes and rejects malformed ones", () => {
    expect(
      isRoadmapPhaseDraftApprovalResult({ status: "edited", revision: 8, phaseId: "p1" }),
    ).toBe(true);
    expect(isRoadmapPhaseDraftApprovalResult({ status: "phase-changed", phaseId: "p1" })).toBe(
      true,
    );
    expect(
      isRoadmapPhaseDraftApprovalResult({
        status: "phase-not-editable",
        phaseId: "p1",
        reason: "archived",
      }),
    ).toBe(true);
    expect(isRoadmapPhaseDraftApprovalResult({ status: "edited", revision: 8, phaseId: "" })).toBe(
      false,
    );
    expect(
      isRoadmapPhaseDraftApprovalResult({
        status: "phase-not-editable",
        phaseId: "p1",
        reason: "locked",
      }),
    ).toBe(false);
    expect(
      isRoadmapPhaseDraftApprovalResult({ status: "phase-changed", phaseId: "p1", extra: 1 }),
    ).toBe(false);
  });
});
