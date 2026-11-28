import { describe, expect, it } from "vitest";
import {
  describeRoadmapDraft,
  initialRoadmapPhaseDraftState,
  normalizeRoadmapPhaseDraft,
  reduceRoadmapPhaseDraftState,
} from "./roadmap-phase-draft-state";

const draft = {
  id: "draft-1",
  projectKey: "/work",
  basedOnRevision: 3,
  createdAt: "2026-08-05T12:00:00.000Z",
  createdBySessionId: "session-1",
  sourcesNotCited: null,
  summary: "Create a clear review flow",
  references: [],
  phases: [
    {
      phaseId: "phase-1",
      title: "Review UI",
      goal: "Make the proposal legible.",
      doneWhen: ["Titles are visible", "Criteria are visible"],
      sourcePrompt: "Build the review UI.",
      referenceIds: [],
    },
  ],
  status: "pending" as const,
};

describe("Roadmap phase draft state", () => {
  it("keeps a collapsed in-flight review and its context on same-draft replay", () => {
    let state = reduceRoadmapPhaseDraftState(initialRoadmapPhaseDraftState, {
      type: "event",
      draft,
    });
    state = reduceRoadmapPhaseDraftState(state, { type: "dismiss" });
    state = reduceRoadmapPhaseDraftState(state, {
      type: "decision-started",
      decision: "approving",
    });
    const replay = reduceRoadmapPhaseDraftState(state, {
      type: "event",
      draft: structuredClone(draft),
    });
    expect(replay).toMatchObject({
      open: false,
      decision: "approving",
      announcement: state.announcement,
    });
  });

  it("does not resurrect a decided draft from delayed hydration", () => {
    const pending = reduceRoadmapPhaseDraftState(initialRoadmapPhaseDraftState, {
      type: "event",
      draft,
    });
    const decided = reduceRoadmapPhaseDraftState(pending, {
      type: "rejection-result",
      result: { status: "rejected" },
    });
    expect(
      reduceRoadmapPhaseDraftState(decided, {
        type: "hydrated",
        draft,
        startedAtEventVersion: pending.eventVersion,
      }),
    ).toBe(decided);
  });
  it("normalizes legacy drafts and rejects malformed current links", () => {
    const legacy = structuredClone(draft) as Record<string, unknown>;
    delete legacy.references;
    for (const phase of legacy.phases as Array<Record<string, unknown>>) delete phase.referenceIds;
    expect(normalizeRoadmapPhaseDraft(legacy)).toMatchObject({
      references: [],
      phases: [{ referenceIds: [] }],
    });
    expect(
      normalizeRoadmapPhaseDraft({
        ...draft,
        references: [],
        phases: [{ ...draft.phases[0], referenceIds: ["missing"] }],
      }),
    ).toBeNull();
  });
  it("ignores hydration that started before a newer event", () => {
    const eventState = reduceRoadmapPhaseDraftState(initialRoadmapPhaseDraftState, {
      type: "event",
      draft,
    });
    expect(
      reduceRoadmapPhaseDraftState(eventState, {
        type: "hydrated",
        draft: null,
        startedAtEventVersion: 0,
      }),
    ).toBe(eventState);
  });

  it("announces compact new drafts and preserves non-decision dismissal for review later", () => {
    const received = reduceRoadmapPhaseDraftState(initialRoadmapPhaseDraftState, {
      type: "event",
      draft,
    });
    expect(received).toMatchObject({ draft, open: false });
    const dismissed = reduceRoadmapPhaseDraftState(received, { type: "dismiss" });
    expect(dismissed).toMatchObject({ draft, open: false });
    expect(reduceRoadmapPhaseDraftState(dismissed, { type: "open" }).open).toBe(true);
  });

  it("keeps stale content visible and disables creation through draft status", () => {
    const received = reduceRoadmapPhaseDraftState(initialRoadmapPhaseDraftState, {
      type: "event",
      draft,
    });
    const stale = reduceRoadmapPhaseDraftState(received, {
      type: "approval-result",
      result: { status: "stale-revision", expectedRevision: 3, currentRevision: 4 },
    });
    expect(stale).toMatchObject({
      open: false,
      decision: "idle",
      draft: { id: "draft-1", status: "stale" },
    });
    expect(stale.announcement).toContain("fresh draft");
  });

  it("closes after a created result adopts the returned Notes revision", () => {
    const received = reduceRoadmapPhaseDraftState(initialRoadmapPhaseDraftState, {
      type: "event",
      draft,
    });
    const created = reduceRoadmapPhaseDraftState(received, {
      type: "approval-result",
      result: { status: "created", revision: 4, phaseIds: ["phase-1"] },
    });
    expect(created).toMatchObject({ draft: null, open: false, decision: "idle" });
    expect(created.announcement).toContain("Created 1 Roadmap phase");
  });

  it("clears immediately after rejection and tolerates a later null event", () => {
    let state = reduceRoadmapPhaseDraftState(initialRoadmapPhaseDraftState, {
      type: "event",
      draft,
    });
    state = reduceRoadmapPhaseDraftState(state, {
      type: "decision-started",
      decision: "rejecting",
    });
    state = reduceRoadmapPhaseDraftState(state, {
      type: "rejection-result",
      result: { status: "rejected" },
    });
    expect(state).toMatchObject({
      draft: null,
      open: false,
      decision: "idle",
      error: null,
      announcement: "Roadmap draft rejected.",
    });

    state = reduceRoadmapPhaseDraftState(state, { type: "event", draft: null });
    expect(state).toMatchObject({ draft: null, open: false, decision: "idle", error: null });
  });

  it.each(["approved", "rejected"] as const)(
    "clears an %s draft from either already-decided response path",
    (decision) => {
      const received = reduceRoadmapPhaseDraftState(initialRoadmapPhaseDraftState, {
        type: "event",
        draft,
      });
      const approval = reduceRoadmapPhaseDraftState(received, {
        type: "approval-result",
        result: { status: "already-decided", decision },
      });
      const rejection = reduceRoadmapPhaseDraftState(received, {
        type: "rejection-result",
        result: { status: "already-decided", decision },
      });

      for (const state of [approval, rejection]) {
        expect(state).toMatchObject({
          draft: null,
          open: false,
          decision: "idle",
          error: null,
        });
        expect(state.announcement).toContain(decision === "approved" ? "created" : "rejected");
      }
    },
  );

  it.each(["proposal-not-found", "proposal-project-mismatch"] as const)(
    "clears an unavailable draft after %s from either decision path",
    (status) => {
      const received = reduceRoadmapPhaseDraftState(initialRoadmapPhaseDraftState, {
        type: "event",
        draft,
      });
      const approval = reduceRoadmapPhaseDraftState(received, {
        type: "approval-result",
        result: { status },
      });
      const rejection = reduceRoadmapPhaseDraftState(received, {
        type: "rejection-result",
        result: { status },
      });

      for (const state of [approval, rejection]) {
        expect(state).toMatchObject({
          draft: null,
          open: false,
          decision: "idle",
          error: "This Roadmap draft is no longer available for this project.",
          announcement: "This Roadmap draft is no longer available for this project.",
        });
      }
    },
  );
});

