import type { AutopilotVerdict } from "./core/autopilot-verdict.js";
import type { KenVerificationException } from "./core/ken-context.js";
import type {
  NotesCompletionGateOutcome,
  NotesCompletionUnmetGateCode,
  NotesPhase,
  NotesPhaseStatus,
  NotesRoadmapCompletionReview,
  NotesRoadmapImplementationCheckpoint,
  NotesRoadmapStatusUpdate,
  ProjectNotesCompletionReviewOutcome,
  ProjectNotesCompletionReviewRequest,
  ProjectNotesImplementationCheckpointOutcome,
  ProjectNotesImplementationCheckpointRequest,
  ProjectNotesSnapshot,
  NotesSessionLink,
} from "./project-notes-repository.js";

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
    "done" | "review" | "needs-attention" | "waiting-for-approval"
  > | null;
  reason: string;
}

export interface EvaluatePhaseCompletionInput {
  phase: NotesPhase;
  expectedSession: NotesSessionLink;
  review: PhaseCompletionReviewDecision;
}

/** Return the current typed exception only when it belongs to the current
 * phase session and follows the latest rejected completion review. */
export function latestVerificationExceptionForReview(
  phase: NotesPhase | undefined,
): KenVerificationException | null {
  if (!phase?.session) return null;
  const rejectionIndex = latestRejectedReviewIndex(phase);
  const verification = latestRoadmapEventAfter(
    phase,
    rejectionIndex,
    (event): event is NotesRoadmapStatusUpdate =>
      event.type === "status-update" && event.verification !== null,
  );
  if (
    verification?.verification !== "exception-requested" ||
    !sameSession(verification.verificationSession, phase.session)
  ) {
    return null;
  }
  return {
    id: verification.id,
    requesterActor: verification.actor,
    reason: verification.verificationReason,
    timestamp: verification.timestamp,
    evidence: [...verification.evidence],
  };
}

