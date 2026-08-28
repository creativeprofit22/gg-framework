import type { ManualCompletionApprovalGateCode } from "@kenkaiiii/gg-core/manual-completion-approval-protocol";
import {
  classifyLegacyNotesLifecycleEvent,
  notesSessionLinksEqual,
  type NotesCompletionGateOutcome,
  type NotesCompletionUnmetGateCode,
  type NotesLifecycleEventKind,
  type NotesPhase,
  type NotesPhaseStatus,
  type NotesRoadmapImplementationCheckpoint,
  type NotesRoadmapStatusUpdate,
  type NotesSessionLink,
} from "@kenkaiiii/gg-core/project-notes";

export interface PhaseCompletionReviewDecision {
  decision: "accepted" | "rejected";
  acceptsVerificationException: boolean;
  reviewer: "ken" | "ken-autopilot";
  reason: string | null;
}

export interface PhaseCompletionEvaluation {
  gateOutcome: NotesCompletionGateOutcome;
  unmetGateCodes: NotesCompletionUnmetGateCode[];
  implementationCheckpointId: string | null;
  verificationStatusUpdateId: string | null;
  targetStatus: Extract<
    NotesPhaseStatus,
    "done" | "in-progress" | "review" | "needs-attention" | "waiting-for-approval"
  > | null;
  reason: string;
}

export type ManualCompletionApprovalEvaluation =
  | {
      status: "eligible";
      implementationCheckpointId: string;
      verificationStatusUpdateId: string;
    }
  | { status: "unmet-gate"; code: ManualCompletionApprovalGateCode };

export interface EvaluatePhaseCompletionInput {
  phase: NotesPhase;
  expectedSession: NotesSessionLink;
  review: PhaseCompletionReviewDecision;
}

export function evaluateManualCompletionApproval(
  phase: NotesPhase,
  expectedSession: NotesSessionLink,
): ManualCompletionApprovalEvaluation {
  if (phase.status === "done") return { status: "unmet-gate", code: "already-done" };
  if (phase.archivedAt !== null) return { status: "unmet-gate", code: "archived-phase" };
  if (phase.overrides.status !== null) return { status: "unmet-gate", code: "status-override" };
  if (phase.status !== "review") return { status: "unmet-gate", code: "inactive-phase" };
  const evaluation = evaluatePhaseCompletion({
    phase,
    expectedSession,
    review: {
      decision: "accepted",
      acceptsVerificationException: false,
      reviewer: "ken",
      reason: null,
    },
  });
  if (
    evaluation.targetStatus === "done" &&
    evaluation.implementationCheckpointId &&
    evaluation.verificationStatusUpdateId
  ) {
    return {
      status: "eligible",
      implementationCheckpointId: evaluation.implementationCheckpointId,
      verificationStatusUpdateId: evaluation.verificationStatusUpdateId,
    };
  }
  return {
    status: "unmet-gate",
    code: manualApprovalGateCode(evaluation.unmetGateCodes),
  };
}

/** Return the current typed exception event only when it belongs to the current
 * phase session and follows the latest rejected completion review. */
export function latestVerificationExceptionEventForReview(
  phase: NotesPhase | undefined,
): NotesRoadmapStatusUpdate | null {
  if (!phase?.session) return null;
  const rejectionIndex = latestRejectedReviewIndex(phase);
  const implementation = latestRoadmapEventAfter(
    phase,
    rejectionIndex,
    (event): event is NotesRoadmapImplementationCheckpoint =>
      event.type === "implementation-checkpoint",
  );
  const verification = latestVerificationForReviewRound(phase, rejectionIndex);
  if (
    verification?.verification !== "exception-requested" ||
    (implementation !== undefined &&
      phase.roadmapEvents.lastIndexOf(verification) <=
        phase.roadmapEvents.lastIndexOf(implementation)) ||
    !notesSessionLinksEqual(verification.verificationSession, phase.session)
  ) {
    return null;
  }
  return verification;
}

