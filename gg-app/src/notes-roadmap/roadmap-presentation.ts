import { MENTOR_DISPLAY_NAME, PRODUCT_DISPLAY_NAME } from "../brand";
import type {
  NotesCompletionGateOutcome,
  NotesCompletionUnmetGateCode,
  NotesImplementationRunOutcome,
  NotesPhase,
  NotesPhaseStatus,
  NotesReferenceOperationResult,
  NotesRoadmapActor,
  NotesRoadmapMutationResult,
  NotesRoadmapReferenceProposal,
  NotesRoadmapReviewer,
  NotesRoadmapStatusUpdate,
  NotesSessionLink,
  NotesVerificationStatus,
} from "../notes-types";

const STATUS_LABELS = {
  "not-started": "Not started",
  planning: "Planning",
  "waiting-for-approval": "Waiting for approval",
  "in-progress": "In progress",
  review: "Review",
  done: "Done",
  "needs-attention": "Needs attention",
  cancelled: "Cancelled",
} as const satisfies Record<NotesPhaseStatus, string>;

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

export interface ManualRoadmapAdvancement {
  completedPhase: NotesPhase;
  nextPhase: NotesPhase;
}

export function selectManualRoadmapAdvancement(
  phases: readonly NotesPhase[],
): ManualRoadmapAdvancement | null {
  const orderedPhases = phases
    .map((phase, documentIndex) => ({ phase, documentIndex }))
    .sort(
      (left, right) =>
        left.phase.order - right.phase.order || left.documentIndex - right.documentIndex,
    );
  let newestPhase: NotesPhase | null = null;
  let newestPhaseIndex = -1;
  let newestReviewTimestamp = "";

  orderedPhases.forEach(({ phase }, roadmapIndex) => {
    const latestReview = [...phase.roadmapEvents]
      .reverse()
      .find((event) => event.type === "completion-review");
    if (
      latestReview?.type === "completion-review" &&
      (latestReview.timestamp > newestReviewTimestamp ||
        (latestReview.timestamp === newestReviewTimestamp && roadmapIndex > newestPhaseIndex))
    ) {
      newestPhase = phase;
      newestPhaseIndex = roadmapIndex;
      newestReviewTimestamp = latestReview.timestamp;
    }
  });

  const completedPhase = newestPhase as NotesPhase | null;
  if (
    !completedPhase ||
    completedPhase.archivedAt !== null ||
    completedPhase.status !== "done" ||
    completedPhase.overrides.status !== null
  ) {
    return null;
  }
  const latestReview = [...completedPhase.roadmapEvents]
    .reverse()
    .find((event) => event.type === "completion-review");
  if (
    latestReview?.type !== "completion-review" ||
    latestReview.reviewer !== "ken" ||
    latestReview.decision !== "accepted" ||
    latestReview.gateOutcome !== "done"
  ) {
    return null;
  }
  const nextPhase = orderedPhases
    .slice(newestPhaseIndex + 1)
    .map(({ phase }) => phase)
    .find(
      (phase) =>
        phase.archivedAt === null &&
        (phase.status === "not-started" || phase.status === "planning"),
    );
  return nextPhase?.session === null && nextPhase.overrides.status === null
    ? { completedPhase, nextPhase }
    : null;
}

const IMPLEMENTATION_OUTCOME_LABELS = {
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "was cancelled",
  interrupted: "was interrupted",
} as const satisfies Record<NotesImplementationRunOutcome, string>;

const COMPLETION_OUTCOME_LABELS = {
  done: "Done",
  review: "Review",
  "needs-attention": "Needs attention",
  "waiting-for-approval": "Waiting for approval",
  "manual-override": "Manual override protected",
  "done-terminal": "Already Done",
} as const satisfies Record<NotesCompletionGateOutcome, string>;

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

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
});
const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const timeFormatter = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

export type PhasePrimaryAction = "Start" | "Resume" | "Recover" | "Review";

export function statusLabel(status: NotesPhaseStatus): string {
  return STATUS_LABELS[status];
}

