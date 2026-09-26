import type {
  ProgrammaticAssessment,
  ProgrammaticAssessmentEvent,
  ProgrammaticAssessmentIdentity,
} from "@kenkaiiii/gg-core/programmatic-assessment-contract";
import type { ProgrammaticChatResponse } from "@kenkaiiii/gg-core/programmatic-chat-contract";
import type {
  DiscoveryCandidate,
  DiscoveryProjection,
  DiscoveryReview,
  RecommendationHistoryReport,
  RecommendationDetail,
} from "@kenkaiiii/gg-core/programmatic-recommendation-contract";
import type { ProgrammaticChatState } from "./programmatic-chat-state";

export type ProgrammaticSelection =
  { source: "deterministic"; id: string } | { source: "current" | "history"; id: string };
export interface DiscoveryChatState {
  assessment: ProgrammaticAssessment | null;
  assessmentSequence: number;
  assessmentRequestSequence: number;
  assessmentPending: boolean;
  /** The displayed assessment predates a refresh; independent of retained candidates. */
  assessmentRetained: boolean;
  assessmentUncertain: boolean;
  assessmentIdentity: ProgrammaticAssessmentIdentity | null;
  assessmentRequest: { requestId: string; sessionId: string; conversationId: string } | null;
  selection: ProgrammaticSelection | null;
  discovery: DiscoveryProjection | null;
  /** Freshness only; a completed empty projection does not establish evidence sufficiency or a no-op verdict. */
  discoveryStale: boolean;
  candidateDetail: DiscoveryCandidate | null;
  candidateStale: boolean;
  candidateReview: DiscoveryReview | null;
  historyReport: RecommendationHistoryReport | null;
  historyDetail: RecommendationDetail | null;
  historyReportStale: boolean;
  historyDetailStale: boolean;
  /** Highest accepted save receipt; display freshness only, never approval authority. */
  historyRevision: number;
  /** Reads already in flight cannot reconcile a later uncertain save. */
  historyInvalidatedEpoch: number;
}
export const initialDiscoveryChatState = (): DiscoveryChatState => ({
  assessment: null,
  assessmentSequence: 0,
  assessmentRequestSequence: 0,
  assessmentPending: false,
  assessmentUncertain: false,
  assessmentRetained: false,
  assessmentIdentity: null,
  assessmentRequest: null,
  selection: null,
  discovery: null,
  discoveryStale: false,
  candidateDetail: null,
  candidateStale: false,
  candidateReview: null,
  historyReport: null,
  historyDetail: null,
  historyReportStale: false,
  historyDetailStale: false,
  historyRevision: 0,
  historyInvalidatedEpoch: -1,
});
export function assessmentEvent(
  state: ProgrammaticChatState,
  update: ProgrammaticAssessmentEvent,
): ProgrammaticChatState {
  const owner = state.assessmentRequest ?? state.assessmentIdentity;
  if (owner && !sameOwner(owner, update)) return state;
  if (
    update.sequence < state.assessmentSequence ||
    (update.sequence === state.assessmentSequence &&
      ((!state.assessmentPending && !state.assessmentUncertain) || update.phase === "started"))
  )
    return state;
  // Do not touch request epochs, exact proposals, or their approval ownership.
  return {
    ...state,
    assessmentSequence: update.sequence,
    assessmentIdentity: update,
    assessmentUncertain: false,
    assessmentPending: update.phase === "started",
    ...(update.phase === "completed"
      ? assessmentDisplay(state, update.assessment)
      : {
          assessmentRetained: !!state.assessment,
          discoveryStale: true,
          candidateStale: !!state.candidateDetail,
        }),
  };
}
const sameOwner = (
  a: { sessionId: string; conversationId: string },
  b: { sessionId: string; conversationId: string },
) => a.sessionId === b.sessionId && a.conversationId === b.conversationId;
/** Unknown transport is not evidence that the provider is still running. Keep review stale,
 * allow a later matching completion, and never start work to reconcile the display. */
export function assessmentInterrupted(
  state: ProgrammaticChatState,
): Partial<ProgrammaticChatState> {
  const request = state.assessmentRequest,
    identity = state.assessmentIdentity;
  return state.assessmentPending &&
    request &&
    identity &&
    sameOwner(request, identity) &&
    request.requestId === identity.requestId
    ? {
        assessmentPending: false,
        assessmentUncertain: true,
        discoveryStale: true,
        candidateStale: !!state.candidateDetail,
      }
    : {};
}
/** The reducer has already checked generation and request epoch. A receipt may settle
 * its own started event, but cannot replace a newer or already completed assessment. */
