import { describe, expect, it } from "vitest";
import type { NotesPhase, NotesRoadmapEvent } from "@kenkaiiii/gg-core/project-notes";
import { evaluateManualCompletionApproval } from "./project-notes-completion-policy.js";

const session = { sessionId: "session-1", sessionPath: "/sessions/1.jsonl" };
const otherSession = { sessionId: "session-2", sessionPath: "/sessions/2.jsonl" };

function checkpoint(
  overrides: Partial<Extract<NotesRoadmapEvent, { type: "implementation-checkpoint" }>> = {},
): Extract<NotesRoadmapEvent, { type: "implementation-checkpoint" }> {
  return {
    type: "implementation-checkpoint",
    id: "implementation-1",
    session,
    planStepTotal: 1,
    completedPlanSteps: [1],
    runOutcome: "succeeded",
    timestamp: "2026-08-27T20:00:00.000Z",
    ...overrides,
  };
}

function verification(
  result: "passed" | "failed" | "exception-requested" = "passed",
  overrides: Partial<Extract<NotesRoadmapEvent, { type: "status-update" }>> = {},
): Extract<NotesRoadmapEvent, { type: "status-update" }> {
  return {
    type: "status-update",
    id: `verification-${result}`,
    actor: "gg-coder",
    transition: "review",
    progress: "Verification complete",
    blocker: null,
    requiredExternalAction: null,
    evidence: ["pnpm test"],
    verification: result,
    verificationReason: result === "passed" ? null : "Verification did not pass",
    verificationSession: session,
    statusOutcome: "applied",
    proposedReferences: [],
    timestamp: "2026-08-27T20:01:00.000Z",
    ...overrides,
  };
}

function rejection(): Extract<NotesRoadmapEvent, { type: "completion-review" }> {
  return {
    type: "completion-review",
    id: "review-rejected",
    reviewer: "ken-autopilot",
    decision: "rejected",
    evidence: [],
    reason: "Revise",
    implementationCheckpointId: "implementation-1",
    verificationStatusUpdateId: "verification-passed",
    acceptsVerificationException: false,
    gateOutcome: "review",
    unmetGateCodes: [],
    timestamp: "2026-08-27T20:02:00.000Z",
  };
}

function phase(events: NotesRoadmapEvent[]): NotesPhase {
  return {
    id: "phase-1",
    title: "Manual approval",
    goal: "Approve current evidence only",
    doneWhen: ["Evidence is current"],
    order: 0,
    status: "review",
    sourcePrompt: "Implement manual approval",
    referenceIds: [],
    session,
    reminder: null,
    attentionReason: null,
    createdAt: "2026-08-27T19:00:00.000Z",
    updatedAt: "2026-08-27T20:01:00.000Z",
    completedAt: null,
    archivedAt: null,
    overrides: { status: null, referenceIds: null },
    pendingAutomaticLifecycleTransition: null,
    lifecycleEvents: [],
    roadmapEvents: events,
  };
}

describe("manual completion approval policy", () => {
  it("accepts only current passed verification after current implementation", () => {
    expect(evaluateManualCompletionApproval(phase([checkpoint(), verification()]), session)).toEqual({
      status: "eligible",
      implementationCheckpointId: "implementation-1",
      verificationStatusUpdateId: "verification-passed",
    });
  });

  it("requires the phase to be in review", () => {
    expect(
      evaluateManualCompletionApproval(
        { ...phase([checkpoint(), verification()]), status: "in-progress" },
        session,
      ),
    ).toEqual({ status: "unmet-gate", code: "inactive-phase" });
    expect(evaluateManualCompletionApproval(phase([checkpoint(), verification()]), session)).toEqual({
      status: "eligible",
      implementationCheckpointId: "implementation-1",
      verificationStatusUpdateId: "verification-passed",
    });
  });

  it.each([
    [phase([verification()]), "missing-implementation"],
    [phase([checkpoint()]), "missing-verification"],
    [phase([checkpoint(), verification("failed")]), "failed-verification"],
    [phase([checkpoint(), verification("exception-requested")]), "verification-exception"],
    [phase([verification(), checkpoint()]), "stale-verification"],
    [
      phase([checkpoint({ session: otherSession }), verification("passed", { verificationSession: otherSession })]),
      "stale-session",
    ],
  ] as const)("rejects %s evidence with %s", (candidate, code) => {
    expect(evaluateManualCompletionApproval(candidate, session)).toEqual({
      status: "unmet-gate",
      code,
    });
  });

  it("requires fresh implementation and verification after rejection", () => {
    expect(
      evaluateManualCompletionApproval(
        phase([checkpoint(), verification(), rejection(), checkpoint({ id: "implementation-2" })]),
        session,
      ),
    ).toEqual({ status: "unmet-gate", code: "missing-verification" });
    expect(
      evaluateManualCompletionApproval(
        phase([
          checkpoint(),
          verification(),
          rejection(),
          checkpoint({ id: "implementation-2" }),
          verification("passed", { id: "verification-2" }),
        ]),
        session,
      ),
    ).toEqual({
      status: "eligible",
      implementationCheckpointId: "implementation-2",
      verificationStatusUpdateId: "verification-2",
    });
  });

  it("rejects archived, done, and status-overridden phases", () => {
    expect(
      evaluateManualCompletionApproval({ ...phase([checkpoint(), verification()]), archivedAt: "2026-08-27T21:00:00.000Z" }, session),
    ).toEqual({ status: "unmet-gate", code: "archived-phase" });
    expect(
      evaluateManualCompletionApproval({ ...phase([checkpoint(), verification()]), status: "done" }, session),
    ).toEqual({ status: "unmet-gate", code: "already-done" });
    expect(
      evaluateManualCompletionApproval(
        {
          ...phase([checkpoint(), verification()]),
          overrides: {
            status: { value: "review", source: "user", updatedAt: "2026-08-27T21:00:00.000Z" },
            referenceIds: null,
          },
        },
        session,
      ),
    ).toEqual({ status: "unmet-gate", code: "status-override" });
  });
});
