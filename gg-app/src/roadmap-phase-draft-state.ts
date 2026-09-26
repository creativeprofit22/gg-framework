import {
  isRoadmapPhaseDraft,
  type RoadmapPhaseDraft,
  type RoadmapPhaseDraftApprovalResult,
  type RoadmapPhaseDraftRejectionResult,
} from "@kenkaiiii/gg-core/roadmap-workflow";

export function normalizeRoadmapPhaseDraft(value: unknown): RoadmapPhaseDraft | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.phases)) return null;
  const normalized = {
    ...candidate,
    references: candidate.references ?? [],
    phases: candidate.phases.map((phase) =>
      typeof phase === "object" && phase !== null && !Array.isArray(phase)
        ? {
            ...(phase as Record<string, unknown>),
            referenceIds: (phase as Record<string, unknown>).referenceIds ?? [],
          }
        : phase,
    ),
  };
  return isRoadmapPhaseDraft(normalized) ? normalized : null;
}

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
  | { type: "failed"; message: string }
  | { type: "refresh-failed"; message: string; startedAtEventVersion: number }
  | { type: "reset" };

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
      return receiveDraft(state, action.draft, false);
    case "event":
      return receiveDraft(state, action.draft, true);
    case "reset":
      return { ...initialRoadmapPhaseDraftState, eventVersion: state.eventVersion + 1 };
    case "refresh-failed":
      return action.startedAtEventVersion === state.eventVersion
        ? { ...state, error: action.message }
        : state;
    /* New drafts arrive compact; replay never changes inspection/decision state. */
    case "open":
      return state.draft ? { ...state, open: true } : state;
    case "dismiss":
      return { ...state, open: false };
    case "decision-started":
      return {
        ...state,
        decision: action.decision,
        error: null,
        announcement: "",
        eventVersion: state.eventVersion + 1,
      };
    case "approval-result":
      return applyApprovalResult({ ...state, eventVersion: state.eventVersion + 1 }, action.result);
    case "rejection-result":
      return applyRejectionResult(
        { ...state, eventVersion: state.eventVersion + 1 },
        action.result,
      );
    case "failed":
      return {
        ...state,
        decision: "idle",
        error: action.message,
        announcement: "",
        eventVersion: state.eventVersion + 1,
      };
  }
}

function receiveDraft(
  state: RoadmapPhaseDraftState,
  draft: RoadmapPhaseDraft | null,
  event: boolean,
): RoadmapPhaseDraftState {
  const same = state.draft?.id === draft?.id && state.draft?.projectKey === draft?.projectKey;
  if (same)
    return {
      ...state,
      draft,
      announcement:
        draft?.status === "stale" && state.draft?.status !== "stale"
          ? "Roadmap draft is stale and cannot be created."
          : state.announcement,
      eventVersion: state.eventVersion + (event ? 1 : 0),
    };
  return {
    ...state,
    draft,
    open: false,
    decision: "idle",
    error: null,
    announcement:
      draft === null
        ? "Roadmap draft decision recorded."
        : draft.status === "stale"
          ? "Roadmap draft is stale and cannot be created."
          : "A Roadmap draft is ready for review.",
    eventVersion: state.eventVersion + (event ? 1 : 0),
  };
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
