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

function completedWithCheckpoint(reviewer: "ken" | "ken-autopilot" = "ken"): NotesPhase {
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

describe("selectRoadmapAdvancement", () => {
  it.each(["ken", "ken-autopilot"] as const)(
    "shows only a persisted unconfirmed %s checkpoint",
    (reviewer) => {
      expect(
        selectRoadmapAdvancement([completedWithCheckpoint(reviewer), phase("next", 1)]),
      ).toMatchObject({
        checkpoint: { id: "checkpoint-1", reviewer },
        completedPhase: { id: "source" },
        nextPhase: { id: "next" },
        ready: true,
        recoveryReason: null,
      });
    },
  );

  it("does not infer Start from a completion review without a checkpoint", () => {
    const source = completedWithCheckpoint();
    source.roadmapEvents = source.roadmapEvents.filter(
      (event) => event.type !== "phase-advancement-checkpoint",
    );
    expect(selectRoadmapAdvancement([source, phase("next", 1)])).toBeNull();
  });

  it("hides confirmed checkpoints and checkpoints with stale completion authority", () => {
    const confirmed = completedWithCheckpoint();
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

    const stale = completedWithCheckpoint();
    stale.overrides.status = { value: "done", source: "user", updatedAt: NOW };
    expect(selectRoadmapAdvancement([stale, phase("next", 1)])).toBeNull();
  });

  it("keeps an archived or reordered target visible as a recoverable checkpoint", () => {
    const source = completedWithCheckpoint();
    const target = phase("next", 1);
    target.archivedAt = NOW;
    const fallback = phase("fallback", 2);
    expect(selectRoadmapAdvancement([source, target, fallback])).toMatchObject({
      nextPhase: { id: "next" },
      currentEligiblePhase: { id: "fallback" },
      ready: false,
      recoveryReason: expect.stringContaining("Restore next"),
    });
    expect(isRoadmapPhaseStartProtected([source, target, fallback], fallback.id)).toBe(true);
    expect(
      isRoadmapTopologyMutationBlocked([source, target, fallback], {
        type: "restore",
        phaseId: target.id,
      }),
    ).toBe(false);
  });

  it("blocks topology changes that replace a ready checkpoint target", () => {
    const source = completedWithCheckpoint();
    const target = phase("next", 1);
    const fallback = phase("fallback", 2);
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
    ).toBe(true);
    expect(
      isRoadmapTopologyMutationBlocked(phases, {
        type: "pause-status",
        phaseId: target.id,
      }),
    ).toBe(true);
  });
});
