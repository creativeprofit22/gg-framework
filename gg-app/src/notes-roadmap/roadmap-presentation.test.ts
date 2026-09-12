import { describe, expect, it } from "vitest";
import type { NotesPhase, NotesRoadmapCompletionReview } from "../notes-types";
import {
  isRoadmapPhaseStartProtected,
  isRoadmapTopologyMutationBlocked,
  selectRoadmapAdvancement,
} from "./roadmap-presentation";

const NOW = "2026-08-10T12:00:00.000Z";

function phase(id: string, order: number): NotesPhase {
  return {
    id,
    title: id,
    goal: "goal",
    doneWhen: ["done"],
    order,
    status: "not-started",
    sourcePrompt: "prompt",
    referenceIds: [],
    session: null,
    reminder: null,
    attentionReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    archivedAt: null,
    overrides: { status: null, referenceIds: null },
    pendingAutomaticLifecycleTransition: null,
    lifecycleEvents: [],
    roadmapEvents: [],
  };
}

function completedWithLegacyCheckpoint(reviewer: "ken" | "ken-autopilot" = "ken"): NotesPhase {
  const source = phase("source", 0);
  source.status = "done";
  source.completedAt = NOW;
  const review: NotesRoadmapCompletionReview = {
    type: "completion-review",
    id: "review-1",
    reviewer,
    decision: "accepted",
    evidence: [],
    reason: null,
    implementationCheckpointId: "implementation-1",
    verificationStatusUpdateId: "verification-1",
    acceptsVerificationException: false,
    gateOutcome: "done",
    unmetGateCodes: [],
    timestamp: NOW,
  };
  source.roadmapEvents.push(review, {
    type: "phase-advancement-checkpoint",
    id: "checkpoint-1",
    completionReviewId: review.id,
    completedPhaseId: source.id,
    nextPhaseId: "next",
    reviewer,
    timestamp: NOW,
  });
  return source;
}

function completedWithDirectCheckpoint(): NotesPhase {
  const source = phase("source", 0);
  const session = { sessionId: "session-1", sessionPath: "/session-1" };
  source.status = "done";
  source.completedAt = NOW;
  source.session = session;
  source.roadmapEvents.push(
    {
      type: "status-update",
      id: "verification-1",
      actor: "gg-coder",
      transition: "done",
      progress: "Completion evidence recorded.",
      blocker: null,
      requiredExternalAction: null,
      evidence: ["pnpm test"],
      verification: "passed",
      verificationReason: null,
      verificationSession: session,
      statusOutcome: "completion-pending",
      proposedReferences: [],
      timestamp: NOW,
    },
    {
      type: "implementation-checkpoint",
      id: "implementation-1",
      session,
      planStepTotal: 1,
      completedPlanSteps: [1],
      runOutcome: "succeeded",
      verificationStatusUpdateId: "verification-1",
      timestamp: NOW,
    },
    {
      type: "phase-advancement-checkpoint",
      id: "checkpoint-1",
      completedPhaseId: source.id,
      nextPhaseId: "next",
      implementationCheckpointId: "implementation-1",
      verificationStatusUpdateId: "verification-1",
      timestamp: NOW,
    },
  );
  return source;
}

