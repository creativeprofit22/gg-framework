import { describe, expect, it } from "vitest";
import {
  ROADMAP_PHASE_BATCH_MAX_ITEMS,
  applyRoadmapPhaseEditBatch,
  applyRoadmapPhaseMoveBatch,
  isRoadmapPhaseCreateDraft,
  isRoadmapPhaseDraft,
  isRoadmapPhaseDraftApprovalResult,
  isRoadmapPhaseEditBatchDraft,
  isRoadmapPhaseMoveBatchDraft,
  planRoadmapPhaseMove,
  planRoadmapPhaseMoves,
  replayRoadmapPhaseOrderMoves,
  roadmapPhaseMoveBatchStep,
  roadmapPhaseOrderEntries,
  validateRoadmapPhaseDraft,
  validateRoadmapPhaseEditBatchRequest,
  validateRoadmapPhaseMoveBatchRequest,
  type RoadmapPhaseEditBatchDraft,
  type RoadmapPhaseMoveBatchDraft,
} from "./roadmap-workflow.js";
import { validateNotesDocumentV3, type NotesDocumentV3, type NotesPhase } from "./project-notes.js";

const at = "2026-08-05T13:00:00.000Z";
const done: Partial<NotesPhase> = { status: "done", completedAt: "2026-08-05T11:00:00.000Z" };

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

const roadmap = (overrides: Record<string, Partial<NotesPhase>> = {}): NotesPhase[] =>
  ["a", "b", "c", "d"].map((id, order) =>
    notesPhase({ id, title: `Phase ${id}`, order, ...overrides[id] }),
  );
const ids = (phases: readonly NotesPhase[]) => phases.map((phase) => phase.id);

function editBatch(
  overrides: Partial<RoadmapPhaseEditBatchDraft> = {},
): RoadmapPhaseEditBatchDraft {
  return {
    kind: "edit-batch",
    id: "draft-batch-1",
    projectKey: "c:/work",
    basedOnRevision: 7,
    createdAt: "2026-08-05T12:00:00.000Z",
    createdBySessionId: "session-1",
    summary: "Tighten two phases",
    edits: [
      {
        phaseId: "a",
        phaseTitle: "Phase a",
        basedOnUpdatedAt: "2026-08-05T11:00:00.000Z",
        changes: [{ field: "title", before: "Phase a", after: "Phase A" }],
      },
      {
        phaseId: "c",
        phaseTitle: "Phase c",
        basedOnUpdatedAt: "2026-08-05T11:00:00.000Z",
        changes: [
          { field: "goal", before: "Share a bounded flat proposal contract.", after: "Ship it." },
        ],
      },
    ],
    status: "pending",
    ...overrides,
  };
}

const step = (
  phaseId: string,
  position: "before" | "after",
  targetPhaseId: string,
): RoadmapPhaseMoveBatchDraft["moves"][number] => ({
  phaseId,
  phaseTitle: `Phase ${phaseId}`,
  position,
  targetPhaseId,
  targetPhaseTitle: `Phase ${targetPhaseId}`,
});

function moveBatch(
  phases: NotesPhase[],
  moves: RoadmapPhaseMoveBatchDraft["moves"],
): RoadmapPhaseMoveBatchDraft {
  const before = roadmapPhaseOrderEntries(phases);
  return {
    kind: "move-batch",
    id: "draft-moves-1",
    projectKey: "c:/work",
    basedOnRevision: 3,
    createdAt: "2026-08-05T12:00:00.000Z",
    createdBySessionId: "session-1",
    summary: "Reorder",
    moves,
    orderPreview: {
      before,
      after: replayRoadmapPhaseOrderMoves(before, moves.map(roadmapPhaseMoveBatchStep)) ?? [],
    },
    status: "pending",
  };
}

