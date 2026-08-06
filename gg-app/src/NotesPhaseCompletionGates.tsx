import type { ReactElement } from "react";
import { MENTOR_DISPLAY_NAME, PRODUCT_DISPLAY_NAME } from "./brand";
import type {
  NotesCompletionUnmetGateCode,
  NotesImplementationRunOutcome,
  NotesPhase,
  NotesRoadmapActor,
  NotesRoadmapCompletionReview,
  NotesRoadmapEvent,
  NotesRoadmapImplementationCheckpoint,
  NotesRoadmapReviewer,
  NotesRoadmapStatusUpdate,
  NotesVerificationStatus,
} from "./notes-types";

const ROADMAP_ACTOR_LABELS = {
  "gg-coder": PRODUCT_DISPLAY_NAME,
  ken: MENTOR_DISPLAY_NAME,
  "ken-autopilot": `Autopilot ${MENTOR_DISPLAY_NAME}`,
} as const satisfies Record<NotesRoadmapActor, string>;

const ROADMAP_REVIEWER_LABELS = {
  ken: MENTOR_DISPLAY_NAME,
  "ken-autopilot": `Autopilot ${MENTOR_DISPLAY_NAME}`,
} as const satisfies Record<NotesRoadmapReviewer, string>;

const VERIFICATION_LABELS = {
  passed: "Passed",
  failed: "Failed",
  "exception-requested": "Exception requested",
} as const satisfies Record<NotesVerificationStatus, string>;

const IMPLEMENTATION_OUTCOME_LABELS = {
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "was cancelled",
  interrupted: "was interrupted",
} as const satisfies Record<NotesImplementationRunOutcome, string>;

const COMPLETION_GATE_RECOVERY = {
  "missing-implementation": "Implementation evidence has not been recorded.",
  "stale-session": "Completion evidence belongs to a different phase session.",
  "run-not-successful": "The implementation run did not settle successfully.",
  "incomplete-plan":
    "The implementation checkpoint used by this final review does not complete every canonical plan step.",
  "missing-verification": "Typed verification evidence has not been recorded.",
  "failed-verification": "The verification used by this final review failed.",
  "verification-exception-not-accepted":
    "The verification exception still needs reviewer acceptance.",
  "unresolved-approval": "Plan approval is still unresolved.",
  "unresolved-attention": "A question or error still needs attention.",
  "inactive-phase": "The phase is not active for automatic completion.",
} as const satisfies Record<NotesCompletionUnmetGateCode, string>;

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export type NotesCompletionGateTone = "neutral" | "positive" | "warning" | "negative" | "protected";

export interface NotesCompletionGateOverview {
  implementation: { label: string; detail: string; tone: NotesCompletionGateTone };
  verification: { label: string; detail: string | null; tone: NotesCompletionGateTone };
  review: { label: string; detail: string | null; tone: NotesCompletionGateTone };
  outcome: string;
  blocker: string | null;
  tone: NotesCompletionGateTone;
}