export function assessmentResponse(
  state: ProgrammaticChatState,
  response: ProgrammaticChatResponse,
): Partial<ProgrammaticChatState> {
  if (!("assessment" in response) || !response.assessment) return {};
  const assessment = response.assessment,
    receipt = assessment.lifecycle,
    request = state.assessmentRequest;
  if (!receipt)
    return state.assessmentSequence > state.assessmentRequestSequence
      ? {}
      : assessmentDisplay(state, assessment);
  if (
    response.action !== state.operation ||
    !request ||
    !sameOwner(request, receipt) ||
    receipt.requestId !== request.requestId ||
    receipt.sequence <= state.assessmentRequestSequence ||
    receipt.sequence < state.assessmentSequence
  )
    return {};
  if (
    receipt.sequence === state.assessmentSequence &&
    ((!state.assessmentPending && !state.assessmentUncertain) ||
      !state.assessmentIdentity ||
      !sameOwner(receipt, state.assessmentIdentity) ||
      receipt.requestId !== state.assessmentIdentity.requestId)
  )
    return {};
  return {
    ...assessmentDisplay(state, assessment),
    assessmentSequence: receipt.sequence,
    assessmentIdentity: receipt,
    assessmentPending: false,
    assessmentUncertain: false,
  };
}
/** Called only after the existing reducer's generation/sequence/epoch guards. */
export function assessmentDisplay(
  state: ProgrammaticChatState,
  assessment: ProgrammaticAssessment | null,
): Partial<ProgrammaticChatState> {
  const latest = assessment?.discovery;
  const history = assessment?.history;
  const historyRevision = Math.max(
    state.historyRevision,
    history?.status === "saved" ? history.historyRevision : 0,
  );
  const uncertain = history?.status === "acknowledgement-unknown";
  const historyReportStale =
    state.historyReportStale ||
    (!!state.historyReport && (uncertain || state.historyReport.revision < historyRevision));
  const historyDetailStale =
    state.historyDetailStale ||
    (!!state.historyDetail && (uncertain || state.historyDetail.historyRevision < historyRevision));
  const selected =
    state.selection?.source === "current"
      ? latest?.candidates.find((candidate) => candidate.candidateId === state.selection?.id)
      : undefined;
  return {
    historyRevision,
    historyReportStale,
    historyDetailStale,
    historyInvalidatedEpoch: uncertain ? state.epoch : state.historyInvalidatedEpoch,
    assessment: assessment ?? state.assessment,
    assessmentRetained: assessment ? false : state.assessmentRetained,
    discovery: latest ?? state.discovery,
    discoveryStale: !latest || assessment?.status !== "completed",
    candidateDetail: selected ?? state.candidateDetail,
    candidateStale: !!state.candidateDetail && (!selected || assessment?.status !== "completed"),
  };
}
export function selectCandidate(
  state: ProgrammaticChatState,
  source: "current" | "history",
  id: string,
): ProgrammaticChatState {
  const candidate =
    source === "current"
      ? state.discovery?.candidates.find((item) => item.candidateId === id)
      : state.historyDetail?.candidate.id === id
        ? state.historyDetail.discovery
        : undefined;
  return {
    ...state,
    selection: { source, id },
    candidateDetail: candidate ?? null,
    candidateReview: null,
    candidateStale:
      source === "history" ||
      state.discoveryStale ||
      state.assessmentPending ||
      state.assessment?.status !== "completed" ||
      !state.assessment.discovery?.candidates.some((item) => item.candidateId === id),
  };
}
type DiscoveryResponse = Extract<
  ProgrammaticChatResponse,
  {
    ok: true;
    action:
      | "review-candidate"
      | "history-report"
      | "history-detail"
      | "history-inspect-decision"
      | "history-inspect-correspondence"
      | "history-apply";
  }
>;
export function discoveryResponse(
  state: ProgrammaticChatState,
  response: DiscoveryResponse,
): ProgrammaticChatState {
  switch (response.action) {
    case "review-candidate": {
      const candidate = response.candidateReview.candidate;
      if (
        state.selection?.source !== "current" ||
        candidate.candidateId !== state.selection.id ||
        candidate.assessmentId !== state.candidateDetail?.assessmentId ||
        candidate.revision !== state.candidateDetail.revision ||
        state.candidateStale
      )
        return state;
      return {
        ...state,
        candidateReview: response.candidateReview,
        notice: response.candidateReview.summary,
      };
    }
    case "history-report":
      return {
        ...state,
        historyReport: response.report,
        historyReportStale:
          response.report.revision < state.historyRevision ||
          state.epoch <= state.historyInvalidatedEpoch ||
          (state.historyReportStale && !["ready", "recovered"].includes(response.report.status)),
      };
    case "history-detail": {
      if (
        state.selection?.source !== "history" ||
        (response.detail && state.selection.id !== response.detail.candidate.id)
      )
        return state;
      return {
        ...state,
        historyDetail: response.detail ?? state.historyDetail,
        historyDetailStale:
          !response.detail ||
          response.detail.historyRevision < state.historyRevision ||
          state.epoch <= state.historyInvalidatedEpoch,
        candidateDetail: response.detail?.discovery ?? state.candidateDetail,
        candidateStale: true,
        notice: response.detail
          ? "Historical proposal. Fresh inspection is required before review."
          : "This historical candidate is unavailable; previous detail is retained.",
      };
    }
    case "history-inspect-decision":
    case "history-inspect-correspondence":
      return { ...state, notice: "History decision inspection returned; no decision was applied." };
    case "history-apply":
      return {
        ...state,
        candidateStale: true,
        notice: response.changed
          ? "History decision saved. Reload the selected historical detail."
          : "No history decision changed.",
      };
  }
}
