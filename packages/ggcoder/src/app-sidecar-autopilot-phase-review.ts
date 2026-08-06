import type { AutopilotVerdict } from "./core/autopilot-verdict.js";
import type { KenAutopilotBoundPhase } from "./core/ken-context.js";
import type { AppSidecarFinalReviewAttempt } from "./app-sidecar-roadmap-tool-host.js";
import type { ProjectNotesSnapshot } from "./project-notes-repository.js";

/** Build the persisted phase target included in every normal Autopilot Ken digest. */
export function boundPhaseForAutopilotReview(
  snapshot: ProjectNotesSnapshot,
  phaseId: string,
): KenAutopilotBoundPhase | null {
  const phase = snapshot.document.phases.find((candidate) => candidate.id === phaseId);
  if (!phase) return null;

  const verification = [...phase.roadmapEvents]
    .reverse()
    .find((event) => event.type === "status-update" && event.verification !== null);

  return {
    id: phase.id,
    revision: snapshot.revision,
    goal: phase.goal,
    completionCriteria: [...phase.doneWhen],
    status: phase.status,
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

  const relevant = attempts.filter(
    (attempt) =>
      attempt.actor === "ken-autopilot" &&
      attempt.input.phase_id === phase.id &&
      attempt.input.final_review !== null,
  );
  const completed = [...relevant]
    .reverse()
    .find(
      (attempt) =>
        attempt.result.result === "completion-review-committed" ||
        attempt.result.result === "completion-review-duplicate",
    );
  if (!completed || completed.input.final_review === null) return null;

  if (completed.input.final_review.decision === "rejected") {
    return {
      kind: "prompt",
      body:
        completed.input.final_review.reason?.trim() ||
        "The phase completion review was rejected. Correct the work and re-run verification before returning it to review.",
    };
  }

  if (
    (completed.result.result === "completion-review-committed" ||
      completed.result.result === "completion-review-duplicate") &&
    completed.result.gateOutcome === "done"
  ) {
    return { kind: "all_clear" };
  }

  // Accepted with missing evidence, a stale/non-committed attempt, interruption,
  // or disabled autopilot all stop here and leave the persisted phase in Review.
  return null;
}