export function phaseActionLabel(
  phase: NotesPhase,
  action: PhasePrimaryAction,
): "Start" | "Resume" | "Recover" | "Retry" | "Review" {
  if (action !== "Review" && (phase.status === "needs-attention" || phase.status === "cancelled")) {
    return "Retry";
  }
  return action;
}

export function sessionAction(session: NotesSessionLink): "Resume" | "Recover" {
  return session.sessionPath === null ? "Recover" : "Resume";
}

export function primaryAction(phase: NotesPhase): PhasePrimaryAction {
  const reviewOnlyStatus = phase.status === "review" || phase.status === "done";
  const manuallyCancelled = phase.status === "cancelled" && phase.overrides.status !== null;
  if (reviewOnlyStatus || manuallyCancelled) return "Review";
  return phase.session === null ? "Start" : sessionAction(phase.session);
}

export function latestRoadmapReport(
  phase: Pick<NotesPhase, "roadmapEvents">,
): NotesRoadmapStatusUpdate | null {
  for (let index = phase.roadmapEvents.length - 1; index >= 0; index -= 1) {
    const event = phase.roadmapEvents[index];
    if (event?.type === "status-update") return event;
  }
  return null;
}

export function visibleRoadmapAttentionReason(
  phase: Pick<NotesPhase, "status" | "attentionReason" | "roadmapEvents">,
): string | null {
  if (phase.status !== "needs-attention" || phase.attentionReason === null) return null;
  const report = latestRoadmapReport(phase);
  if (
    report?.transition === "blocked" &&
    report.blocker === phase.attentionReason &&
    phase.roadmapEvents.some(
      (event) => event.type === "blocker-resolution" && event.blockerUpdateId === report.id,
    )
  ) {
    return null;
  }
  return phase.attentionReason;
}

export function activeRoadmapBlocker(
  phase: Pick<NotesPhase, "status" | "attentionReason" | "roadmapEvents">,
): NotesRoadmapStatusUpdate | null {
  const attentionReason = visibleRoadmapAttentionReason(phase);
  if (attentionReason === null) return null;
  const report = latestRoadmapReport(phase);
  if (
    !report ||
    report.transition !== "blocked" ||
    !report.blocker ||
    !report.requiredExternalAction ||
    report.blocker !== attentionReason
  ) {
    return null;
  }
  return report;
}

export function unresolvedRoadmapProposals(
  phase: NotesPhase,
): Array<{ proposal: NotesRoadmapReferenceProposal; report: NotesRoadmapStatusUpdate }> {
  const decided = new Set(
    phase.roadmapEvents
      .filter((event) => event.type === "reference-decision")
      .map((event) => event.proposalId),
  );
  const pending: Array<{
    proposal: NotesRoadmapReferenceProposal;
    report: NotesRoadmapStatusUpdate;
  }> = [];
  for (const event of phase.roadmapEvents) {
    if (event.type !== "status-update") continue;
    for (const proposal of event.proposedReferences) {
      if (proposal.disposition === "pending" && !decided.has(proposal.id)) {
        pending.push({ proposal, report: event });
      }
    }
  }
  return pending;
}

export function roadmapActorLabel(actor: NotesRoadmapActor): string {
  return ROADMAP_ACTOR_LABELS[actor];
}

export function roadmapReviewerLabel(reviewer: NotesRoadmapReviewer): string {
  return ROADMAP_REVIEWER_LABELS[reviewer];
}

export function verificationLabel(verification: NotesVerificationStatus): string {
  return VERIFICATION_LABELS[verification];
}

export function implementationOutcomeLabel(outcome: NotesImplementationRunOutcome): string {
  return IMPLEMENTATION_OUTCOME_LABELS[outcome];
}

export function completionOutcomeLabel(outcome: NotesCompletionGateOutcome): string {
  return COMPLETION_OUTCOME_LABELS[outcome];
}

