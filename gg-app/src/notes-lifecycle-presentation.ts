import type { NotesPhase, NotesPhaseStatus } from "./notes-types";

export type NotesLifecycleState = "Ready" | "Working" | "Needs you" | "Done";
export type NotesLifecycleStage = "Planning" | "Implementation" | "Review" | "Verification";

export interface NotesLifecyclePresentation {
  state: NotesLifecycleState;
  stage: NotesLifecycleStage;
}

type PresentablePhase = Pick<NotesPhase, "status" | "lifecycleEvents" | "roadmapEvents">;

export function notesLifecyclePresentation(phase: PresentablePhase): NotesLifecyclePresentation {
  return {
    state: lifecycleState(phase.status),
    stage: lifecycleStage(phase),
  };
}

function lifecycleState(status: NotesPhaseStatus): NotesLifecycleState {
  if (status === "not-started") return "Ready";
  if (status === "waiting-for-approval" || status === "needs-attention" || status === "cancelled") {
    return "Needs you";
  }
  if (status === "done") return "Done";
  return "Working";
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