export function evaluatePhaseCompletion({
  phase,
  expectedSession,
  review,
}: EvaluatePhaseCompletionInput): PhaseCompletionEvaluation {
  const rejectionIndex = latestRejectedReviewIndex(phase);
  const implementation = latestRoadmapEventAfter(
    phase,
    rejectionIndex,
    (event): event is NotesRoadmapImplementationCheckpoint =>
      event.type === "implementation-checkpoint",
  );
  const verification = latestVerificationForReviewRound(phase, rejectionIndex);
  const implementationIndex = implementation ? phase.roadmapEvents.lastIndexOf(implementation) : -1;
  const verificationIndex = verification ? phase.roadmapEvents.lastIndexOf(verification) : -1;
  const unmet = new Set<NotesCompletionUnmetGateCode>();

  if (!notesSessionLinksEqual(phase.session, expectedSession)) unmet.add("stale-session");
  if (
    phase.archivedAt !== null ||
    ["not-started", "planning", "cancelled"].includes(phase.status)
  ) {
    unmet.add("inactive-phase");
  }

  if (!implementation) {
    unmet.add("missing-implementation");
  } else {
    if (!notesSessionLinksEqual(implementation.session, expectedSession))
      unmet.add("stale-session");
    if (implementation.runOutcome !== "succeeded") unmet.add("run-not-successful");
    if (!hasEveryPlanStep(implementation)) unmet.add("incomplete-plan");
  }

  if (!verification) {
    unmet.add("missing-verification");
  } else {
    if (!notesSessionLinksEqual(verification.verificationSession, expectedSession)) {
      unmet.add("stale-session");
    }
    if (implementation && verificationIndex <= implementationIndex) {
      unmet.add("stale-verification");
    }
    if (verification.verification === "failed") {
      unmet.add("failed-verification");
    } else if (
      verification.verification === "exception-requested" &&
      !review.acceptsVerificationException
    ) {
      unmet.add("verification-exception-not-accepted");
    }
  }

  if (hasUnresolvedLifecycleStatus(phase, "waiting-for-approval")) {
    unmet.add("unresolved-approval");
  }
  if (hasUnresolvedLifecycleStatus(phase, "needs-attention")) {
    unmet.add("unresolved-attention");
  }

  const evidence = {
    implementationCheckpointId: implementation?.id ?? null,
    verificationStatusUpdateId: verification?.id ?? null,
  };
  const unmetGateCodes = [...unmet];

  if (phase.overrides.status !== null) {
    return {
      ...evidence,
      gateOutcome: "manual-override",
      unmetGateCodes,
      targetStatus: null,
      reason: "Final review was recorded, but the user status override remains authoritative.",
    };
  }
  if (phase.status === "done") {
    return {
      ...evidence,
      gateOutcome: "done-terminal",
      unmetGateCodes,
      targetStatus: null,
      reason: "The phase is already Done; no additional completion transition was written.",
    };
  }
  if (hasUnresolvedLifecycleStatus(phase, "waiting-for-approval")) {
    return {
      ...evidence,
      gateOutcome: "waiting-for-approval",
      unmetGateCodes,
      targetStatus: "waiting-for-approval",
      reason: "Plan approval is still unresolved.",
    };
  }
  if (unmet.has("failed-verification") || unmet.has("unresolved-attention")) {
    return {
      ...evidence,
      gateOutcome: "needs-attention",
      unmetGateCodes,
      targetStatus: "needs-attention",
      reason: unmet.has("failed-verification")
        ? verification?.verificationReason || "Verification failed."
        : "A question or error still needs attention.",
    };
  }
  if (review.decision === "rejected") {
    return {
      ...evidence,
      gateOutcome: "review",
      unmetGateCodes,
      targetStatus: "in-progress",
      reason: review.reason || "Final review requested revisions.",
    };
  }
  if (unmetGateCodes.length > 0) {
    return {
      ...evidence,
      gateOutcome: "review",
      unmetGateCodes,
      targetStatus: "review",
      reason: completionRecoveryReason(unmetGateCodes),
    };
  }
  return {
    ...evidence,
    gateOutcome: "done",
    unmetGateCodes: [],
    targetStatus: "done",
    reason: `Final review accepted by ${review.reviewer === "ken" ? "Supah" : "Autopilot Supah"}.`,
  };
}

function latestRejectedReviewIndex(phase: NotesPhase): number {
  for (let index = phase.roadmapEvents.length - 1; index >= 0; index -= 1) {
    const event = phase.roadmapEvents[index]!;
    if (event.type === "completion-review" && event.decision === "rejected") return index;
  }
  return -1;
}

function latestVerificationForReviewRound(
  phase: NotesPhase,
  rejectionIndex = latestRejectedReviewIndex(phase),
): NotesRoadmapStatusUpdate | undefined {
  return latestRoadmapEventAfter(
    phase,
    rejectionIndex,
    (event): event is NotesRoadmapStatusUpdate =>
      event.type === "status-update" && event.verification !== null,
  );
}

function latestRoadmapEventAfter<T extends NotesPhase["roadmapEvents"][number]>(
  phase: NotesPhase,
  startIndex: number,
  predicate: (event: NotesPhase["roadmapEvents"][number]) => event is T,
): T | undefined {
  for (let index = phase.roadmapEvents.length - 1; index > startIndex; index -= 1) {
    const event = phase.roadmapEvents[index]!;
    if (predicate(event)) return event;
  }
  return undefined;
}