describe("Roadmap phase edit batches", () => {
  it("validates requests: bounds, unique phases and per-item error paths", () => {
    const base = { expectedRevision: 2, summary: "  Batch  " };
    expect(
      validateRoadmapPhaseEditBatchRequest({
        ...base,
        edits: [
          { phaseId: "a", title: "  New  " },
          { phaseId: "b", dependsOn: [] },
        ],
      }),
    ).toEqual({
      ok: true,
      value: {
        expectedRevision: 2,
        summary: "Batch",
        edits: [
          { phaseId: "a", title: "New" },
          { phaseId: "b", dependsOn: [] },
        ],
      },
    });
    expect(validateRoadmapPhaseEditBatchRequest({ ...base, edits: [] })).toMatchObject({
      ok: false,
      error: { path: "edits" },
    });
    const tooMany = Array.from({ length: ROADMAP_PHASE_BATCH_MAX_ITEMS + 1 }, (_, index) => ({
      phaseId: `p${index}`,
      title: "x",
    }));
    expect(validateRoadmapPhaseEditBatchRequest({ ...base, edits: tooMany }).ok).toBe(false);
    expect(
      validateRoadmapPhaseEditBatchRequest({
        ...base,
        edits: [
          { phaseId: "a", title: "x" },
          { phaseId: "a", goal: "y" },
        ],
      }),
    ).toMatchObject({ ok: false, error: { path: "edits[1].phaseId" } });
    expect(
      validateRoadmapPhaseEditBatchRequest({ ...base, edits: [{ phaseId: "a" }] }),
    ).toMatchObject({ ok: false, error: { path: "edits[0]" } });
    expect(
      validateRoadmapPhaseEditBatchRequest({ ...base, edits: [{ phaseId: "a", title: " " }] }),
    ).toMatchObject({ ok: false, error: { path: "edits[0].title" } });
    expect(
      validateRoadmapPhaseEditBatchRequest({
        ...base,
        edits: [{ phaseId: "a", dependsOn: ["a"] }],
      }),
    ).toMatchObject({ ok: false, error: { path: "edits[0].dependsOn[0]" } });
    // Exactly one form: single-phase fields never sit beside `edits`.
    expect(
      validateRoadmapPhaseEditBatchRequest({
        ...base,
        phaseId: "a",
        edits: [{ phaseId: "b", title: "x" }],
      }).ok,
    ).toBe(false);
    expect(
      validateRoadmapPhaseEditBatchRequest({
        ...base,
        edits: [{ phaseId: "a", title: "x", summary: "nested" }],
      }),
    ).toMatchObject({ ok: false, error: { path: "edits[0]" } });
  });

  it("strictly validates drafts", () => {
    const draft = editBatch();
    const valid = validateRoadmapPhaseDraft(draft);
    expect(valid).toEqual({ ok: true, value: draft });
    expect(valid.ok && isRoadmapPhaseEditBatchDraft(valid.value)).toBe(true);
    expect(valid.ok && isRoadmapPhaseCreateDraft(valid.value)).toBe(false);
    const [first, second] = draft.edits as [
      RoadmapPhaseEditBatchDraft["edits"][number],
      RoadmapPhaseEditBatchDraft["edits"][number],
    ];
    const linkingSecond = {
      ...second,
      changes: [{ field: "dependsOn" as const, before: [], after: ["a"] }],
    };
    for (const invalid of [
      editBatch({ edits: [first] }),
      editBatch({ edits: [first, { ...second, phaseId: "a" }] }),
      editBatch({ edits: [first, { ...second, changes: [] }] }),
      editBatch({
        edits: [first, { ...second, changes: [{ field: "goal", before: "x", after: "x" }] }],
      }),
      editBatch({ edits: [first, { ...second, basedOnUpdatedAt: "soon" }] }),
      editBatch({
        edits: [first, { ...second, changes: [{ field: "dependsOn", before: [], after: ["c"] }] }],
      }),
      // dependencyPhases is required exactly when a dependsOn change lists links.
      editBatch({ edits: [first, linkingSecond] }),
      editBatch({ dependencyPhases: [{ phaseId: "a", title: "Phase a", archived: false }] }),
      { ...editBatch(), edits: [{ ...first, extra: true }, second] },
      { ...editBatch(), phaseId: "a" },
      { ...editBatch(), status: "approved" },
    ]) {
      expect(isRoadmapPhaseDraft(invalid)).toBe(false);
    }
    expect(
      isRoadmapPhaseDraft(
        editBatch({
          edits: [first, linkingSecond],
          dependencyPhases: [{ phaseId: "a", title: "Phase a", archived: false }],
        }),
      ),
    ).toBe(true);
  });

  it("applies all-or-nothing with one shared, strictly later timestamp", () => {
    const document = notesDocument(roadmap());
    const applied = applyRoadmapPhaseEditBatch(document, editBatch(), at);
    if (applied.status !== "ok") throw new Error("expected the batch to apply");
    const byId = new Map(applied.document.phases.map((phase) => [phase.id, phase]));
    expect(byId.get("a")?.title).toBe("Phase A");
    expect(byId.get("c")?.goal).toBe("Ship it.");
    expect(byId.get("a")?.updatedAt).toBe(at);
    expect(byId.get("c")?.updatedAt).toBe(at);
    expect(byId.get("b")).toEqual(document.phases[1]);
    expect(applied.document.updatedAt).toBe(at);
    expect(validateNotesDocumentV3(applied.document).ok).toBe(true);
    expect(document.phases[0]?.title).toBe("Phase a");

    const skewed = applyRoadmapPhaseEditBatch(document, editBatch(), "2026-08-05T10:00:00.000Z");
    expect(skewed.status === "ok" && skewed.document.updatedAt).toBe("2026-08-05T11:00:00.001Z");

    // One stale or locked item refuses the whole batch and names that phase.
    expect(
      applyRoadmapPhaseEditBatch(notesDocument(roadmap({ c: { goal: "UI" } })), editBatch(), at),
    ).toEqual({ status: "phase-changed", phaseId: "c" });
    expect(
      applyRoadmapPhaseEditBatch(
        notesDocument(roadmap({ c: { updatedAt: "2026-08-05T11:30:00.000Z" } })),
        editBatch(),
        at,
      ),
    ).toEqual({ status: "phase-changed", phaseId: "c" });
    expect(
      applyRoadmapPhaseEditBatch(notesDocument(roadmap({ c: done })), editBatch(), at),
    ).toEqual({ status: "phase-not-editable", phaseId: "c", reason: "done" });
    expect(
      applyRoadmapPhaseEditBatch(notesDocument(roadmap().slice(0, 2)), editBatch(), at),
    ).toEqual({ status: "phase-not-editable", phaseId: "c", reason: "missing" });
  });
});

