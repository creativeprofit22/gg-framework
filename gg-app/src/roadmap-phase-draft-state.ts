import type {
  RoadmapPhaseDraft,
  RoadmapPhaseDraftApprovalResult,
  RoadmapPhaseDraftRejectionResult,
} from "@kenkaiiii/gg-core/roadmap-workflow";

export interface RoadmapPhaseDraftState {
  draft: RoadmapPhaseDraft | null;
  open: boolean;
  decision: "idle" | "approving" | "rejecting";
  error: string | null;
  announcement: string;
  eventVersion: number;
}

export type RoadmapPhaseDraftAction =
  | { type: "hydrated"; draft: RoadmapPhaseDraft | null; startedAtEventVersion: number }
  | { type: "event"; draft: RoadmapPhaseDraft | null }
  | { type: "open" }
  | { type: "dismiss" }
  | { type: "decision-started"; decision: "approving" | "rejecting" }
  | { type: "approval-result"; result: RoadmapPhaseDraftApprovalResult }
  | { type: "rejection-result"; result: RoadmapPhaseDraftRejectionResult }
  | { type: "failed"; message: string };

export const initialRoadmapPhaseDraftState: RoadmapPhaseDraftState = {
  draft: null,
  open: false,
  decision: "idle",
  error: null,
  announcement: "",
  eventVersion: 0,
};

export function reduceRoadmapPhaseDraftState(
  state: RoadmapPhaseDraftState,
  action: RoadmapPhaseDraftAction,
): RoadmapPhaseDraftState {
  switch (action.type) {
    case "hydrated":
      if (action.startedAtEventVersion !== state.eventVersion) return state;
      return {
        ...state,
        draft: action.draft,
        open: action.draft !== null,
        error: null,
      };
    case "event":
      return {
        ...state,
        draft: action.draft,
        open: action.draft !== null,
        decision: "idle",
        error: null,
        announcement:
          action.draft === null
            ? "Roadmap draft decision recorded."
            : action.draft.status === "stale"
              ? "Roadmap draft is stale and cannot be created."
              : "A Roadmap draft is ready for review.",
        eventVersion: state.eventVersion + 1,
      };
    case "open":
      return state.draft ? { ...state, open: true, error: null } : state;
    case "dismiss":
      return { ...state, open: false, error: null };
    case "decision-started":
      return { ...state, decision: action.decision, error: null, announcement: "" };
    case "approval-result":
      return applyApprovalResult(state, action.result);
    case "rejection-result":
      return applyRejectionResult(state, action.result);
    case "failed":
      return { ...state, decision: "idle", error: action.message, announcement: "" };
  }
}

function applyApprovalResult(
  state: RoadmapPhaseDraftState,
  result: RoadmapPhaseDraftApprovalResult,
): RoadmapPhaseDraftState {
  switch (result.status) {
    case "created":
      return {
        ...state,
        draft: null,
        open: false,
        decision: "idle",
        error: null,
        announcement: `Created ${result.phaseIds.length} Roadmap ${result.phaseIds.length === 1 ? "phase" : "phases"}.`,
      };
    case "stale-revision":
      return {
        ...state,
        draft: state.draft ? { ...state.draft, status: "stale" } : null,
        decision: "idle",
        error: null,
        announcement: `This draft is based on revision ${result.expectedRevision}; Project Notes is now revision ${result.currentRevision}. Ask GG Coder for a fresh draft.`,
      };
    case "already-decided":
      return {
        ...state,
        draft: null,
        open: false,
        decision: "idle",
        error: null,
        announcement:
          result.decision === "approved"
            ? "This Roadmap draft was already created."
            : "This Roadmap draft was already rejected.",
      };
    case "proposal-not-found":
    case "proposal-project-mismatch":
      return clearUnavailableDraft(state);
    case "reconciliation-in-progress":
      return {
        ...state,
        decision: "idle",
        error: "Another Roadmap update is in progress. Try again when it finishes.",
      };
    case "notes-missing":
      return { ...state, decision: "idle", error: "Project Notes is missing." };
    case "notes-corrupt":
      return {
        ...state,
        decision: "idle",
        error: "Project Notes needs repair before creating phases.",
      };
    case "invalid-proposal":
    case "storage-failed":
      return { ...state, decision: "idle", error: result.message };
  }
}

function applyRejectionResult(
  state: RoadmapPhaseDraftState,
  result: RoadmapPhaseDraftRejectionResult,
): RoadmapPhaseDraftState {
  switch (result.status) {
    case "rejected":
      return {
        ...state,
        draft: null,
        open: false,
        decision: "idle",
        error: null,
        announcement: "Roadmap draft rejected.",
      };
    case "already-decided":
      return {
        ...state,
        draft: null,
        open: false,
        decision: "idle",
        error: null,
        announcement:
          result.decision === "rejected"
            ? "This Roadmap draft was already rejected."
            : "This Roadmap draft was already created.",
      };
    case "proposal-not-found":
    case "proposal-project-mismatch":
      return clearUnavailableDraft(state);
  }
}

function clearUnavailableDraft(state: RoadmapPhaseDraftState): RoadmapPhaseDraftState {
  const message = "This Roadmap draft is no longer available for this project.";
  return {
    ...state,
    draft: null,
    open: false,
    decision: "idle",
    error: message,
    announcement: message,
  };
}
