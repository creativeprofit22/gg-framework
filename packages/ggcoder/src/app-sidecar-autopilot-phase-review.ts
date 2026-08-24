import type { AutopilotVerdict } from "./core/autopilot-verdict.js";
import type { KenAutopilotBoundPhase } from "./core/ken-context.js";
import type { AppSidecarFinalReviewAttempt } from "./app-sidecar-roadmap-tool-host.js";
import type { AppSidecarRoadmapReviewTrigger } from "./app-sidecar-roadmap-review-scheduler.js";
import type { ProjectNotesSnapshot } from "./project-notes-repository.js";

/** Build the persisted phase target included in every normal Autopilot Ken digest. */
export function boundPhaseForAutopilotReview(
  snapshot: ProjectNotesSnapshot,
  phaseId: string,
  trigger?: AppSidecarRoadmapReviewTrigger,
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

  return {
    id: phase.id,
    revision: snapshot.revision,
    goal: phase.goal,
    completionCriteria: [...phase.doneWhen],
    status: phase.status,
    finalReviewClaim: { triggerId: trigger.triggerId, reviewId: trigger.reviewId },
    latestVerification:
      verification?.type === "status-update" && verification.verification !== null
        ? {
            id: verification.id,
            result: verification.verification,
            reason: verification.verificationReason,
            timestamp: verification.timestamp,
            evidence: [...verification.evidence],
          }
        : null,
  };
}

export type AppSidecarFinalReviewAttemptClassification =
  | { status: "missing" }
  | { status: "stale-revision"; attempt: AppSidecarFinalReviewAttempt }
  | { status: "committed"; attempt: AppSidecarFinalReviewAttempt }
  | { status: "failed"; attempt: AppSidecarFinalReviewAttempt };

export function classifyAppSidecarFinalReviewAttempt(
  phaseId: string,
  attempts: readonly AppSidecarFinalReviewAttempt[],
): AppSidecarFinalReviewAttemptClassification {
  const attempt = [...attempts]
    .reverse()
    .find(
      (candidate) =>
        candidate.actor === "ken-autopilot" &&
        candidate.input.phase_id === phaseId &&
        candidate.input.final_review !== null,
    );
  if (!attempt) return { status: "missing" };
  if (attempt.result.result === "stale-revision") {
    return { status: "stale-revision", attempt };
  }
  if (
    attempt.result.result === "completion-review-committed" ||
    attempt.result.result === "completion-review-duplicate"
  ) {
    return { status: "committed", attempt };
  }
  return { status: "failed", attempt };
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

  const classification = classifyAppSidecarFinalReviewAttempt(phase.id, attempts);
  if (classification.status === "missing") {
    throw new Error(
      `Autopilot completion review failed for phase ${phase.id}: no relevant roadmap_status final_review call was recorded.`,
    );
  }
  if (classification.status !== "committed") {
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