export function notesCompletionGateOverview(phase: NotesPhase): NotesCompletionGateOverview {
  const latestImplementation = latestRoadmapEvent(
    phase,
    (event): event is NotesRoadmapImplementationCheckpoint =>
      event.type === "implementation-checkpoint",
  );
  const latestVerification = latestRoadmapEvent(
    phase,
    (event): event is NotesRoadmapStatusUpdate =>
      event.type === "status-update" && event.verification !== null,
  );
  const review = latestRoadmapEvent(
    phase,
    (event): event is NotesRoadmapCompletionReview => event.type === "completion-review",
  );
  const reviewIndex = review ? phase.roadmapEvents.lastIndexOf(review) : -1;
  const hasNewerEvidence =
    review !== null &&
    latestRoadmapEventAfter(
      phase,
      reviewIndex,
      (event): event is NotesRoadmapImplementationCheckpoint | NotesRoadmapStatusUpdate =>
        event.type === "implementation-checkpoint" ||
        (event.type === "status-update" && event.verification !== null),
    ) !== null;
  const implementation =
    review && !hasNewerEvidence
      ? (phase.roadmapEvents.find(
          (event): event is NotesRoadmapImplementationCheckpoint =>
            event.type === "implementation-checkpoint" &&
            event.id === review.implementationCheckpointId,
        ) ?? null)
      : latestImplementation;
  const verification =
    review && !hasNewerEvidence
      ? (phase.roadmapEvents.find(
          (event): event is NotesRoadmapStatusUpdate =>
            event.type === "status-update" && event.id === review.verificationStatusUpdateId,
        ) ?? null)
      : latestVerification;

  const implementationDetail = implementation
    ? `${implementation.completedPlanSteps.length} of ${implementation.planStepTotal} plan steps`
    : "No evidence";
  const implementationComplete =
    implementation?.runOutcome === "succeeded" &&
    implementation.completedPlanSteps.length === implementation.planStepTotal;
  const implementationFailed = implementation?.runOutcome === "failed";
  const implementationSummary = implementation
    ? {
        label: implementationFailed ? "Failed" : implementationComplete ? "Complete" : "Blocked",
        detail: implementationDetail,
        tone: implementationFailed
          ? ("negative" as const)
          : implementationComplete
            ? ("positive" as const)
            : ("warning" as const),
      }
    : { label: "Missing", detail: implementationDetail, tone: "neutral" as const };

  const verificationSummary = verification?.verification
    ? {
        label: verificationLabel(verification.verification),
        detail: verification.verificationReason,
        tone:
          verification.verification === "passed"
            ? ("positive" as const)
            : verification.verification === "failed"
              ? ("negative" as const)
              : ("warning" as const),
      }
    : { label: "Missing", detail: null, tone: "neutral" as const };

  const reviewSummary = hasNewerEvidence
    ? {
        label: "Review needed",
        detail: "Newer completion evidence has not been reviewed.",
        tone: "warning" as const,
      }
    : review
      ? {
          label: review.decision === "accepted" ? "Accepted" : "Rejected",
          detail: review.reason,
          tone:
            review.gateOutcome === "manual-override"
              ? ("protected" as const)
              : review.decision === "accepted"
                ? ("positive" as const)
                : ("negative" as const),
        }
      : { label: "Missing", detail: null, tone: "neutral" as const };

  if (review?.gateOutcome === "manual-override") {
    return {
      implementation: implementationSummary,
      verification: verificationSummary,
      review: reviewSummary,
      outcome: "Manual override protected",
      blocker:
        review.reason ??
        (review.unmetGateCodes[0] ? completionGateRecovery(review.unmetGateCodes[0]) : null) ??
        "Automatic completion cannot replace the user-selected state.",
      tone: "protected",
    };
  }
  if (!hasNewerEvidence && review?.decision === "rejected") {
    return {
      implementation: implementationSummary,
      verification: verificationSummary,
      review: reviewSummary,
      outcome: "Review rejected",
      blocker:
        review.reason ??
        (review.unmetGateCodes[0] ? completionGateRecovery(review.unmetGateCodes[0]) : null),
      tone: "negative",
    };
  }
  if (!hasNewerEvidence && review?.decision === "accepted" && review.gateOutcome === "done") {
    return {
      implementation: implementationSummary,
      verification: verificationSummary,
      review: reviewSummary,
      outcome: review.acceptsVerificationException ? "Accepted with exception" : "Accepted",
      blocker: null,
      tone: "positive",
    };
  }
  if (verification?.verification === "failed") {
    return {
      implementation: implementationSummary,
      verification: verificationSummary,
      review: reviewSummary,
      outcome: "Verification failed",
      blocker: verification.verificationReason ?? "Verification must pass before final review.",
      tone: "negative",
    };
  }
  if (verification?.verification === "exception-requested") {
    return {
      implementation: implementationSummary,
      verification: verificationSummary,
      review: reviewSummary,
      outcome: "Exception pending",
      blocker:
        verification.verificationReason ?? "A reviewer must accept the verification exception.",
      tone: "warning",
    };
  }
  if (implementation && !implementationComplete) {
    return {
      implementation: implementationSummary,
      verification: verificationSummary,
      review: reviewSummary,
      outcome: "Completion blocked",
      blocker: implementationFailed
        ? "The implementation run failed."
        : "Complete every canonical plan step before final review.",
      tone: implementationFailed ? "negative" : "warning",
    };
  }
  if (!implementation || !verification?.verification) {
    return {
      implementation: implementationSummary,
      verification: verificationSummary,
      review: reviewSummary,
      outcome: "Evidence missing",
      blocker: !implementation
        ? "Record implementation evidence next."
        : "Record typed verification next.",
      tone: "neutral",
    };
  }
  return {
    implementation: implementationSummary,
    verification: verificationSummary,
    review: reviewSummary,
    outcome: "Final review pending",
    blocker: hasNewerEvidence
      ? "Newer completion evidence requires another final review."
      : "A final review decision is still required.",
    tone: "warning",
  };
}

