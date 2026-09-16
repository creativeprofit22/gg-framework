import type {
  ProgrammaticChatAction,
  ProgrammaticChatConfiguration,
  ProgrammaticChatDetail,
  ProgrammaticChatProposal,
  ProgrammaticChatReport,
  ProgrammaticChatResponse,
} from "@kenkaiiii/gg-core/programmatic-chat-contract";

import type { ProgrammaticAssessment, ProgrammaticAssessmentEvent } from "@kenkaiiii/gg-core/programmatic-assessment-contract";

export interface ProgrammaticChatState {
  assessment: ProgrammaticAssessment | null;
  assessmentSequence: number;
  assessmentRequestSequence: number;
  assessmentPending: boolean;
  generation: string;
  epoch: number;
  report: ProgrammaticChatReport | null;
  /** Latest accepted setup assessment, independent of lifecycle/scan snapshots. */
  configuration: ProgrammaticChatConfiguration | null;
  selectedId: string | null;
  detail: ProgrammaticChatDetail | null;
  detailSnapshot: string | null;
  missingSelection: boolean;
  proposal: ProgrammaticChatProposal | null;
  proposalApprovable: boolean;
  operation: ProgrammaticChatAction | "run" | null;
  error: string | null;
  reconcile: boolean;
  notice: string;
}
export const initialProgrammaticChatState = (generation: string): ProgrammaticChatState => ({
  generation,
  assessment: null,
  assessmentSequence: 0,
  assessmentRequestSequence: 0,
  assessmentPending: false,
  epoch: 0,
  report: null,
  configuration: null,
  selectedId: null,
  detail: null,
  detailSnapshot: null,
  missingSelection: false,
  proposal: null,
  proposalApprovable: false,
  operation: null,
  error: null,
  reconcile: false,
  notice: "",
});
export type ProgrammaticChatEvent =
  | { type: "reset"; generation: string }
  | { type: "select"; id: string }
  | { type: "assessment"; generation: string; event: ProgrammaticAssessmentEvent }
  | {
      type: "start";
      generation: string;
      epoch: number;
      operation: ProgrammaticChatState["operation"];
    }
  | { type: "response"; generation: string; epoch: number; response: ProgrammaticChatResponse }
  | { type: "error"; generation: string; epoch: number; error: string; reconcile: boolean }
  | { type: "run-accepted"; generation: string; epoch: number };

export function programmaticChatReducer(
  state: ProgrammaticChatState,
  event: ProgrammaticChatEvent,
): ProgrammaticChatState {
  if (event.type === "reset") return initialProgrammaticChatState(event.generation);
  if (event.type === "select")
    return {
      ...state,
      selectedId: event.id,
      detail: null,
      detailSnapshot: null,
      missingSelection: false,
    };
  if (event.generation !== state.generation) return state;
  if (event.type === "assessment") {
    const update = event.event;
    if (update.sequence < state.assessmentSequence ||
      (update.sequence === state.assessmentSequence && (!state.assessmentPending || update.phase === "started"))) return state;
    // Do not touch request epochs, exact proposals, or their approval ownership.
    return { ...state, assessmentSequence: update.sequence,
      assessmentPending: update.phase === "started",
      assessment: update.phase === "completed" ? update.assessment : null };
  }
  if (event.type === "start") {
    if (event.epoch <= state.epoch) return state;
    return { ...state, epoch: event.epoch, operation: event.operation, error: null, notice: "",
      assessmentRequestSequence: state.assessmentSequence,
      ...(["inspect-setup", "scan"].includes(event.operation ?? "") ? { assessment: null } : {}) };
  }
  if (event.epoch !== state.epoch) return state;
  if (event.type === "error")
    return {
      ...state,
      operation: null,
      proposalApprovable:
        state.operation === "approve-setup" || state.operation === "inspect-setup"
          ? false
          : state.proposalApprovable,
      error: event.error.slice(0, 1_000),
      reconcile: event.reconcile,
    };
  if (event.type === "run-accepted")
    return {
      ...state,
      operation: null,
      detailSnapshot: null,
      notice:
        "Task requested. Review the separate approval prompt in this chat before work starts.",
    };
  const response = event.response;
  // Host events outrank delayed button receipts, without changing exact proposal ownership.
  const responseAssessment = state.assessmentSequence > state.assessmentRequestSequence
    ? state.assessment : "assessment" in response ? response.assessment ?? null : null;
  if (!response.ok)
    return {
      ...state,
      operation: null,
      assessment: "assessment" in response ? responseAssessment : state.assessment,
      error: response.error,
      reconcile: response.reconcile,
      proposalApprovable:
        response.action === "approve-setup" || response.action === "inspect-setup"
          ? state.proposalApprovable &&
            !!state.proposal &&
            response.approvableProposalHandle === state.proposal.handle
          : state.proposalApprovable,
    };
  const base = { ...state, operation: null, error: null };
  switch (response.action) {
    case "report":
      return {
        ...base,
        report: response.report,
        configuration: response.report.configuration ?? state.configuration,
        proposalApprovable:
          state.proposalApprovable &&
          (!response.report.configuration ||
            (response.report.configuration.status !== "current" &&
              response.report.configuration.status !== "unreadable" &&
              response.report.configuration.status === state.proposal?.configuration.status &&
              response.report.configuration.currentFingerprint === state.proposal?.fingerprint)),
        reconcile: false,
        notice: `${response.report.total} opportunities. ${response.report.reason}`,
      };
    case "detail": {
      if (response.detail && response.detail.summary.id !== state.selectedId) return base;
      return {
        ...base,
        detail: response.detail,
        detailSnapshot: response.snapshot,
        missingSelection: response.detail === null,
      };
    }
    case "inspect-setup":
      return {
        ...base,
        assessment: responseAssessment,
        proposal: response.proposal,
        configuration: response.proposal.configuration,
        proposalApprovable:
          response.proposal.handle !== null && response.proposal.operation !== "current",
        notice:
          response.proposal.operation === "current"
            ? "Saved setup is current. No regeneration or approval is needed."
            : response.proposal.operation === "refresh"
              ? "Setup refresh is ready to review. No files have been changed."
              : "Setup is ready to review. No files have been changed.",
      };
    case "approve-setup":
      return {
        ...base,
        proposal: null,
        proposalApprovable: false,
        notice: "Setup saved. Choose Check for opportunities to run the saved checks.",
      };
    case "scan":
      return {
        ...base,
        assessment: responseAssessment,
        notice: "Assessment returned. Loading the saved deterministic results.",
      };
    case "dismiss":
      return {
        ...base,
        detailSnapshot: null,
        notice: "Dismissal saved. Reloading results to show the current status.",
      };
  }
}

export {
  programmaticConfiguration,
  isProgrammaticCurrentReview,
  canScanProgrammatic,
  canRunProgrammaticSelection,
} from "./programmatic-chat-selectors";
