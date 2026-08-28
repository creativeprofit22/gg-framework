import type { AutopilotVerdict } from "./core/autopilot-verdict.js";
import type { KenAutopilotBoundPhase } from "./core/ken-context.js";
import type { RoadmapVerificationEvidenceEvaluation } from "./core/verification-evidence.js";
import type { AppSidecarFinalReviewAttempt } from "./app-sidecar-roadmap-tool-host.js";
import type { AppSidecarRoadmapReviewTrigger } from "./app-sidecar-roadmap-review-scheduler.js";
import type { ProjectNotesSnapshot } from "./project-notes-repository.js";

/** Build the persisted phase target included in every normal Autopilot Ken digest. */
export function boundPhaseForAutopilotReview(
  snapshot: ProjectNotesSnapshot,
  phaseId: string,
  trigger?: AppSidecarRoadmapReviewTrigger,
  evidenceEvaluation?: RoadmapVerificationEvidenceEvaluation,
): KenAutopilotBoundPhase | null {
  const phase = snapshot.document.phases.find((candidate) => candidate.id === phaseId);
  if (!phase) return null;

  const verification = [...phase.roadmapEvents]
    .reverse()
    .find((event) => event.type === "status-update" && event.verification !== null);
  if (
    !trigger ||
    trigger.phaseId !== phaseId ||
    verification?.id !== trigger.verificationStatusUpdateId
  ) {
    return null;
  }
  if (verification.type !== "status-update" || verification.verification === null) return null;

  const criterionCoverage =
    verification.verification === "passed"
      ? evidenceEvaluation?.ready === true &&
        evidenceEvaluation.criterionCoverage.length === phase.doneWhen.length &&
        evidenceEvaluation.criterionCoverage.every(
          (coverage, index) =>
            coverage.criterionIndex === index + 1 &&
            coverage.criterion === phase.doneWhen[index] &&
            coverage.evidence === verification.evidence[index] &&
            coverage.command.length > 0,
        )
        ? evidenceEvaluation.criterionCoverage.map((coverage) => ({ ...coverage }))
        : null
      : null;
  if (verification.verification === "passed" && criterionCoverage === null) return null;

  return {
    id: phase.id,
    revision: snapshot.revision,
    goal: phase.goal,
    completionCriteria: [...phase.doneWhen],
    status: phase.status,
    finalReviewClaim: {
      triggerId: trigger.triggerId,
      statusUpdateId: trigger.statusUpdateId,
      reviewId: trigger.reviewId,
    },
    criterionCoverage,
    latestVerification: {
      id: verification.id,
      result: verification.verification,
      reason: verification.verificationReason,
      timestamp: verification.timestamp,
      evidence: [...verification.evidence],
    },
  };
}

export type AppSidecarFinalReviewAttemptClassification =
  | { status: "missing" }
  | { status: "stale-revision"; attempt: AppSidecarFinalReviewAttempt }
  | { status: "committed" | "duplicate"; attempt: AppSidecarFinalReviewAttempt }
  | { status: "failed"; attempt: AppSidecarFinalReviewAttempt };

export type AppSidecarFinalReviewExecutionResult =
  | {
      status: "committed" | "duplicate";
      attempt: AppSidecarFinalReviewAttempt;
      verdict: AutopilotVerdict;
    }
  | {
      status: "typed-non-commit";
      attempt: AppSidecarFinalReviewAttempt | null;
      code: string;
      retryable: boolean;
    }
  | { status: "retryable-reviewer-error"; message: string }
  | { status: "no-attempt"; message: string }
  | {
      status: "terminal-gate-rejection";
      attempt: AppSidecarFinalReviewAttempt;
      code: string;
    };

export function classifyAppSidecarFinalReviewAttempt(
  phaseId: string,
  finalReviewClaim: KenAutopilotBoundPhase["finalReviewClaim"],
  attempts: readonly AppSidecarFinalReviewAttempt[],
): AppSidecarFinalReviewAttemptClassification {
  const relevantAttempts = attempts.filter(
    (candidate) =>
      candidate.actor === "ken-autopilot" &&
      candidate.input.phase_id === phaseId &&
      candidate.input.final_review !== null,
  );
  const attempt =
    finalReviewClaim === undefined
      ? relevantAttempts.at(-1)
      : [...relevantAttempts].reverse().find(
          (candidate) =>
            candidate.input.update_id === finalReviewClaim.statusUpdateId &&
            candidate.input.final_review?.review_id === finalReviewClaim.reviewId &&
            (candidate.result.result === "completion-review-committed" ||
              candidate.result.result === "completion-review-duplicate"),
        ) ?? relevantAttempts.at(-1);
  if (!attempt) return { status: "missing" };
  if (attempt.result.result === "stale-revision") {
    return { status: "stale-revision", attempt };
  }
  if (attempt.result.result === "completion-review-committed") {
    return { status: "committed", attempt };
  }
  if (attempt.result.result === "completion-review-duplicate") {
    return { status: "duplicate", attempt };
  }
  return { status: "failed", attempt };
}