export function NotesPhaseCompletionGates({ phase }: { phase: NotesPhase }): ReactElement {
  const latestImplementation = latestRoadmapEvent(
    phase,
    (event): event is NotesRoadmapImplementationCheckpoint =>
      event.type === "implementation-checkpoint",
  );
  const latestVerification = latestRoadmapEvent(
    phase,
    (event): event is NotesRoadmapStatusUpdate =>
      event.type === "status-update" && event.verification !== null,
  );
  const latestCompletionReview = latestRoadmapEvent(
    phase,
    (event): event is NotesRoadmapCompletionReview => event.type === "completion-review",
  );
  const displayedImplementation = latestCompletionReview
    ? (phase.roadmapEvents.find(
        (event): event is NotesRoadmapImplementationCheckpoint =>
          event.type === "implementation-checkpoint" &&
          event.id === latestCompletionReview.implementationCheckpointId,
      ) ?? null)
    : latestImplementation;
  const displayedVerification = latestCompletionReview
    ? (phase.roadmapEvents.find(
        (event): event is NotesRoadmapStatusUpdate =>
          event.type === "status-update" &&
          event.id === latestCompletionReview.verificationStatusUpdateId,
      ) ?? null)
    : latestVerification;
  const latestCompletionReviewIndex = latestCompletionReview
    ? phase.roadmapEvents.lastIndexOf(latestCompletionReview)
    : -1;
  const newerImplementation = latestCompletionReview
    ? latestRoadmapEventAfter(
        phase,
        latestCompletionReviewIndex,
        (event): event is NotesRoadmapImplementationCheckpoint =>
          event.type === "implementation-checkpoint",
      )
    : null;
  const newerVerification = latestCompletionReview
    ? latestRoadmapEventAfter(
        phase,
        latestCompletionReviewIndex,
        (event): event is NotesRoadmapStatusUpdate =>
          event.type === "status-update" && event.verification !== null,
      )
    : null;
  const acceptedVerificationException =
    displayedVerification?.verification === "exception-requested" &&
    latestCompletionReview?.acceptsVerificationException &&
    latestCompletionReview.verificationStatusUpdateId === displayedVerification.id
      ? latestCompletionReview
      : null;
  const handoffVerification = latestRoadmapEvent(
    phase,
    (event): event is NotesRoadmapStatusUpdate =>
      event.type === "status-update" && event.actor === "gg-coder" && event.verification !== null,
  );
  const criterionEvidence = phase.doneWhen.map((criterion, index) => ({
    criterion,
    evidence: handoffVerification?.evidence[index] ?? null,
  }));
  const reviewReady =
    phase.status === "review" &&
    handoffVerification?.transition === "review" &&
    handoffVerification.verification === "passed" &&
    handoffVerification.evidence.length === phase.doneWhen.length;

  return (
    <section
      className="notes-completion-gates"
      aria-labelledby={`notes-completion-gates-${phase.id}`}
    >
      <h4 id={`notes-completion-gates-${phase.id}`}>Completion gates</h4>
      <dl>
        <div className={reviewReady ? "notes-review-readiness is-ready" : "notes-review-readiness"}>
          <dt>Review readiness</dt>
          <dd>
            <strong>
              {reviewReady ? `Ready for ${MENTOR_DISPLAY_NAME} review` : "Not ready for review"}
            </strong>
            <span>
              {reviewReady
                ? "Every Done when criterion has passed verification evidence. GG Coder has stopped at the handoff."
                : handoffVerification?.verification === "failed"
                  ? (handoffVerification.verificationReason ??
                    "Verification failed; the phase remains in progress.")
                  : "Passed verification and one evidence item per Done when criterion are required before review."}
            </span>
            {criterionEvidence.length > 0 && (
              <ul className="notes-review-readiness-evidence">
                {criterionEvidence.map(({ criterion, evidence }, index) => (
                  <li key={`${index}-${criterion}`}>
                    <span>{criterion}</span>
                    <strong>{evidence ?? "Evidence missing"}</strong>
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
        <div>
          <dt>Implementation</dt>
          <dd>
            {latestCompletionReview && <span>Evidence used by this final review.</span>}
            {displayedImplementation ? (
              <>
                <strong>
                  {displayedImplementation.completedPlanSteps.length} of{" "}
                  {displayedImplementation.planStepTotal} plan steps
                </strong>
                <span>
                  Run {implementationOutcomeLabel(displayedImplementation.runOutcome)} by the bound
                  session.
                </span>
                <time dateTime={displayedImplementation.timestamp}>
                  {formatDateTime(displayedImplementation.timestamp)}
                </time>
              </>
            ) : (
              <span>
                {latestCompletionReview
                  ? "This final review did not reference implementation evidence."
                  : "Completion evidence has not been recorded."}
              </span>
            )}
            {newerImplementation && (
              <div className="notes-completion-unreviewed">
                <strong>Newer unreviewed evidence</strong>
                <span>
                  {newerImplementation.completedPlanSteps.length} of{" "}
                  {newerImplementation.planStepTotal} plan steps; run{" "}
                  {implementationOutcomeLabel(newerImplementation.runOutcome)} at{" "}
                  <time dateTime={newerImplementation.timestamp}>
                    {formatDateTime(newerImplementation.timestamp)}
                  </time>
                  . This was not part of the final review.
                </span>
              </div>
            )}
          </dd>
        </div>
        <div>
          <dt>Verification</dt>
          <dd>
            {latestCompletionReview && <span>Evidence used by this final review.</span>}
            {displayedVerification?.verification ? (
              <>
                <strong>{verificationLabel(displayedVerification.verification)}</strong>
                <span>
                  Reported by {roadmapActorLabel(displayedVerification.actor)} at{" "}
                  <time dateTime={displayedVerification.timestamp}>
                    {formatDateTime(displayedVerification.timestamp)}
                  </time>
                  .
                </span>
                {displayedVerification.verificationReason && (
                  <span>{displayedVerification.verificationReason}</span>
                )}
                {displayedVerification.evidence.length > 0 && (
                  <ul>
                    {displayedVerification.evidence.map((item, index) => (
                      <li key={`${displayedVerification.id}-evidence-${index}`}>{item}</li>
                    ))}
                  </ul>
                )}
                {acceptedVerificationException && (
                  <span>
                    Exception accepted by{" "}
                    {roadmapReviewerLabel(acceptedVerificationException.reviewer)} at{" "}
                    <time dateTime={acceptedVerificationException.timestamp}>
                      {formatDateTime(acceptedVerificationException.timestamp)}
                    </time>
                    .
                  </span>
                )}
              </>
            ) : (
              <span>
                {latestCompletionReview
                  ? "This final review did not reference typed verification."
                  : "Typed verification has not been recorded."}
              </span>
            )}
            {newerVerification?.verification && (
              <div className="notes-completion-unreviewed">
                <strong>Newer unreviewed evidence</strong>
                <span>
                  {verificationLabel(newerVerification.verification)} reported by{" "}
                  {roadmapActorLabel(newerVerification.actor)} at{" "}
                  <time dateTime={newerVerification.timestamp}>
                    {formatDateTime(newerVerification.timestamp)}
                  </time>
                  . This was not part of the final review.
                </span>
                {newerVerification.verificationReason && (
                  <span>{newerVerification.verificationReason}</span>
                )}
                {newerVerification.evidence.length > 0 && (
                  <ul>
                    {newerVerification.evidence.map((item, index) => (
                      <li key={`${newerVerification.id}-evidence-${index}`}>{item}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </dd>
        </div>
        <div>
          <dt>Final review</dt>
          <dd>
            {latestCompletionReview?.type === "completion-review" ? (
              <>
                <strong>
                  {latestCompletionReview.decision === "accepted" ? "Accepted" : "Rejected"} by{" "}
                  {roadmapReviewerLabel(latestCompletionReview.reviewer)}
                </strong>
                <time dateTime={latestCompletionReview.timestamp}>
                  {formatDateTime(latestCompletionReview.timestamp)}
                </time>
                {latestCompletionReview.reason && <span>{latestCompletionReview.reason}</span>}
                {latestCompletionReview.unmetGateCodes.length > 0 && (
                  <ul>
                    {latestCompletionReview.unmetGateCodes.map((code) => (
                      <li key={code}>{completionGateRecovery(code)}</li>
                    ))}
                  </ul>
                )}
                {latestCompletionReview.gateOutcome === "manual-override" && (
                  <span>
                    The review is recorded, but the user status override remains authoritative.
                  </span>
                )}
                {latestCompletionReview.gateOutcome === "done" && phase.archivedAt === null && (
                  <span>Done is complete. Archiving remains a separate action.</span>
                )}
              </>
            ) : (
              <span>Final review has not been recorded.</span>
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function roadmapActorLabel(actor: NotesRoadmapActor): string {
  return ROADMAP_ACTOR_LABELS[actor];
}

function roadmapReviewerLabel(reviewer: NotesRoadmapReviewer): string {
  return ROADMAP_REVIEWER_LABELS[reviewer];
}

function verificationLabel(verification: NotesVerificationStatus): string {
  return VERIFICATION_LABELS[verification];
}

function implementationOutcomeLabel(outcome: NotesImplementationRunOutcome): string {
  return IMPLEMENTATION_OUTCOME_LABELS[outcome];
}

function completionGateRecovery(code: NotesCompletionUnmetGateCode): string {
  return COMPLETION_GATE_RECOVERY[code];
}

function latestRoadmapEvent<T extends NotesRoadmapEvent>(
  phase: NotesPhase,
  predicate: (event: NotesRoadmapEvent) => event is T,
): T | null {
  for (let index = phase.roadmapEvents.length - 1; index >= 0; index -= 1) {
    const event = phase.roadmapEvents[index];
    if (event && predicate(event)) return event;
  }
  return null;
}

function latestRoadmapEventAfter<T extends NotesRoadmapEvent>(
  phase: NotesPhase,
  startIndex: number,
  predicate: (event: NotesRoadmapEvent) => event is T,
): T | null {
  for (let index = phase.roadmapEvents.length - 1; index > startIndex; index -= 1) {
    const event = phase.roadmapEvents[index];
    if (event && predicate(event)) return event;
  }
  return null;
}

function formatDateTime(value: string): string {
  return dateTimeFormatter.format(new Date(value));
}
