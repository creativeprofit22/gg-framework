import type { NotesPhase, NotesPhaseStatus } from "./notes-types";

export type NotesPhaseStatusTone = "neutral" | "active" | "positive" | "warning";
export type NotesLifecycleStage = "Planning" | "Implementation" | "Review" | "Verification";

/** The only user-facing word and tone for each stored phase status. */
export const NOTES_PHASE_STATUS_PRESENTATION = {
  "not-started": { label: "Not started", tone: "neutral" },
  planning: { label: "Planning", tone: "neutral" },
  "waiting-for-approval": { label: "Needs approval", tone: "neutral" },
  "in-progress": { label: "In progress", tone: "active" },
  review: { label: "In review", tone: "active" },
  done: { label: "Done", tone: "positive" },
  "needs-attention": { label: "Needs attention", tone: "warning" },
  cancelled: { label: "Cancelled", tone: "neutral" },
} as const satisfies Record<
  NotesPhaseStatus,
  { readonly label: string; readonly tone: NotesPhaseStatusTone }
>;

export type NotesPhaseStatusLabel =
  (typeof NOTES_PHASE_STATUS_PRESENTATION)[NotesPhaseStatus]["label"];

export function notesPhaseStatusLabel(status: NotesPhaseStatus): NotesPhaseStatusLabel {
  return NOTES_PHASE_STATUS_PRESENTATION[status].label;
}

export function notesPhaseStatusTone(status: NotesPhaseStatus): NotesPhaseStatusTone {
  return NOTES_PHASE_STATUS_PRESENTATION[status].tone;
}

export interface NotesLifecyclePresentation {
  state: NotesPhaseStatusLabel;
  tone: NotesPhaseStatusTone;
  stage: NotesLifecycleStage;
}

type PresentablePhase = Pick<NotesPhase, "status" | "lifecycleEvents" | "roadmapEvents">;

export function notesLifecyclePresentation(phase: PresentablePhase): NotesLifecyclePresentation {
  return {
    state: notesPhaseStatusLabel(phase.status),
    tone: notesPhaseStatusTone(phase.status),
    stage: lifecycleStage(phase),
  };
}

function lifecycleStage(phase: PresentablePhase): NotesLifecycleStage {
  if (phase.status === "done") return "Verification";
  if (phase.status === "review") return reviewStage(phase);
  if (phase.status === "in-progress") return "Implementation";
  if (
    phase.status === "not-started" ||
    phase.status === "planning" ||
    phase.status === "waiting-for-approval"
  ) {
    return "Planning";
  }

  const latestTransition = phase.lifecycleEvents[phase.lifecycleEvents.length - 1];
  if (!latestTransition) return "Implementation";
  return stageForStatus(latestTransition.fromStatus, phase);
}

function stageForStatus(
  status: NotesPhaseStatus | null | undefined,
  phase: PresentablePhase,
): NotesLifecycleStage {
  if (status === "review" || status === "done") return reviewStage(phase);
  if (status === "in-progress" || status === "cancelled" || status === "needs-attention") {
    return "Implementation";
  }
  return "Planning";
}

function reviewStage(phase: PresentablePhase): "Review" | "Verification" {
  for (let index = phase.roadmapEvents.length - 1; index >= 0; index -= 1) {
    const event = phase.roadmapEvents[index];
    if (event?.type === "completion-review") return "Review";
    if (event?.type === "status-update" && event.verification !== null) return "Verification";
    if (event?.type === "implementation-checkpoint") break;
  }

  return "Review";
}
