import { describe, expect, it } from "vitest";
import type { NotesPhase, NotesRoadmapEvent } from "@kenkaiiii/gg-core/project-notes";
import {
  evaluateDirectPhaseCompletion,
  evaluateManualCompletionApproval,
} from "./project-notes-completion-policy.js";

const session = { sessionId: "session-1", sessionPath: "/sessions/1.jsonl" };
const otherSession = { sessionId: "session-2", sessionPath: "/sessions/2.jsonl" };

function verification(
  result: "passed" | "failed" | "exception-requested" = "passed",
  overrides: Partial<Extract<NotesRoadmapEvent, { type: "status-update" }>> = {},
): Extract<NotesRoadmapEvent, { type: "status-update" }> {
  return {
    type: "status-update",
    id: "completion-intent-1",
    actor: "gg-coder",
    transition: "done",
    progress: "Verification complete",
    blocker: null,
    requiredExternalAction: null,
    evidence: ["pnpm test exited successfully"],
    verification: result,
    verificationReason: result === "passed" ? null : "Verification did not pass",
    verificationSession: session,
    statusOutcome: "completion-pending",
    proposedReferences: [],
    timestamp: "2026-08-27T20:01:00.000Z",
    ...overrides,
  };
}

function checkpoint(
  overrides: Partial<Extract<NotesRoadmapEvent, { type: "implementation-checkpoint" }>> = {},
): Extract<NotesRoadmapEvent, { type: "implementation-checkpoint" }> {
  return {
    type: "implementation-checkpoint",
    id: "implementation-1",
    session,
    planStepTotal: 2,
    completedPlanSteps: [1, 2],
    runOutcome: "succeeded",
    verificationStatusUpdateId: "completion-intent-1",
    timestamp: "2026-08-27T20:02:00.000Z",
    ...overrides,
  };
}

function phase(events: NotesRoadmapEvent[], overrides: Partial<NotesPhase> = {}): NotesPhase {
  return {
    id: "phase-1",
    title: "Direct completion",
    goal: "Settle current evidence only",
    doneWhen: ["Evidence is current"],
    order: 0,
    status: "in-progress",
    sourcePrompt: "Implement direct completion",
    referenceIds: [],
    session,
    reminder: null,
    attentionReason: null,
    createdAt: "2026-08-27T19:00:00.000Z",
    updatedAt: "2026-08-27T20:02:00.000Z",
    completedAt: null,
    archivedAt: null,
    overrides: { status: null, referenceIds: null },
    pendingAutomaticLifecycleTransition: null,
    lifecycleEvents: [],
    roadmapEvents: events,
    ...overrides,
  };
}

function evaluate(candidate: NotesPhase, expectedSession = session) {
  return evaluateDirectPhaseCompletion({
    phase: candidate,
    expectedSession,
    implementationCheckpointId: "implementation-1",
    verificationStatusUpdateId: "completion-intent-1",
  });
}

describe("direct phase completion policy", () => {
  it("passes current linked implementation and verification evidence", () => {
    expect(evaluate(phase([verification(), checkpoint()]))).toMatchObject({
      gateOutcome: "done",
      unmetGateCodes: [],
      targetStatus: "done",
    });
  });

  it.each([
    [checkpoint({ runOutcome: "failed" }), "run-not-successful"],
    [checkpoint({ completedPlanSteps: [1] }), "incomplete-plan"],
    [checkpoint({ session: otherSession }), "stale-session"],
    [checkpoint({ verificationStatusUpdateId: "older" }), "stale-verification"],
  ] as const)("keeps invalid implementation evidence open: %s", (implementation, code) => {
    expect(evaluate(phase([verification(), implementation]))).toMatchObject({
      targetStatus: null,
      unmetGateCodes: expect.arrayContaining([code]),
    });
  });

  it("never reuses an older verification after a later run", () => {
    expect(
      evaluate(
        phase([
          verification(),
          checkpoint(),
          verification("passed", { id: "completion-intent-newer" }),
        ]),
      ),
    ).toMatchObject({
      targetStatus: null,
      unmetGateCodes: expect.arrayContaining(["stale-verification"]),
    });
  });

  it("fails closed for failed verification, attention, overrides, and stale sessions", () => {
    expect(evaluate(phase([verification("failed"), checkpoint()]))).toMatchObject({
      targetStatus: null,
      unmetGateCodes: expect.arrayContaining(["failed-verification"]),
    });
    expect(
      evaluate(
        phase([verification(), checkpoint()], {
          status: "needs-attention",
          lifecycleEvents: [
            {
              id: "attention-1",
              fromStatus: "in-progress",
              toStatus: "needs-attention",
              source: "agent",
              timestamp: "2026-08-27T20:03:00.000Z",
              reason: "Decision required",
              kind: "attention-question-opened",
            },
          ],
        }),
      ),
    ).toMatchObject({
      targetStatus: null,
      unmetGateCodes: expect.arrayContaining(["unresolved-attention"]),
    });
    expect(evaluate(phase([verification(), checkpoint()]), otherSession)).toMatchObject({
      targetStatus: null,
      unmetGateCodes: expect.arrayContaining(["stale-session"]),
    });
  });
});

describe("manual completion approval", () => {
  it("accepts a current verification exception as an explicit user escape hatch", () => {
    const exception = verification("exception-requested", {
      transition: "in-progress",
      statusOutcome: "applied",
    });
    expect(evaluateManualCompletionApproval(phase([exception, checkpoint()]), session)).toEqual({
      status: "eligible",
      implementationCheckpointId: "implementation-1",
      verificationStatusUpdateId: "completion-intent-1",
    });
  });

  it("still rejects failed runs and stale sessions", () => {
    expect(
      evaluateManualCompletionApproval(
        phase([verification(), checkpoint({ runOutcome: "failed" })]),
        session,
      ),
    ).toEqual({ status: "unmet-gate", code: "run-not-successful" });
    expect(
      evaluateManualCompletionApproval(phase([verification(), checkpoint()]), otherSession),
    ).toEqual({
      status: "unmet-gate",
      code: "stale-session",
    });
  });
});