const editDraft = {
  kind: "edit" as const,
  id: "draft-edit-1",
  projectKey: "/work",
  basedOnRevision: 3,
  createdAt: "2026-08-05T12:00:00.000Z",
  createdBySessionId: "session-1",
  summary: "Clarify the review phase",
  phaseId: "phase-1",
  phaseTitle: "Review UI",
  basedOnUpdatedAt: "2026-08-04T12:00:00.000Z",
  changes: [
    { field: "goal" as const, before: "", after: "Make the proposal legible." },
    {
      field: "doneWhen" as const,
      before: ["Titles are visible"],
      after: ["Titles are visible", "Criteria are visible"],
    },
  ],
  status: "pending" as const,
};

describe("Roadmap phase edit draft state", () => {
  it("passes valid edit drafts through and rejects malformed ones", () => {
    expect(normalizeRoadmapPhaseDraft(structuredClone(editDraft))).toEqual(editDraft);
    expect(normalizeRoadmapPhaseDraft({ ...editDraft, changes: [] })).toBeNull();
    expect(normalizeRoadmapPhaseDraft({ ...editDraft, references: [] })).toBeNull();
  });

  it("describes create and edit drafts for the review dock", () => {
    expect(describeRoadmapDraft(draft)).toEqual({
      label: "Roadmap draft",
      summary: "1 proposed phases · Approval required",
      triggerLabel: "Review Roadmap draft with 1 proposed phase",
      count: 1,
    });
    expect(describeRoadmapDraft(editDraft)).toEqual({
      label: "Roadmap phase edit",
      summary: "2 changed fields · Approval required",
      triggerLabel: "Review Roadmap phase edit with 2 changed fields",
      count: 2,
    });
    expect(
      describeRoadmapDraft({
        ...editDraft,
        changes: editDraft.changes.slice(0, 1),
        status: "stale",
      }),
    ).toMatchObject({ summary: "1 changed field · Out of date" });
  });

  it("announces edit-specific ready and stale states", () => {
    const received = reduceRoadmapPhaseDraftState(initialRoadmapPhaseDraftState, {
      type: "event",
      draft: editDraft,
    });
    expect(received.announcement).toBe("A Roadmap phase edit is ready for review.");
    const stale = reduceRoadmapPhaseDraftState(received, {
      type: "event",
      draft: { ...editDraft, status: "stale" },
    });
    expect(stale.announcement).toBe("Roadmap phase edit is out of date and cannot be applied.");
  });

  it("clears the draft after an edited result", () => {
    const received = reduceRoadmapPhaseDraftState(initialRoadmapPhaseDraftState, {
      type: "event",
      draft: editDraft,
    });
    const edited = reduceRoadmapPhaseDraftState(received, {
      type: "approval-result",
      result: { status: "edited", revision: 4, phaseId: "phase-1" },
    });
    expect(edited).toMatchObject({
      draft: null,
      open: false,
      decision: "idle",
      error: null,
      announcement: "Updated Roadmap phase.",
    });
  });

  it.each([
    [{ status: "phase-changed", phaseId: "phase-1" } as const, "changed after the edit"],
    [{ status: "phase-not-editable", phaseId: "phase-1", reason: "done" } as const, "now Done"],
    [
      { status: "phase-not-editable", phaseId: "phase-1", reason: "archived" } as const,
      "now archived",
    ],
    [{ status: "phase-not-editable", phaseId: "phase-1", reason: "deleted" } as const, "deleted"],
    [{ status: "stale-revision", expectedRevision: 3, currentRevision: 4 } as const, "fresh edit"],
  ])("keeps a %o edit visible as stale and says nothing was saved", (result, reason) => {
    const received = reduceRoadmapPhaseDraftState(initialRoadmapPhaseDraftState, {
      type: "event",
      draft: editDraft,
    });
    const stale = reduceRoadmapPhaseDraftState(received, { type: "approval-result", result });
    expect(stale).toMatchObject({
      decision: "idle",
      error: null,
      draft: { id: "draft-edit-1", kind: "edit", status: "stale" },
    });
    expect(stale.announcement).toContain(reason);
    expect(stale.announcement).toContain("Nothing was saved.");
  });

  it("announces edit-specific rejection", () => {
    const received = reduceRoadmapPhaseDraftState(initialRoadmapPhaseDraftState, {
      type: "event",
      draft: editDraft,
    });
    const rejected = reduceRoadmapPhaseDraftState(received, {
      type: "rejection-result",
      result: { status: "rejected" },
    });
    expect(rejected).toMatchObject({ draft: null, announcement: "Roadmap phase edit rejected." });
  });
});