export function finalReviewExecutionResult(
  phase: KenAutopilotBoundPhase,
  attempts: readonly AppSidecarFinalReviewAttempt[],
  textVerdict: AutopilotVerdict,
): AppSidecarFinalReviewExecutionResult {
  const classification = classifyAppSidecarFinalReviewAttempt(
    phase.id,
    phase.finalReviewClaim,
    attempts,
  );
  if (classification.status === "missing") {
    return {
      status: "no-attempt",
      message: "Autopilot Ken did not submit a final_review tool call.",
    };
  }
  if (classification.status === "stale-revision") {
    return {
      status: "typed-non-commit",
      attempt: classification.attempt,
      code: "stale-revision",
      retryable: true,
    };
  }
  if (classification.status === "failed") {
    return {
      status: "typed-non-commit",
      attempt: classification.attempt,
      code: classification.attempt.result.result,
      retryable: false,
    };
  }
  const attempt = classification.attempt;
  const finalReview = attempt.input.final_review;
  if (finalReview === null) {
    return {
      status: "typed-non-commit",
      attempt,
      code: "invalid-final-review-attempt",
      retryable: false,
    };
  }
  if (finalReview.decision === "rejected") {
    return {
      status: classification.status,
      attempt,
      verdict: {
        kind: "prompt",
        body:
          finalReview.reason?.trim() ||
          "The phase completion review was rejected. Correct the work and re-run verification.",
      },
    };
  }
  if (
    (attempt.result.result === "completion-review-committed" ||
      attempt.result.result === "completion-review-duplicate") &&
    attempt.result.gateOutcome === "done"
  ) {
    return { status: classification.status, attempt, verdict: { kind: "all_clear" } };
  }
  return {
    status: "terminal-gate-rejection",
    attempt,
    code:
      attempt.result.result === "completion-review-committed" ||
      attempt.result.result === "completion-review-duplicate"
        ? attempt.result.unmetGateCodes[0] ?? "completion-gate-remains-review"
        : attempt.result.result,
  };
}

/**
 * For a phase in Review, persisted final_review + completion-gate output is the
 * authority. Text-only ALL_CLEAR/IGNORE/HUMAN can never advance the phase.
 */
export function phaseCompletionVerdict(
  phase: KenAutopilotBoundPhase | null,
  attempts: readonly AppSidecarFinalReviewAttempt[],
  textVerdict: AutopilotVerdict,
): AutopilotVerdict | null {
  if (phase?.status !== "review") return textVerdict;

  const classification = classifyAppSidecarFinalReviewAttempt(
    phase.id,
    phase.finalReviewClaim,
    attempts,
  );
  if (classification.status === "missing") {
    throw new Error(
      `Autopilot completion review failed for phase ${phase.id}: no relevant roadmap_status final_review call was recorded.`,
    );
  }
  if (classification.status !== "committed" && classification.status !== "duplicate") {
    throw new Error(
      `Autopilot completion review failed for phase ${phase.id}: final_review did not commit or duplicate (result: ${classification.attempt.result.result}).`,
    );
  }

  const completed = classification.attempt;
  const completionResult = completed.result;
  if (
    completionResult.result !== "completion-review-committed" &&
    completionResult.result !== "completion-review-duplicate"
  ) {
    throw new Error(`Autopilot completion review failed for phase ${phase.id}: invalid result.`);
  }
  if (completed.input.final_review === null) {
    throw new Error(`Autopilot completion review failed for phase ${phase.id}: invalid attempt.`);
  }

  if (completed.input.final_review.decision === "rejected") {
    return {
      kind: "prompt",
      body:
        completed.input.final_review.reason?.trim() ||
        "The phase completion review was rejected. Correct the work and re-run verification before returning it to review.",
    };
  }

  if (completionResult.gateOutcome === "done") {
    return { kind: "all_clear" };
  }

  const unmetGateCodes = completionResult.unmetGateCodes;
  const gateDetails =
    unmetGateCodes.length > 0 ? unmetGateCodes.join(", ") : "no unmet gate codes reported";
  throw new Error(
    `Autopilot completion review failed for phase ${phase.id}: accepted final_review left the completion gate in Review (${gateDetails}).`,
  );
}