export function completionGateRecovery(code: NotesCompletionUnmetGateCode): string {
  return COMPLETION_GATE_RECOVERY[code];
}

export function roadmapProposalLabel(proposal: NotesRoadmapReferenceProposal): string {
  if (proposal.pullRequest !== null) return `Pull request #${proposal.pullRequest}`;
  if (proposal.issue !== null) return `Issue #${proposal.issue}`;
  if (proposal.path && proposal.range) {
    return `${proposal.path}:L${proposal.range.startLine}-L${proposal.range.endLine}`;
  }
  return proposal.path ?? proposal.revision ?? proposal.tool ?? proposal.provider;
}

export function roadmapMutationMessage(result: NotesRoadmapMutationResult): string {
  if (result.status === "committed") return "Roadmap change saved.";
  if (result.status === "already-decided") return `Proposal was already ${result.decision}.`;
  if (result.status === "decision-conflict") {
    return `Proposal was already ${result.decision} in another window.`;
  }
  if (result.status === "missing-proposal") {
    return "The proposal is no longer pending. Review the latest activity and try again.";
  }
  if (result.status === "missing-phase" || result.status === "archived-phase") {
    return "The phase is no longer available. Return to the Roadmap and choose an active phase.";
  }
  return "The Roadmap change could not be saved. Check Notes storage and try again.";
}

export function referenceLinkAnnouncement(
  result: NotesReferenceOperationResult,
  action: "attach" | "detach",
  referenceLabel: string,
  phaseTitle: string,
): string {
  if (result.status === "committed" || result.status === "reused") {
    return action === "attach"
      ? `Attached ${referenceLabel} to ${phaseTitle}`
      : `Detached ${referenceLabel} from ${phaseTitle}`;
  }
  if (result.status === "missing-reference") {
    return `Couldn’t ${action}: the reference was removed in another window.`;
  }
  if (result.status === "missing-phase") {
    return `Couldn’t ${action}: the phase was removed in another window.`;
  }
  if (result.status === "failed" && result.reason === "invalid") {
    return `Couldn’t ${action}: Project Notes rejected the change. Review the reference and try again.`;
  }
  if (result.status === "failed" && result.reason === "corrupt") {
    return `Couldn’t ${action}: Project Notes are unreadable. Repair or restore project storage first.`;
  }
  if (result.status === "failed" && result.reason === "missing") {
    return `Couldn’t ${action}: project Notes storage is missing. Reopen the project and try again.`;
  }
  return `Couldn’t ${action} the reference. Check Notes storage and try again.`;
}

export function phaseNextAction(phase: NotesPhase, actionLabel: string): string {
  if (actionLabel === "Start") return "Start this phase";
  if (actionLabel === "Recover") return "Recover the missing session";
  if (actionLabel === "Resume") return "Resume the linked session";
  if (actionLabel === "Retry") return "Retry this phase";
  return phase.status === "done"
    ? "Review completion; archive when ready"
    : "Review completion evidence";
}

export function savedPromptPreview(sourcePrompt: string): string {
  const normalized = sourcePrompt.trim().replace(/\s+/g, " ");
  return normalized.length > 140 ? `${normalized.slice(0, 137)}…` : normalized;
}

export function lines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function reminderRowLabel(phase: NotesPhase, now: Date): string {
  const reminder = phase.reminder;
  if (!reminder) return "No reminder";
  const due = new Date(reminder.dueAt);
  if (due.getTime() <= now.getTime()) return "Due now";
  if (
    due.getFullYear() === now.getFullYear() &&
    due.getMonth() === now.getMonth() &&
    due.getDate() === now.getDate()
  ) {
    return `Reminder today, ${timeFormatter.format(due)}`;
  }
  return `Reminder ${dateTimeFormatter.format(due)}`;
}

export function formatTime(value: string): string {
  return timeFormatter.format(new Date(value));
}

export function formatDate(value: string): string {
  return dateFormatter.format(new Date(value));
}

export function formatDateTime(value: string): string {
  return dateTimeFormatter.format(new Date(value));
}
