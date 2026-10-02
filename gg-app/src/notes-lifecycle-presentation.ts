import type { NotesPhase, NotesPhaseStatus } from "./notes-types";
import { activeRoadmapBlocker } from "./notes-roadmap/roadmap-presentation";

export type NotesLifecycleState = "Ready" | "Working" | "Needs you" | "Blocked" | "Done";
export type NotesLifecycleStage = "Planning" | "Implementation" | "Review" | "Verification";

export interface NotesLifecyclePresentation {
  state: NotesLifecycleState;
  stage: NotesLifecycleStage;
}

type PresentablePhase = Pick<
  NotesPhase,
  "status" | "attentionReason" | "lifecycleEvents" | "roadmapEvents"
>;

export function notesLifecyclePresentation(phase: PresentablePhase): NotesLifecyclePresentation {
  return {
    state: lifecycleState(phase),
    stage: lifecycleStage(phase),
  };
}

function lifecycleState(phase: PresentablePhase): NotesLifecycleState {
  if (phase.status === "not-started") return "Ready";
  if (activeRoadmapBlocker(phase)) return "Blocked";
  if (
    phase.status === "waiting-for-approval" ||
    phase.status === "needs-attention" ||
    phase.status === "cancelled"
  ) {
    return "Needs you";
  }
  if (phase.status === "done") return "Done";
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
