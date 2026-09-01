import type { ManualCompletionApprovalGateCode } from "@kenkaiiii/gg-core/manual-completion-approval-protocol";
import {
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

export interface EvaluateDirectPhaseCompletionInput {
  phase: NotesPhase;
  expectedSession: NotesSessionLink;
  implementationCheckpointId: string;
  verificationStatusUpdateId: string;
}

export function evaluateManualCompletionApproval(
  phase: NotesPhase,
  expectedSession: NotesSessionLink,
): ManualCompletionApprovalEvaluation {
  if (phase.status === "done") return { status: "unmet-gate", code: "already-done" };
  if (phase.archivedAt !== null) return { status: "unmet-gate", code: "archived-phase" };
  if (phase.overrides.status !== null) return { status: "unmet-gate", code: "status-override" };
  if (["not-started", "planning", "cancelled"].includes(phase.status)) {
    return { status: "unmet-gate", code: "inactive-phase" };
  }
  const implementation = latestImplementationCheckpoint(phase);
  if (!implementation) return { status: "unmet-gate", code: "missing-implementation" };
  if (!notesSessionLinksEqual(phase.session, expectedSession)) {
    return { status: "unmet-gate", code: "stale-session" };
  }
  if (!notesSessionLinksEqual(implementation.session, expectedSession)) {
    return { status: "unmet-gate", code: "stale-session" };
  }
  if (implementation.runOutcome !== "succeeded") {
    return { status: "unmet-gate", code: "run-not-successful" };
  }
  if (!hasEveryPlanStep(implementation)) {
    return { status: "unmet-gate", code: "incomplete-plan" };
  }
  const verification = verificationForImplementation(phase, implementation);
  if (!verification) return { status: "unmet-gate", code: "missing-verification" };
  if (!notesSessionLinksEqual(verification.verificationSession, expectedSession)) {
    return { status: "unmet-gate", code: "stale-session" };
  }
  if (verification.verification === "failed") {
    return { status: "unmet-gate", code: "failed-verification" };
  }
  if (verification.verification === null) {
    return { status: "unmet-gate", code: "missing-verification" };
  }
  return {
    status: "eligible",
    implementationCheckpointId: implementation.id,
    verificationStatusUpdateId: verification.id,
  };
}

export function evaluateDirectPhaseCompletion({
  phase,
  expectedSession,
  implementationCheckpointId,
  verificationStatusUpdateId,
}: EvaluateDirectPhaseCompletionInput): PhaseCompletionEvaluation {
  const implementation = phase.roadmapEvents.find(
    (event): event is NotesRoadmapImplementationCheckpoint =>
      event.type === "implementation-checkpoint" && event.id === implementationCheckpointId,
  );
  const verification = phase.roadmapEvents.find(
    (event): event is NotesRoadmapStatusUpdate =>
      event.type === "status-update" && event.id === verificationStatusUpdateId,
  );
  const latestImplementation = latestImplementationCheckpoint(phase);
  const latestVerification = latestTypedVerification(phase);
  const unmet = new Set<NotesCompletionUnmetGateCode>();

  if (phase.execution === undefined && !notesSessionLinksEqual(phase.session, expectedSession)) {
    unmet.add("stale-session");
  }
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
    if (
      implementation.verificationStatusUpdateId !== verificationStatusUpdateId ||
      latestImplementation?.id !== implementation.id
    ) {
      unmet.add("stale-verification");
    }
  }
  if (!verification) {
    unmet.add("missing-verification");
  } else {
    if (!notesSessionLinksEqual(verification.verificationSession, expectedSession)) {
      unmet.add("stale-session");
    }
    if (
      verification.actor !== "gg-coder" ||
      verification.transition !== "done" ||
      verification.statusOutcome !== "completion-pending" ||
      latestVerification?.id !== verification.id
    ) {
      unmet.add("stale-verification");
    }
    if (verification.verification === "failed") unmet.add("failed-verification");
    if (verification.verification !== "passed") {
      unmet.add("verification-exception-not-accepted");
    }
  }
  if (hasUnresolvedLifecycleStatus(phase, "waiting-for-approval")) {
    unmet.add("unresolved-approval");
  }
  if (hasUnresolvedLifecycleStatus(phase, "needs-attention")) {
    unmet.add("unresolved-attention");
  }

  const evidence = { implementationCheckpointId, verificationStatusUpdateId };
  const unmetGateCodes = [...unmet];
  if (phase.overrides.status !== null) {
    return {
      ...evidence,
      gateOutcome: "manual-override",
      unmetGateCodes,
      targetStatus: null,
      reason: "The user status override remains authoritative.",
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
  if (unmetGateCodes.length > 0) {
    return {
      ...evidence,
      gateOutcome: hasUnresolvedLifecycleStatus(phase, "waiting-for-approval")
        ? "waiting-for-approval"
        : unmet.has("failed-verification") || unmet.has("unresolved-attention")
          ? "needs-attention"
          : "review",
      unmetGateCodes,
      targetStatus: null,
      reason: completionRecoveryReason(unmetGateCodes),
    };
  }
  return {
    ...evidence,
    gateOutcome: "done",
    unmetGateCodes: [],
    targetStatus: "done",
    reason:
      "Current-session implementation and verification evidence passed every completion gate.",
  };
}

function latestImplementationCheckpoint(
  phase: NotesPhase,
): NotesRoadmapImplementationCheckpoint | undefined {
  return [...phase.roadmapEvents]
    .reverse()
    .find(
      (event): event is NotesRoadmapImplementationCheckpoint =>
        event.type === "implementation-checkpoint",
    );
}

function latestTypedVerification(phase: NotesPhase): NotesRoadmapStatusUpdate | undefined {
  return [...phase.roadmapEvents]
    .reverse()
    .find(
      (event): event is NotesRoadmapStatusUpdate =>
        event.type === "status-update" && event.verification !== null,
    );
}

function verificationForImplementation(
  phase: NotesPhase,
  implementation: NotesRoadmapImplementationCheckpoint,
): NotesRoadmapStatusUpdate | undefined {
  if (implementation.verificationStatusUpdateId) {
    return phase.roadmapEvents.find(
      (event): event is NotesRoadmapStatusUpdate =>
        event.type === "status-update" && event.id === implementation.verificationStatusUpdateId,
    );
  }
  const implementationIndex = phase.roadmapEvents.indexOf(implementation);
  return phase.roadmapEvents
    .slice(implementationIndex + 1)
    .reverse()
    .find(
      (event): event is NotesRoadmapStatusUpdate =>
        event.type === "status-update" && event.verification !== null,
    );
}

function hasEveryPlanStep(checkpoint: NotesRoadmapImplementationCheckpoint): boolean {
  return (
    checkpoint.planStepTotal > 0 &&
    checkpoint.completedPlanSteps.length === checkpoint.planStepTotal &&
    checkpoint.completedPlanSteps.every((step, index) => step === index + 1)
  );
}

function hasUnresolvedLifecycleStatus(
  phase: NotesPhase,
  status: Extract<NotesPhaseStatus, "waiting-for-approval" | "needs-attention">,
): boolean {
  const lastStatusEvent = [...phase.lifecycleEvents]
    .reverse()
    .find((event) => event.toStatus !== null);
  return lastStatusEvent?.toStatus === status;
}

function completionRecoveryReason(unmet: NotesCompletionUnmetGateCode[]): string {
  if (unmet.includes("missing-implementation")) return "Implementation evidence is missing.";
  if (unmet.includes("run-not-successful")) return "The owning run did not succeed.";
  if (unmet.includes("incomplete-plan")) return "Canonical plan steps are incomplete.";
  if (unmet.includes("missing-verification")) return "Typed verification evidence is missing.";
  if (unmet.includes("stale-session")) return "Evidence belongs to another phase session.";
  if (unmet.includes("stale-verification")) return "Verification is not current for this run.";
  if (unmet.includes("unresolved-approval")) return "Plan approval is still unresolved.";
  if (unmet.includes("unresolved-attention")) return "A question or error still needs attention.";
  if (unmet.includes("failed-verification")) return "Verification failed.";
  return "Completion gates remain unmet.";
}

export function lifecycleEventKindForStatus(status: NotesPhaseStatus): NotesLifecycleEventKind {
  return status === "waiting-for-approval"
    ? "approval-opened"
    : status === "needs-attention"
      ? "attention-generic-opened"
      : "other";
}