/** An ALL_CLEAR accepts an exception only by naming the exact current request. */
export function autopilotVerdictAcceptsVerificationException(
  verdict: Extract<AutopilotVerdict, { kind: "all_clear" }>,
  currentException: KenVerificationException | null,
): boolean {
  return (
    currentException !== null && verdict.acceptedVerificationExceptionId === currentException.id
  );
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
  const verification = latestRoadmapEventAfter(
    phase,
    rejectionIndex,
    (event): event is NotesRoadmapStatusUpdate =>
      event.type === "status-update" && event.verification !== null,
  );
  const unmet = new Set<NotesCompletionUnmetGateCode>();

  if (!sameSession(phase.session, expectedSession)) unmet.add("stale-session");
  if (
    phase.archivedAt !== null ||
    ["not-started", "planning", "cancelled"].includes(phase.status)
  ) {
    unmet.add("inactive-phase");
  }

  if (!implementation) {
    unmet.add("missing-implementation");
  } else {
    if (!sameSession(implementation.session, expectedSession)) unmet.add("stale-session");
    if (implementation.runOutcome !== "succeeded") unmet.add("run-not-successful");
    if (!hasEveryPlanStep(implementation)) unmet.add("incomplete-plan");
  }

  if (!verification) {
    unmet.add("missing-verification");
  } else {
    if (!sameSession(verification.verificationSession, expectedSession)) {
      unmet.add("stale-session");
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
  if (unmet.has("unresolved-approval")) {
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
      targetStatus: "review",
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
    reason: `Final review accepted by ${review.reviewer === "ken" ? "Ken" : "Autopilot Ken"}.`,
  };
}

function latestRejectedReviewIndex(phase: NotesPhase): number {
  for (let index = phase.roadmapEvents.length - 1; index >= 0; index -= 1) {
    const event = phase.roadmapEvents[index]!;
    if (event.type === "completion-review" && event.decision === "rejected") return index;
  }
  return -1;
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

function sameSession(current: NotesSessionLink | null, expected: NotesSessionLink): boolean {
  return (
    current !== null &&
    current.sessionId === expected.sessionId &&
    current.sessionPath === expected.sessionPath
  );
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

type LifecycleBlockerKind = "approval" | "question" | "runtime" | "tool" | "attention";

interface LifecycleResolutionRule {
  toStatus: "in-progress" | "review";
  source: "user" | "session" | "agent";
  reason: string;
}

const APPROVAL_RESOLUTION_RULES: readonly LifecycleResolutionRule[] = [
  { toStatus: "in-progress", source: "user", reason: "Plan approved by user" },
  { toStatus: "in-progress", source: "agent", reason: "Plan approved by Autopilot" },
];

const IMPLEMENTATION_RESOLUTION_RULES: readonly LifecycleResolutionRule[] = [
  { toStatus: "in-progress", source: "session", reason: "Implementation run started" },
  { toStatus: "in-progress", source: "session", reason: "Implementation session resumed" },
];

const ATTENTION_RESOLUTION_RULES: Readonly<
  Record<Exclude<LifecycleBlockerKind, "approval">, readonly LifecycleResolutionRule[]>
> = {
  question: IMPLEMENTATION_RESOLUTION_RULES,
  runtime: [
    ...IMPLEMENTATION_RESOLUTION_RULES,
    { toStatus: "review", source: "session", reason: "Review session resumed" },
  ],
  tool: IMPLEMENTATION_RESOLUTION_RULES,
  attention: [
    ...IMPLEMENTATION_RESOLUTION_RULES,
    { toStatus: "review", source: "session", reason: "Review session resumed" },
  ],
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
  const blockingTimestamp = Date.parse(blockingEvent.timestamp);
  const blockerKind = lifecycleBlockerKind(status, blockingEvent.source, blockingEvent.reason);
  const rules =
    blockerKind === "approval"
      ? APPROVAL_RESOLUTION_RULES
      : ATTENTION_RESOLUTION_RULES[blockerKind];
  const resolved = phase.lifecycleEvents
    .slice(blockingIndex + 1)
    .some(
      (event) =>
        Date.parse(event.timestamp) >= blockingTimestamp &&
        rules.some(
          (rule) =>
            event.toStatus === rule.toStatus &&
            event.source === rule.source &&
            event.reason === rule.reason,
        ),
    );
  return !resolved;
}

function lifecycleBlockerKind(
  status: "waiting-for-approval" | "needs-attention",
  source: NotesPhase["lifecycleEvents"][number]["source"],
  reason: string | null,
): LifecycleBlockerKind {
  if (status === "waiting-for-approval") return "approval";
  if (source === "session") return "runtime";
  if (source === "agent" && /(^|\s)\S+ failed(?::|$)/i.test(reason ?? "")) return "tool";
  if (source === "agent") return "question";
  return "attention";
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
  if (unmet.includes("verification-exception-not-accepted")) {
    return "The verification exception still needs reviewer acceptance.";
  }
  if (unmet.includes("inactive-phase")) return "The phase is not active for automatic completion.";
  return "Completion evidence is incomplete.";
}

export interface PhaseCompletionRepository {
  recordImplementationCheckpoint(
    cwd: string,
    request: ProjectNotesImplementationCheckpointRequest,
  ): Promise<ProjectNotesImplementationCheckpointOutcome>;
  recordCompletionReview(
    cwd: string,
    request: ProjectNotesCompletionReviewRequest,
  ): Promise<ProjectNotesCompletionReviewOutcome>;
}

export type PhaseCompletionCoordinatorOutcome =
  | ProjectNotesImplementationCheckpointOutcome
  | ProjectNotesCompletionReviewOutcome
  | { status: "storage-failure"; error: unknown };

export interface PhaseCompletionCoordinatorOptions {
  cwd: string;
  repository: PhaseCompletionRepository;
  broadcastSnapshot(snapshot: ProjectNotesSnapshot): void;
  onError?(error: unknown, kind: "implementation-checkpoint" | "completion-review"): void;
}

export class AppSidecarPhaseCompletionCoordinator {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly options: PhaseCompletionCoordinatorOptions) {}

  checkpoint(
    request: ProjectNotesImplementationCheckpointRequest,
  ): Promise<PhaseCompletionCoordinatorOutcome> {
    return this.enqueue("implementation-checkpoint", () =>
      this.options.repository.recordImplementationCheckpoint(this.options.cwd, request),
    );
  }

  review(request: ProjectNotesCompletionReviewRequest): Promise<PhaseCompletionCoordinatorOutcome> {
    return this.enqueue("completion-review", () =>
      this.options.repository.recordCompletionReview(this.options.cwd, request),
    );
  }

  private enqueue(
    kind: "implementation-checkpoint" | "completion-review",
    operation: () => Promise<
      ProjectNotesImplementationCheckpointOutcome | ProjectNotesCompletionReviewOutcome
    >,
  ): Promise<PhaseCompletionCoordinatorOutcome> {
    const queued = this.tail.then(async () => {
      try {
        const outcome = await operation();
        if (outcome.status === "committed") this.options.broadcastSnapshot(outcome.snapshot);
        return outcome;
      } catch (error) {
        this.options.onError?.(error, kind);
        return { status: "storage-failure" as const, error };
      }
    });
    this.tail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }
}

export function completionReviewFromEvent(
  event: NotesRoadmapCompletionReview,
): PhaseCompletionReviewDecision {
  return {
    reviewer: event.reviewer,
    decision: event.decision,
    acceptsVerificationException: event.acceptsVerificationException,
    reason: event.reason,
  };
}
