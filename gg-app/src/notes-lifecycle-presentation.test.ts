import { describe, expect, it } from "vitest";
import type { NotesPhase, NotesPhaseStatus } from "./notes-types";
import { notesLifecyclePresentation } from "./notes-lifecycle-presentation";

type PresentablePhase = Pick<NotesPhase, "status" | "lifecycleEvents" | "roadmapEvents">;

function phase(status: NotesPhaseStatus): PresentablePhase {
  return { status, lifecycleEvents: [], roadmapEvents: [] };
}

describe("notesLifecyclePresentation", () => {
  it.each([
    ["not-started", "Ready", "Planning"],
    ["planning", "Working", "Planning"],
    ["waiting-for-approval", "Needs you", "Planning"],
    ["in-progress", "Working", "Implementation"],
    ["review", "Working", "Review"],
    ["done", "Done", "Verification"],
    ["needs-attention", "Needs you", "Implementation"],
    ["cancelled", "Needs you", "Implementation"],
  ] as const)("projects %s into %s with %s as its stage", (status, state, stage) => {
    expect(notesLifecyclePresentation(phase(status))).toEqual({ state, stage });
  });

  it("shows verification from typed roadmap evidence", () => {
    const reviewing = phase("review");
    reviewing.roadmapEvents.push({
      type: "status-update",
      id: "report-1",
      actor: "gg-coder",
      transition: "review",
      progress: "Verification complete",
      blocker: null,
      evidence: [],
      verification: "passed",
      verificationReason: null,
      verificationSession: null,
      statusOutcome: "evidence-only",
      proposedReferences: [],
      timestamp: "2026-08-03T09:00:00.000Z",
    });

    expect(notesLifecyclePresentation(reviewing)).toEqual({
      state: "Working",
      stage: "Verification",
    });
  });

  it("does not treat lifecycle reason copy as a stage protocol", () => {
    const reviewing = phase("review");
    reviewing.lifecycleEvents.push({
      id: "event-1",
      fromStatus: "in-progress",
      toStatus: "review",
      source: "agent",
      timestamp: "2026-08-03T09:00:00.000Z",
      reason: "Implementation verification started",
      kind: "other",
    });

    expect(notesLifecyclePresentation(reviewing).stage).toBe("Review");
  });
});