describe("selectRoadmapAdvancement", () => {
  it.each(["ken", "ken-autopilot"] as const)(
    "shows only a persisted unconfirmed %s checkpoint",
    (reviewer) => {
      expect(
        selectRoadmapAdvancement([completedWithLegacyCheckpoint(reviewer), phase("next", 1)]),
      ).toMatchObject({
        checkpoint: { id: "checkpoint-1", reviewer },
        completedPhase: { id: "source" },
        nextPhase: { id: "next" },
        ready: true,
        recoveryReason: null,
      });
    },
  );

  it("shows reviewer-free direct completion evidence", () => {
    expect(
      selectRoadmapAdvancement([completedWithDirectCheckpoint(), phase("next", 1)]),
    ).toMatchObject({
      checkpoint: {
        id: "checkpoint-1",
        implementationCheckpointId: "implementation-1",
        verificationStatusUpdateId: "verification-1",
      },
      ready: true,
      recoveryReason: null,
    });
  });

  it.each(["malformed", "later-untyped"] as const)(
    "does not gate explicit phase selection on %s historical certification",
    (kind) => {
      const source = completedWithDirectCheckpoint();
      const verification = source.roadmapEvents.find((event) => event.type === "status-update");
      const implementation = source.roadmapEvents.find(
        (event) => event.type === "implementation-checkpoint",
      );
      if (kind === "malformed") {
        if (verification?.type === "status-update") {
          verification.transition = "in-progress";
          verification.statusOutcome = "applied";
        }
        if (implementation?.type === "implementation-checkpoint") {
          implementation.completedPlanSteps = [];
        }
      } else if (verification?.type === "status-update") {
        source.roadmapEvents.splice(1, 0, {
          ...verification,
          id: "status-after-verification",
          transition: "in-progress",
          progress: "Work continued after verification.",
          evidence: [],
          verification: null,
          verificationSession: null,
          statusOutcome: "applied",
        });
      }

      expect(selectRoadmapAdvancement([source, phase("next", 1)])).toMatchObject({
        completedPhase: { id: source.id, status: "done" },
        nextPhase: { id: "next" },
        ready: true,
      });
    },
  );

  it("finds the unique eligible target before the completed source", () => {
    const target = phase("next", -1);

    expect(selectRoadmapAdvancement([completedWithDirectCheckpoint(), target])).toMatchObject({
      currentEligiblePhase: { id: "next" },
      ready: true,
      recoveryReason: null,
    });
    expect(isRoadmapPhaseStartProtected([completedWithDirectCheckpoint(), target], target.id)).toBe(
      true,
    );
  });

  it.each([
    ["equal", 1, 1],
    ["different", -1, 2],
  ])("treats %s-order eligible candidates as ambiguous", (_label, leftOrder, rightOrder) => {
    const result = selectRoadmapAdvancement([
      completedWithDirectCheckpoint(),
      phase("next", leftOrder),
      phase("other", rightOrder),
    ]);

    expect(result).toMatchObject({
      currentEligiblePhase: null,
      ready: false,
      recoveryReason: expect.stringContaining("before starting the recorded target"),
    });
    expect(
      selectRoadmapAdvancement([
        completedWithLegacyCheckpoint(),
        phase("next", leftOrder),
        phase("other", rightOrder),
      ])?.recoveryReason,
    ).toContain("before starting the reviewed target");
  });

  it("ignores bound and status-overridden phases when classifying the unique target", () => {
    const bound = phase("bound", -1);
    bound.session = { sessionId: "session-1", sessionPath: "/session-1" };
    const overridden = phase("overridden", 2);
    overridden.overrides.status = { value: "not-started", source: "user", updatedAt: NOW };

    expect(
      selectRoadmapAdvancement([
        bound,
        completedWithDirectCheckpoint(),
        overridden,
        phase("next", 3),
      ]),
    ).toMatchObject({
      currentEligiblePhase: { id: "next" },
      ready: true,
      recoveryReason: null,
    });
  });

  it("does not infer Start from a completion review without a checkpoint", () => {
    const source = completedWithLegacyCheckpoint();
    source.roadmapEvents = source.roadmapEvents.filter(
      (event) => event.type !== "phase-advancement-checkpoint",
    );
    expect(selectRoadmapAdvancement([source, phase("next", 1)])).toBeNull();
  });

  it("hides confirmed checkpoints and checkpoints with stale completion authority", () => {
    const confirmed = completedWithDirectCheckpoint();
    confirmed.roadmapEvents.push({
      type: "phase-advancement-confirmation",
      id: "confirmation-1",
      checkpointId: "checkpoint-1",
      nextPhaseId: "next",
      actor: "user",
      operationId: "operation-1",
      timestamp: NOW,
    });
    expect(selectRoadmapAdvancement([confirmed, phase("next", 1)])).toBeNull();

    const stale = completedWithDirectCheckpoint();
    stale.overrides.status = { value: "done", source: "user", updatedAt: NOW };
    expect(selectRoadmapAdvancement([stale, phase("next", 1)])).toBeNull();
  });

  it("explains when no automatic candidate remains", () => {
    const target = phase("next", 1);
    target.session = { sessionId: "session-1", sessionPath: "/session-1" };

    expect(selectRoadmapAdvancement([completedWithDirectCheckpoint(), target])).toMatchObject({
      currentEligiblePhase: null,
      ready: false,
      recoveryReason: expect.stringContaining("no longer an unbound automatic candidate"),
    });
  });

  it("keeps an archived or reordered target visible as a recoverable checkpoint", () => {
    const source = completedWithDirectCheckpoint();
    const target = phase("next", 1);
    target.archivedAt = NOW;
    const fallback = phase("fallback", 2);
    expect(selectRoadmapAdvancement([source, target, fallback])).toMatchObject({
      nextPhase: { id: "next" },
      currentEligiblePhase: { id: "fallback" },
      ready: false,
      recoveryReason: expect.stringContaining(
        "Restore the recorded candidate set before starting.",
      ),
    });
    expect(isRoadmapPhaseStartProtected([source, target, fallback], fallback.id)).toBe(true);
    expect(
      isRoadmapTopologyMutationBlocked([source, target, fallback], {
        type: "restore",
        phaseId: target.id,
      }),
    ).toBe(false);
  });

  it("blocks eligibility changes, but not order changes, for a ready checkpoint target", () => {
    const source = completedWithDirectCheckpoint();
    const target = phase("next", 1);
    const fallback = phase("fallback", 2);
    fallback.session = { sessionId: "session-1", sessionPath: "/session-1" };
    const phases = [source, target, fallback];
    expect(
      isRoadmapTopologyMutationBlocked(phases, {
        type: "archive",
        phaseId: target.id,
      }),
    ).toBe(true);
    expect(
      isRoadmapTopologyMutationBlocked(phases, {
        type: "move",
        phaseId: fallback.id,
        direction: "up",
      }),
    ).toBe(false);
    expect(
      isRoadmapTopologyMutationBlocked(phases, {
        type: "pause-status",
        phaseId: target.id,
      }),
    ).toBe(true);
  });
});
