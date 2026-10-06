import type {
  ProgrammaticChatAction,
  ProgrammaticChatConfiguration,
  ProgrammaticChatDetail,
  ProgrammaticChatProposal,
  ProgrammaticChatReport,
  ProgrammaticChatResponse,
} from "@kenkaiiii/gg-core/programmatic-chat-contract";

import type { ProgrammaticAssessmentEvent } from "@kenkaiiii/gg-core/programmatic-assessment-contract";

import {
  assessmentEvent,
  assessmentResponse,
  assessmentInterrupted,
  selectCandidate,
  discoveryResponse,
  initialDiscoveryChatState,
  type DiscoveryChatState,
} from "./programmatic-discovery-state";
export type { ProgrammaticSelection } from "./programmatic-discovery-state";

export interface ProgrammaticChatState extends DiscoveryChatState {
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
  ...initialDiscoveryChatState(),
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
  | { type: "select-candidate"; source: "current" | "history"; id: string }
  | { type: "assessment"; generation: string; event: ProgrammaticAssessmentEvent }
  | {
      type: "start";
      generation: string;
      epoch: number;
      operation: ProgrammaticChatState["operation"];
      assessmentRequest?: NonNullable<ProgrammaticChatState["assessmentRequest"]>;
    }
  | { type: "response"; generation: string; epoch: number; response: ProgrammaticChatResponse }
  | { type: "error"; generation: string; epoch: number; error: string; reconcile: boolean }
  | { type: "run-accepted"; generation: string; epoch: number };

export function programmaticChatReducer(
  state: ProgrammaticChatState,
  event: ProgrammaticChatEvent,
): ProgrammaticChatState {
  if (event.type === "reset") return initialProgrammaticChatState(event.generation);
  if (event.type === "select-candidate") return selectCandidate(state, event.source, event.id);
  if (event.type === "select")
    return {
      ...state,
      selection: { source: "deterministic", id: event.id },
      selectedId: event.id,
      detail: null,
      detailSnapshot: null,
      missingSelection: false,
    };
  if (event.generation !== state.generation) return state;
  if (event.type === "assessment") return assessmentEvent(state, event.event);
  if (event.type === "start") {
    if (event.epoch <= state.epoch) return state;
    return {
      ...state,
      epoch: event.epoch,
      operation: event.operation,
      error: null,
      notice: "",
      assessmentRequestSequence: state.assessmentSequence,
      assessmentRequest: event.assessmentRequest ?? null,
      ...(["discover", "inspect-setup", "scan"].includes(event.operation ?? "")
        ? {
            assessmentRetained: !!state.assessment,
            discoveryStale: true,
            candidateStale: !!state.candidateDetail,
          }
        : {}),
    };
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
      ...assessmentInterrupted(state),
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
  const responseDisplay = assessmentResponse(state, response);
  if (!response.ok)
    return {
      ...state,
      operation: null,
      ...assessmentInterrupted(state),
      ...responseDisplay,
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
    case "discover":
      return {
        ...base,
        ...responseDisplay,
        notice: "Suggestions received. No suggested task has been started.",
      };
    case "review-candidate":
    case "history-report":
    case "history-detail":
    case "history-inspect-decision":
    case "history-inspect-correspondence":
    case "history-apply":
      return discoveryResponse(base, response);
    case "report":
      return {
        ...base,
        report: response.report,
        configuration: response.report.configuration ?? state.configuration,
        proposalApprovable:
          state.proposalApprovable &&
          (!response.report.configuration ||
            ((response.report.configuration.status !== "current" ||
              state.proposal?.operation === "history-upgrade") &&
              response.report.configuration.status !== "unreadable" &&
              response.report.configuration.status === state.proposal?.configuration.status &&
              response.report.configuration.currentFingerprint === state.proposal?.fingerprint)),
        reconcile: false,
        notice: `${response.report.total} saved check results. AI suggestions are shown separately.`,
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
        ...responseDisplay,
        proposal: response.proposal,
        configuration: response.proposal.configuration,
        proposalApprovable:
          response.proposal.handle !== null && response.proposal.operation !== "current",
        notice:
          response.proposal.operation === "current"
            ? "Saved settings are up to date. Nothing needs to be saved."
            : response.proposal.operation === "refresh"
              ? "Setup refresh is ready to review. No files have been changed."
              : "Setup is ready to review. No files have been changed.",
      };
    case "approve-setup":
      return {
        ...base,
        proposal: null,
        proposalApprovable: false,
        notice: "Setup saved. Choose Run project checks when you are ready.",
      };
    case "scan":
      return {
        ...base,
        ...responseDisplay,
        notice: "Loading saved check results.",
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
  canReviewProgrammaticCandidate,
} from "./programmatic-chat-selectors";
