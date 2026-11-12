import type { ProgrammaticChatConfiguration } from "@kenkaiiii/gg-core/programmatic-chat-contract";
import type { ProgrammaticChatState } from "./programmatic-chat-state";

export function programmaticConfiguration(
  state: ProgrammaticChatState,
): ProgrammaticChatConfiguration | null {
  return (
    state.configuration ?? state.report?.configuration ?? state.proposal?.configuration ?? null
  );
}

export function isProgrammaticCurrentReview(state: ProgrammaticChatState): boolean {
  const configuration = programmaticConfiguration(state);
  return (
    state.proposal?.operation === "current" &&
    configuration?.status === "current" &&
    configuration.currentFingerprint === state.proposal.fingerprint
  );
}

function setupAllowsProgrammaticExecution(state: ProgrammaticChatState): boolean {
  const configuration = programmaticConfiguration(state);
  // Older daemon reports omit assessments; retain their explicit server permissions.
  return configuration === null || configuration.status === "current";
}

export function canScanProgrammatic(state: ProgrammaticChatState): boolean {
  return (
    !state.operation &&
    !state.reconcile &&
    setupAllowsProgrammaticExecution(state) &&
    state.report?.scan.available === true
  );
}

export function canReviewProgrammaticCandidate(state: ProgrammaticChatState): boolean {
  const candidate = state.candidateDetail;
  return (
    !state.operation &&
    !state.reconcile &&
    !state.assessmentPending &&
    !state.candidateStale &&
    state.selection?.source === "current" &&
    state.selection.id === candidate?.candidateId &&
    candidate.nextStep.available &&
    state.discovery?.assessmentId === candidate.assessmentId &&
    state.discovery.candidates.some(
      (item) => item.candidateId === candidate.candidateId && item.revision === candidate.revision,
    )
  );
}

export function canRunProgrammaticSelection(state: ProgrammaticChatState): boolean {
  const configuration = programmaticConfiguration(state);
  return (
    !state.operation &&
    !state.reconcile &&
    setupAllowsProgrammaticExecution(state) &&
    (!state.selection || state.selection.source === "deterministic") &&
    (!configuration || configuration.currentFingerprint === state.report?.fingerprint) &&
    state.report?.status === "current" &&
    state.detailSnapshot === state.report.snapshot &&
    state.detail?.summary.id === state.selectedId &&
    state.detail.summary.route.available === true &&
    state.detail.summary.actions?.run.available === true
  );
}
