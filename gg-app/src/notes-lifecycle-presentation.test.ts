import { describe, expect, it } from "vitest";
import type { NotesPhase, NotesPhaseStatus } from "./notes-types";
import {
  NOTES_PHASE_STATUS_PRESENTATION,
  notesLifecyclePresentation,
  notesPhaseStatusLabel,
} from "./notes-lifecycle-presentation";

type PresentablePhase = Pick<NotesPhase, "status" | "lifecycleEvents" | "roadmapEvents">;

function phase(status: NotesPhaseStatus): PresentablePhase {
  return { status, lifecycleEvents: [], roadmapEvents: [] };
}

describe("notesLifecyclePresentation", () => {
  it.each([
    ["not-started", "Not started", "neutral", "Planning"],
    ["planning", "Planning", "neutral", "Planning"],
    ["waiting-for-approval", "Needs approval", "neutral", "Planning"],
    ["in-progress", "In progress", "active", "Implementation"],
    ["review", "In review", "active", "Review"],
    ["done", "Done", "positive", "Verification"],
    ["needs-attention", "Needs attention", "warning", "Implementation"],
    ["cancelled", "Cancelled", "neutral", "Implementation"],
  ] as const)(
    "projects %s into %s (%s tone) with %s as its stage",
    (status, state, tone, stage) => {
      expect(notesLifecyclePresentation(phase(status))).toEqual({ state, tone, stage });
    },
  );

  it("gives every stored status its own non-empty word from the one table", () => {
    const statuses = Object.keys(NOTES_PHASE_STATUS_PRESENTATION) as NotesPhaseStatus[];
    const labels = statuses.map((status) => notesPhaseStatusLabel(status));

    expect(statuses).toHaveLength(8);
    expect(labels.every((label) => label.trim().length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(statuses.length);
  });

  it("shows a reported blocker as Needs attention rather than a second status word", () => {
    const blocked = phase("needs-attention");
    const blocker =
      "The release account is missing; the release owner must provide account access.";
    blocked.roadmapEvents.push({
      type: "status-update",
      id: "blocked-report",
      actor: "gg-coder",
      transition: "blocked",
      progress: "Release is blocked by missing account access",
      blocker,
      requiredExternalAction: "Provide release account access",
      evidence: [],
      verification: null,
      verificationReason: null,
      verificationSession: null,
      statusOutcome: "applied",
      proposedReferences: [],
      timestamp: "2026-08-03T08:00:00.000Z",
    });

    expect(notesLifecyclePresentation(blocked)).toEqual({
      state: "Needs attention",
      tone: "warning",
      stage: "Implementation",
    });
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
      requiredExternalAction: null,
      evidence: [],
      verification: "passed",
      verificationReason: null,
      verificationSession: null,
      statusOutcome: "evidence-only",
      proposedReferences: [],
      timestamp: "2026-08-03T09:00:00.000Z",
    });

    expect(notesLifecyclePresentation(reviewing)).toEqual({
      state: "In review",
      tone: "active",
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
