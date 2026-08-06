import { describe, expect, it } from "vitest";
import type { NotesPhase, NotesSessionLink } from "@kenkaiiii/gg-core/project-notes";
import {
  evaluateActivePhaseReviewReadiness,
  isActivePhaseReadyForReview,
} from "./active-phase-verification.js";

const session: NotesSessionLink = {
  sessionId: "session-active",
  sessionPath: "/tmp/session-active.jsonl",
};

function reviewPhase(overrides: Partial<NotesPhase> = {}): NotesPhase {
  return {
    id: "phase-active",
    title: "Verify handoff",
    goal: "Hand off only verified work",
    doneWhen: ["Tests pass", "Build passes"],
    order: 0,
    status: "review",
    sourcePrompt: "Implement this phase",
    referenceIds: [],
    session,
    reminder: null,
    attentionReason: null,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:01:00.000Z",
    completedAt: null,
    archivedAt: null,
    overrides: { status: null, referenceIds: null },
    pendingAutomaticLifecycleTransition: null,
    lifecycleEvents: [],
    roadmapEvents: [
      {
        type: "status-update",
        id: "verification-pass",
        actor: "gg-coder",
        transition: "review",
        progress: "Completion checks passed",
        blocker: null,
        requiredExternalAction: null,
        evidence: ["pnpm test: passed", "pnpm build: passed"],
        verification: "passed",
        verificationReason: null,
        verificationSession: session,
        statusOutcome: "applied",
        proposedReferences: [],
        timestamp: "2026-08-05T00:01:00.000Z",
      },
    ],
    ...overrides,
  };
}

describe("active phase review readiness", () => {
  it("accepts passed verification with one ordered evidence item per criterion", () => {
    expect(
      evaluateActivePhaseReviewReadiness({
        doneWhen: ["Tests pass", "Build passes"],
        evidence: ["pnpm test: passed", "pnpm build: passed"],
        verification: "passed",
      }),
    ).toEqual({
      ready: true,
      reason: null,
      criteria: [
        { criterion: "Tests pass", evidence: "pnpm test: passed" },
        { criterion: "Build passes", evidence: "pnpm build: passed" },
      ],
    });
  });

  it("rejects failed verification even when every criterion has evidence", () => {
    expect(
      evaluateActivePhaseReviewReadiness({
        doneWhen: ["Tests pass"],
        evidence: ["pnpm test: one failure"],
        verification: "failed",
      }),
    ).toMatchObject({ ready: false, reason: "Review requires a passed verification result." });
  });

  it("rejects missing or unmatched evidence", () => {
    expect(
      evaluateActivePhaseReviewReadiness({
        doneWhen: ["Tests pass", "Build passes"],
        evidence: ["pnpm test: passed"],
        verification: "passed",
      }),
    ).toMatchObject({ ready: false });
    expect(
      evaluateActivePhaseReviewReadiness({
        doneWhen: ["Tests pass"],
        evidence: ["pnpm test: passed", "unmatched evidence"],
        verification: "passed",
      }),
    ).toMatchObject({ ready: false });
  });

  it("requires a review phase and the exact bound verification session", () => {
    expect(isActivePhaseReadyForReview(reviewPhase(), session)).toBe(true);
    expect(isActivePhaseReadyForReview(reviewPhase({ status: "in-progress" }), session)).toBe(
      false,
    );
    expect(
      isActivePhaseReadyForReview(reviewPhase(), {
        sessionId: "stale-session",
        sessionPath: "/tmp/stale.jsonl",
      }),
    ).toBe(false);
  });
});
