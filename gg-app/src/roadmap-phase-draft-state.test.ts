import { describe, expect, it } from "vitest";
import {
  initialRoadmapPhaseDraftState,
  reduceRoadmapPhaseDraftState,
} from "./roadmap-phase-draft-state";

const draft = {
  id: "draft-1",
  projectKey: "/work",
  basedOnRevision: 3,
  createdAt: "2026-08-05T12:00:00.000Z",
  createdBySessionId: "session-1",
  summary: "Create a clear review flow",
  phases: [
    {
      phaseId: "phase-1",
      title: "Review UI",
      goal: "Make the proposal legible.",
      doneWhen: ["Titles are visible", "Criteria are visible"],
      sourcePrompt: "Build the review UI.",
    },
  ],
  status: "pending" as const,
};

describe("Roadmap phase draft state", () => {
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

  it("opens new drafts and preserves non-decision dismissal for review later", () => {
    const received = reduceRoadmapPhaseDraftState(initialRoadmapPhaseDraftState, {
      type: "event",
      draft,
    });
    expect(received).toMatchObject({ draft, open: true });
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
      open: true,
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
