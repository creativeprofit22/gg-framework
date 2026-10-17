import {
  isRoadmapPhaseDraft,
  isRoadmapPhaseEditDraft,
  type RoadmapPhaseNotEditableReason,
  type RoadmapPhaseDraft,
  type RoadmapPhaseDraftApprovalResult,
  type RoadmapPhaseDraftRejectionResult,
} from "@kenkaiiii/gg-core/roadmap-workflow";

export function normalizeRoadmapPhaseDraft(value: unknown): RoadmapPhaseDraft | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  // Edit drafts have no legacy wire forms to fill in.
  if (candidate.kind === "edit") return isRoadmapPhaseDraft(candidate) ? candidate : null;
  if (!Array.isArray(candidate.phases)) return null;
  const normalized = {
    ...candidate,
    references: candidate.references ?? [],
    sourcesNotCited: candidate.sourcesNotCited ?? null,
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

export interface RoadmapDraftDescription {
  /** Review dock label. */
  label: string;
  /** Review dock one-line summary. */
  summary: string;
  /** Accessible name of the header trigger. */
  triggerLabel: string;
  /** Visible count badge on the header trigger. */
  count: number;
}

/** Shared wording for the review dock item and header trigger of either draft kind. */
export function describeRoadmapDraft(draft: RoadmapPhaseDraft): RoadmapDraftDescription {
  const status = draft.status === "stale" ? "Out of date" : "Approval required";
  if (isRoadmapPhaseEditDraft(draft)) {
    const fields = draft.changes.length;
    const changed = `${fields} changed ${fields === 1 ? "field" : "fields"}`;
    return {
      label: "Roadmap phase edit",
      summary: `${changed} · ${status}`,
      triggerLabel: `Review Roadmap phase edit with ${changed}`,
      count: fields,
    };
  }
  const phases = draft.phases.length;
  return {
    label: "Roadmap draft",
    summary: `${phases} proposed phases · ${status}`,
    triggerLabel: `Review Roadmap draft with ${phases} proposed ${phases === 1 ? "phase" : "phases"}`,
    count: phases,
  };
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
          ? staleAnnouncement(draft)
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
          ? staleAnnouncement(draft)
          : isRoadmapPhaseEditDraft(draft)
            ? "A Roadmap phase edit is ready for review."
            : "A Roadmap draft is ready for review.",
    eventVersion: state.eventVersion + (event ? 1 : 0),
  };
}

function isEditing(state: RoadmapPhaseDraftState): boolean {
  return state.draft !== null && isRoadmapPhaseEditDraft(state.draft);
}

function staleAnnouncement(draft: RoadmapPhaseDraft): string {
  return isRoadmapPhaseEditDraft(draft)
    ? "Roadmap phase edit is out of date and cannot be applied."
    : "Roadmap draft is stale and cannot be created.";
}

const NOT_EDITABLE_ANNOUNCEMENTS: Record<RoadmapPhaseNotEditableReason, string> = {
  done: "This phase is now Done, so the edit cannot be applied. Nothing was saved.",
  archived: "This phase is now archived, so the edit cannot be applied. Nothing was saved.",
  deleted: "This phase was deleted, so the edit cannot be applied. Nothing was saved.",
  missing: "This phase no longer exists, so the edit cannot be applied. Nothing was saved.",
};

function markStale(state: RoadmapPhaseDraftState, announcement: string): RoadmapPhaseDraftState {
  return {
    ...state,
    draft: state.draft ? { ...state.draft, status: "stale" } : null,
    decision: "idle",
    error: null,
    announcement,
  };
}

function applyApprovalResult(
  state: RoadmapPhaseDraftState,
  result: RoadmapPhaseDraftApprovalResult,
): RoadmapPhaseDraftState {
  switch (result.status) {
    case "edited":
      return {
        ...state,
        draft: null,
        open: false,
        decision: "idle",
        error: null,
        announcement: "Updated Roadmap phase.",
      };
    case "phase-changed":
      return markStale(
        state,
        "This phase changed after the edit was proposed. Nothing was saved. Ask GG Coder for a fresh edit.",
      );
    case "phase-not-editable":
      return markStale(state, NOT_EDITABLE_ANNOUNCEMENTS[result.reason]);
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
      return markStale(
        state,
        isEditing(state)
          ? `This edit is based on revision ${result.expectedRevision}; Project Notes is now revision ${result.currentRevision}. Nothing was saved. Ask GG Coder for a fresh edit.`
          : `This draft is based on revision ${result.expectedRevision}; Project Notes is now revision ${result.currentRevision}. Ask GG Coder for a fresh draft.`,
      );
    case "already-decided":
      return {
        ...state,
        draft: null,
        open: false,
        decision: "idle",
        error: null,
        announcement: alreadyDecidedAnnouncement(state, result.decision),
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
        error: isEditing(state)
          ? "Project Notes needs repair before editing phases."
          : "Project Notes needs repair before creating phases.",
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
        announcement: isEditing(state) ? "Roadmap phase edit rejected." : "Roadmap draft rejected.",
      };
    case "already-decided":
      return {
        ...state,
        draft: null,
        open: false,
        decision: "idle",
        error: null,
        announcement: alreadyDecidedAnnouncement(state, result.decision),
      };
    case "proposal-not-found":
    case "proposal-project-mismatch":
      return clearUnavailableDraft(state);
  }
}

function alreadyDecidedAnnouncement(
  state: RoadmapPhaseDraftState,
  decision: "approved" | "rejected",
): string {
  if (isEditing(state)) {
    return decision === "approved"
      ? "This Roadmap phase edit was already applied."
      : "This Roadmap phase edit was already rejected.";
  }
  return decision === "approved"
    ? "This Roadmap draft was already created."
    : "This Roadmap draft was already rejected.";
}

function clearUnavailableDraft(state: RoadmapPhaseDraftState): RoadmapPhaseDraftState {
  const message = isEditing(state)
    ? "This Roadmap phase edit is no longer available for this project."
    : "This Roadmap draft is no longer available for this project.";
  return {
    ...state,
    draft: null,
    open: false,
    decision: "idle",
    error: message,
    announcement: message,
  };
}