describe("Roadmap phase move batches", () => {
  it("validates requests: bounds, placements and each phase once", () => {
    const base = { expectedRevision: 2, summary: "Batch" };
    const moves = [
      { phaseId: "d", beforePhaseId: "a" },
      { phaseId: "c", afterPhaseId: "a" },
    ];
    expect(validateRoadmapPhaseMoveBatchRequest({ ...base, moves })).toEqual({
      ok: true,
      value: { ...base, moves },
    });
    for (const invalid of [
      [],
      [{ phaseId: "d" }],
      [{ phaseId: "d", beforePhaseId: "a", afterPhaseId: "b" }],
      [
        { phaseId: "d", beforePhaseId: "a" },
        { phaseId: "d", afterPhaseId: "b" },
      ],
    ]) {
      expect(validateRoadmapPhaseMoveBatchRequest({ ...base, moves: invalid }).ok).toBe(false);
    }
    expect(
      validateRoadmapPhaseMoveBatchRequest({
        ...base,
        moves: [{ phaseId: "d", beforePhaseId: "d" }],
      }),
    ).toMatchObject({ ok: false, error: { path: "moves[0].beforePhaseId" } });
    expect(validateRoadmapPhaseMoveBatchRequest({ ...base, phaseId: "d", moves }).ok).toBe(false);
  });

  it("plans moves in order, each against the order left by the previous step", () => {
    const planned = planRoadmapPhaseMoves(roadmap(), [
      { phaseId: "d", placement: { position: "before", targetPhaseId: "a" } },
      // After the first step the order is d, a, b, c.
      { phaseId: "c", placement: { position: "after", targetPhaseId: "d" } },
    ]);
    expect(planned.ok && ids(planned.phases)).toEqual(["d", "c", "a", "b"]);
    expect(planned.ok && planned.phases.map((phase) => phase.order)).toEqual([0, 1, 2, 3]);

    expect(
      planRoadmapPhaseMoves(roadmap(), [
        { phaseId: "d", placement: { position: "before", targetPhaseId: "a" } },
        { phaseId: "a", placement: { position: "after", targetPhaseId: "d" } },
      ]),
    ).toEqual({ ok: false, refusal: { reason: "no-change", phaseId: "a" }, index: 1 });
    // Steps that cancel each other out are refused as a whole.
    expect(
      planRoadmapPhaseMoves(roadmap(), [
        { phaseId: "a", placement: { position: "after", targetPhaseId: "b" } },
        { phaseId: "b", placement: { position: "after", targetPhaseId: "a" } },
      ]),
    ).toEqual({ ok: false, refusal: { reason: "no-change", phaseId: "a" }, index: 1 });
    expect(
      planRoadmapPhaseMoves(roadmap({ b: done }), [
        { phaseId: "d", placement: { position: "after", targetPhaseId: "b" } },
        { phaseId: "c", placement: { position: "before", targetPhaseId: "a" } },
      ]),
    ).toEqual({
      ok: false,
      refusal: { reason: "ahead-of-done", phaseId: "c", donePhaseId: "b" },
      index: 1,
    });
  });

  it("validates drafts by replaying every step", () => {
    const draft = moveBatch(roadmap(), [step("d", "before", "a"), step("c", "after", "d")]);
    expect(draft.orderPreview.after.map((entry) => entry.phaseId)).toEqual(["d", "c", "a", "b"]);
    expect(validateRoadmapPhaseDraft(draft)).toEqual({ ok: true, value: draft });
    expect(isRoadmapPhaseMoveBatchDraft(draft)).toBe(true);
    const [first, second] = draft.moves as [
      RoadmapPhaseMoveBatchDraft["moves"][number],
      RoadmapPhaseMoveBatchDraft["moves"][number],
    ];
    for (const invalid of [
      { ...draft, moves: [first] },
      { ...draft, orderPreview: { ...draft.orderPreview, after: draft.orderPreview.before } },
      {
        ...draft,
        orderPreview: { ...draft.orderPreview, after: [...draft.orderPreview.after].reverse() },
      },
      { ...draft, moves: [first, { ...second, phaseId: "d" }] },
      { ...draft, moves: [first, { ...second, targetPhaseId: "c" }] },
      { ...draft, moves: [first, { ...second, targetPhaseId: "zz" }] },
      { ...draft, moves: [first, { ...second, position: "above" }] },
      { ...draft, moves: [first, { ...second, extra: 1 }] },
      { ...draft, phaseId: "d" },
      // A step that changes nothing after the previous one.
      moveBatch(roadmap(), [step("d", "before", "a"), step("a", "after", "d")]),
    ]) {
      expect(isRoadmapPhaseDraft(invalid)).toBe(false);
    }
  });

  it("applies all-or-nothing against the proposed order", () => {
    const phases = roadmap();
    const draft = moveBatch(phases, [step("d", "before", "a"), step("c", "after", "d")]);
    const applied = applyRoadmapPhaseMoveBatch(notesDocument(phases), draft, at);
    if (applied.status !== "ok") throw new Error("expected the batch to apply");
    expect(ids(applied.document.phases)).toEqual(["d", "c", "a", "b"]);
    expect(applied.document.updatedAt).toBe(at);
    expect(validateNotesDocumentV3(applied.document).ok).toBe(true);

    const reordered = planRoadmapPhaseMove(phases, "b", { position: "before", targetPhaseId: "a" });
    if (!reordered.ok) throw new Error("expected setup reorder");
    expect(applyRoadmapPhaseMoveBatch(notesDocument(reordered.phases), draft, at)).toEqual({
      status: "phase-changed",
      phaseId: "d",
    });
    expect(applyRoadmapPhaseMoveBatch(notesDocument(roadmap({ c: done })), draft, at)).toEqual({
      status: "phase-not-editable",
      phaseId: "c",
      reason: "done",
    });
  });
});

describe("Roadmap batch approval results", () => {
  it("accepts phaseIds on edited and moved results and keeps single results valid", () => {
    expect(
      isRoadmapPhaseDraftApprovalResult({
        status: "edited",
        revision: 8,
        phaseId: "a",
        phaseIds: ["a", "c"],
      }),
    ).toBe(true);
    expect(
      isRoadmapPhaseDraftApprovalResult({
        status: "moved",
        revision: 8,
        phaseId: "d",
        phaseIds: ["d", "c"],
      }),
    ).toBe(true);
    expect(isRoadmapPhaseDraftApprovalResult({ status: "moved", revision: 8, phaseId: "d" })).toBe(
      true,
    );
    for (const phaseIds of [["c", "a"], ["a", "a"], ["a", ""], [], "a"]) {
      expect(
        isRoadmapPhaseDraftApprovalResult({
          status: "edited",
          revision: 8,
          phaseId: "a",
          phaseIds,
        }),
      ).toBe(false);
    }
  });
});
