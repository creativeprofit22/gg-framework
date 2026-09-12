import { describe, expect, it } from "vitest";
import {
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
