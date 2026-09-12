import type {
  ProgrammaticChatAction,
  ProgrammaticChatDetail,
  ProgrammaticChatProposal,
  ProgrammaticChatReport,
  ProgrammaticChatResponse,
} from "@kenkaiiii/gg-core/programmatic-chat-contract";

export interface ProgrammaticChatState {
  generation: string;
  epoch: number;
  report: ProgrammaticChatReport | null;
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
  epoch: 0,
  report: null,
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
  if (event.type === "start") {
    if (event.epoch <= state.epoch) return state;
    return { ...state, epoch: event.epoch, operation: event.operation, error: null, notice: "" };
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
      notice: "Run submitted. Follow its separate approval and progress in this chat.",
    };
  const response = event.response;
  if (!response.ok)
    return {
      ...state, operation: null, error: response.error, reconcile: response.reconcile,
      proposalApprovable:
        response.action === "approve-setup" || response.action === "inspect-setup"
          ? state.proposalApprovable && !!state.proposal &&
            response.approvableProposalHandle === state.proposal.handle
          : state.proposalApprovable,
    };
  const base = { ...state, operation: null, error: null };
  switch (response.action) {
    case "report":
      return {
        ...base,
        report: response.report,
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
        proposal: response.proposal,
        proposalApprovable: true,
        notice: "Proposal ready. No files were written.",
      };
    case "approve-setup":
      return { ...base, proposal: null, proposalApprovable: false, notice: "Setup approved. Scan to review opportunities." };
    case "scan":
      return { ...base, notice: "Scan finished. Updating the report." };
    case "dismiss":
      return {
        ...base,
        detailSnapshot: null,
        notice: "Dismissal acknowledged. Updating the report.",
      };
  }
}

export function canRunProgrammaticSelection(state: ProgrammaticChatState): boolean {
  return (
    !state.operation &&
    !state.reconcile &&
    state.report?.status === "current" &&
    state.detailSnapshot === state.report.snapshot &&
    state.detail?.summary.id === state.selectedId &&
    state.detail.summary.route.available === true &&
    state.detail.summary.actions?.run.available === true
  );
}
