import type {
  NotesPhase,
  NotesRoadmapStatusUpdate,
  NotesSessionLink,
  NotesVerificationStatus,
} from "@kenkaiiii/gg-core";

export interface ActivePhaseReviewReadiness {
  ready: boolean;
  reason: string | null;
  criteria: Array<{ criterion: string; evidence: string | null }>;
}

export function evaluateActivePhaseReviewReadiness(input: {
  doneWhen: string[];
  evidence: string[];
  verification: NotesVerificationStatus | null;
}): ActivePhaseReviewReadiness {
  const criteria = input.doneWhen.map((criterion, index) => ({
    criterion,
    evidence: input.evidence[index] ?? null,
  }));

  if (input.verification !== "passed") {
    return {
      ready: false,
      reason: "Review requires a passed verification result.",
      criteria,
    };
  }
  if (input.evidence.length < input.doneWhen.length) {
    return {
      ready: false,
      reason: `Verification evidence is missing for ${input.doneWhen.length - input.evidence.length} completion criterion/criteria. Provide one evidence item per Done when criterion, in order.`,
      criteria,
    };
  }
  if (input.evidence.length > input.doneWhen.length) {
    return {
      ready: false,
      reason: `Verification includes ${input.evidence.length - input.doneWhen.length} unmatched evidence item(s). Provide exactly one evidence item per Done when criterion, in order.`,
      criteria,
    };
  }
  return { ready: true, reason: null, criteria };
}

function sessionsEqual(left: NotesSessionLink | null, right: NotesSessionLink): boolean {
  return (
    left !== null && left.sessionId === right.sessionId && left.sessionPath === right.sessionPath
  );
}

export function latestGgCoderVerificationReport(
  phase: NotesPhase,
): NotesRoadmapStatusUpdate | undefined {
  return [...phase.roadmapEvents]
    .reverse()
    .find(
      (event): event is NotesRoadmapStatusUpdate =>
        event.type === "status-update" && event.actor === "gg-coder" && event.verification !== null,
    );
}

export function isActivePhaseReadyForReview(
  phase: NotesPhase,
  expectedSession: NotesSessionLink,
): boolean {
  if (phase.status !== "review" || !sessionsEqual(phase.session, expectedSession)) return false;
  const report = latestGgCoderVerificationReport(phase);
  if (
    !report ||
    report.transition !== "review" ||
    !sessionsEqual(report.verificationSession, expectedSession)
  ) {
    return false;
  }
  return evaluateActivePhaseReviewReadiness({
    doneWhen: phase.doneWhen,
    evidence: report.evidence,
    verification: report.verification,
  }).ready;
}