function hasEveryPlanStep(checkpoint: NotesRoadmapImplementationCheckpoint): boolean {
  if (
    checkpoint.planStepTotal <= 0 ||
    checkpoint.completedPlanSteps.length !== checkpoint.planStepTotal
  ) {
    return false;
  }
  return checkpoint.completedPlanSteps.every((step, index) => step === index + 1);
}

type LifecycleBlockerKind = Extract<
  NotesLifecycleEventKind,
  | "approval-opened"
  | "attention-question-opened"
  | "attention-runtime-opened"
  | "attention-tool-opened"
  | "attention-generic-opened"
>;

const ATTENTION_RESOLUTION_KINDS: Readonly<
  Record<Exclude<LifecycleBlockerKind, "approval-opened">, readonly NotesLifecycleEventKind[]>
> = {
  "attention-question-opened": ["attention-implementation-resolved"],
  "attention-runtime-opened": ["attention-implementation-resolved", "attention-review-resolved"],
  "attention-tool-opened": ["attention-implementation-resolved"],
  "attention-generic-opened": ["attention-implementation-resolved", "attention-review-resolved"],
};

function hasUnresolvedLifecycleStatus(
  phase: NotesPhase,
  status: "waiting-for-approval" | "needs-attention",
): boolean {
  let blockingIndex = -1;
  for (let index = phase.lifecycleEvents.length - 1; index >= 0; index -= 1) {
    if (phase.lifecycleEvents[index]!.toStatus === status) {
      blockingIndex = index;
      break;
    }
  }
  if (blockingIndex < 0) return phase.status === status;
  const blockingEvent = phase.lifecycleEvents[blockingIndex]!;
  const blockerKind = lifecycleEventKind(blockingEvent);
  if (status === "waiting-for-approval" && blockerKind !== "approval-opened") return true;
  if (status === "needs-attention" && !(blockerKind in ATTENTION_RESOLUTION_KINDS)) return true;

  const resolutionKinds: readonly NotesLifecycleEventKind[] =
    blockerKind === "approval-opened"
      ? ["approval-resolved"]
      : ATTENTION_RESOLUTION_KINDS[blockerKind as Exclude<LifecycleBlockerKind, "approval-opened">];
  const blockingTimestamp = Date.parse(blockingEvent.timestamp);
  const resolved = phase.lifecycleEvents
    .slice(blockingIndex + 1)
    .some(
      (event) =>
        Date.parse(event.timestamp) >= blockingTimestamp &&
        resolutionKinds.some((kind) => kind === lifecycleEventKind(event)),
    );
  return !resolved;
}

function lifecycleEventKind(event: NotesPhase["lifecycleEvents"][number]): NotesLifecycleEventKind {
  return event.kind ?? classifyLegacyNotesLifecycleEvent(event);
}

function manualApprovalGateCode(
  unmet: readonly NotesCompletionUnmetGateCode[],
): ManualCompletionApprovalGateCode {
  if (unmet.includes("stale-session")) return "stale-session";
  if (unmet.includes("unresolved-approval")) return "unresolved-approval";
  if (unmet.includes("unresolved-attention")) return "unresolved-attention";
  if (unmet.includes("inactive-phase")) return "inactive-phase";
  if (unmet.includes("missing-implementation")) return "missing-implementation";
  if (unmet.includes("run-not-successful")) return "run-not-successful";
  if (unmet.includes("incomplete-plan")) return "incomplete-plan";
  if (unmet.includes("missing-verification")) return "missing-verification";
  if (unmet.includes("stale-verification")) return "stale-verification";
  if (unmet.includes("failed-verification")) return "failed-verification";
  if (unmet.includes("verification-exception-not-accepted")) return "verification-exception";
  return "evidence-mismatch";
}

function completionRecoveryReason(unmet: NotesCompletionUnmetGateCode[]): string {
  if (unmet.includes("missing-implementation"))
    return "Implementation evidence has not been recorded.";
  if (unmet.includes("stale-session"))
    return "Completion evidence belongs to a different phase session.";
  if (unmet.includes("run-not-successful"))
    return "The implementation run did not settle successfully.";
  if (unmet.includes("incomplete-plan")) return "Not every canonical plan step is complete.";
  if (unmet.includes("missing-verification"))
    return "Typed verification evidence has not been recorded.";
  if (unmet.includes("stale-verification"))
    return "Verification predates the latest implementation checkpoint.";
  if (unmet.includes("verification-exception-not-accepted")) {
    return "The verification exception still needs reviewer acceptance.";
  }
  if (unmet.includes("inactive-phase")) return "The phase is not active for automatic completion.";
  return "Completion evidence is incomplete.";
}