const moveDraft = {
  kind: "move" as const,
  id: "draft-move-1",
  projectKey: "/work",
  basedOnRevision: 3,
  createdAt: "2026-08-05T12:00:00.000Z",
  createdBySessionId: "session-1",
  summary: "Do the last phase first",
  phaseId: "c",
  phaseTitle: "Phase c",
  position: "before" as const,
  targetPhaseId: "a",
  targetPhaseTitle: "Phase a",
  orderPreview: {
    before: [
      { phaseId: "a", title: "Phase a" },
      { phaseId: "c", title: "Phase c" },
    ],
    after: [
      { phaseId: "c", title: "Phase c" },
      { phaseId: "a", title: "Phase a" },
    ],
  },
  status: "pending" as const,
};

describe("Roadmap phase move draft state", () => {
  it("passes valid move drafts through, rejects malformed ones, and describes them", () => {
    expect(normalizeRoadmapPhaseDraft(moveDraft)).toEqual(moveDraft);
    expect(normalizeRoadmapPhaseDraft({ ...moveDraft, targetPhaseId: "c" })).toBeNull();
    expect(describeRoadmapDraft(moveDraft)).toEqual({
      label: "Roadmap phase move",
      summary: "Move Phase c · Approval required",
      triggerLabel: "Review Roadmap phase move for Phase c",
      count: 1,
    });
  });

  it("clears after a moved result and keeps a changed move visible as stale", () => {
    const received = reduceRoadmapPhaseDraftState(initialRoadmapPhaseDraftState, {
      type: "event",
      draft: moveDraft,
    });
    expect(received.announcement).toBe("A Roadmap phase move is ready for review.");
    expect(
      reduceRoadmapPhaseDraftState(received, {
        type: "approval-result",
        result: { status: "moved", revision: 4, phaseId: "c" },
      }),
    ).toMatchObject({ draft: null, open: false, announcement: "Moved Roadmap phase." });

    const stale = reduceRoadmapPhaseDraftState(received, {
      type: "approval-result",
      result: { status: "phase-changed", phaseId: "c" },
    });
    expect(stale).toMatchObject({ draft: { kind: "move", status: "stale" } });
    expect(stale.announcement).toContain("Roadmap order changed");
    expect(stale.announcement).toContain("Nothing was saved.");
    expect(
      reduceRoadmapPhaseDraftState(received, {
        type: "approval-result",
        result: { status: "phase-not-editable", phaseId: "c", reason: "done" },
      }).announcement,
    ).toBe("This phase is now Done, so it cannot be moved. Nothing was saved.");
  });

  it("announces move-specific rejection without saving", () => {
    const received = reduceRoadmapPhaseDraftState(initialRoadmapPhaseDraftState, {
      type: "event",
      draft: moveDraft,
    });
    expect(
      reduceRoadmapPhaseDraftState(received, {
        type: "rejection-result",
        result: { status: "rejected" },
      }),
    ).toMatchObject({ draft: null, announcement: "Roadmap phase move rejected." });
  });
});
