import type {
  NotesPhase,
  NotesRoadmapPhaseAdvancementCheckpoint,
  NotesRoadmapPhaseAdvancementConfirmation,
} from "@kenkaiiii/gg-core/project-notes";
import type { ProjectNotesSnapshot } from "./project-notes-repository.js";

export type RoadmapPhaseAdvancementMode = "manual" | "autopilot";
export type RoadmapPhaseAdvancementState = "pending" | "confirmed" | "stale";

export interface RoadmapPhaseAdvancementPresentation {
  state: RoadmapPhaseAdvancementState;
  checkpoint: NotesRoadmapPhaseAdvancementCheckpoint;
  confirmation: NotesRoadmapPhaseAdvancementConfirmation | null;
  completedPhase: NotesPhase;
  nextPhase: NotesPhase | null;
}

function orderedRoadmapPhases(snapshot: ProjectNotesSnapshot): NotesPhase[] {
  return snapshot.document.phases
    .map((phase, documentIndex) => ({ phase, documentIndex }))
    .sort(
      (left, right) =>
        left.phase.order - right.phase.order || left.documentIndex - right.documentIndex,
    )
    .map(({ phase }) => phase);
}

function latestCompletionReview(phase: NotesPhase) {
  return [...phase.roadmapEvents].reverse().find((event) => event.type === "completion-review");
}

/** Select the exact first eligible phase protected by an authoritative completion review. */
export function selectNextEligibleRoadmapPhase(
  snapshot: ProjectNotesSnapshot,
  completedPhaseId: string,
  completionReviewId: string,
  mode: RoadmapPhaseAdvancementMode,
): NotesPhase | null {
  const orderedPhases = orderedRoadmapPhases(snapshot);
  const sourceIndex = orderedPhases.findIndex((phase) => phase.id === completedPhaseId);
  if (sourceIndex < 0) return null;

  const source = orderedPhases[sourceIndex]!;
  if (source.archivedAt !== null || source.status !== "done" || source.overrides.status !== null) {
    return null;
  }
  const latestReview = latestCompletionReview(source);
  const expectedReviewer = mode === "manual" ? "ken" : "ken-autopilot";
  if (
    latestReview?.type !== "completion-review" ||
    latestReview.id !== completionReviewId ||
    latestReview.reviewer !== expectedReviewer ||
    latestReview.decision !== "accepted" ||
    latestReview.gateOutcome !== "done"
  ) {
    return null;
  }

  for (let index = sourceIndex + 1; index < orderedPhases.length; index += 1) {
    const candidate = orderedPhases[index]!;
    if (
      candidate.archivedAt !== null ||
      (candidate.status !== "not-started" && candidate.status !== "planning")
    ) {
      continue;
    }
    return candidate.session === null && candidate.overrides.status === null ? candidate : null;
  }
  return null;
}

/**
 * Reconstruct the newest durable advancement checkpoint without causing side effects.
 * Restarts call this selector only to present state; they never launch a phase.
 */
export function selectLatestRoadmapPhaseAdvancement(
  snapshot: ProjectNotesSnapshot,
): RoadmapPhaseAdvancementPresentation | null {
  const candidates = orderedRoadmapPhases(snapshot).flatMap((phase, roadmapIndex) =>
    phase.roadmapEvents.flatMap((event, eventIndex) =>
      event.type === "phase-advancement-checkpoint"
        ? [{ phase, checkpoint: event, roadmapIndex, eventIndex }]
        : [],
    ),
  );
  const latest = candidates.sort((left, right) => {
    const timestampOrder =
      Date.parse(right.checkpoint.timestamp) - Date.parse(left.checkpoint.timestamp);
    return (
      timestampOrder || right.roadmapIndex - left.roadmapIndex || right.eventIndex - left.eventIndex
    );
  })[0];
  if (!latest) return null;

  const confirmation =
    latest.phase.roadmapEvents.find(
      (event): event is NotesRoadmapPhaseAdvancementConfirmation =>
        event.type === "phase-advancement-confirmation" &&
        event.checkpointId === latest.checkpoint.id,
    ) ?? null;
  const mode: RoadmapPhaseAdvancementMode =
    latest.checkpoint.reviewer === "ken" ? "manual" : "autopilot";
  const selected = selectNextEligibleRoadmapPhase(
    snapshot,
    latest.checkpoint.completedPhaseId,
    latest.checkpoint.completionReviewId,
    mode,
  );
  const nextPhase =
    snapshot.document.phases.find((phase) => phase.id === latest.checkpoint.nextPhaseId) ?? null;
  const targetMatches = selected?.id === latest.checkpoint.nextPhaseId;

  return {
    state: confirmation ? "confirmed" : targetMatches ? "pending" : "stale",
    checkpoint: latest.checkpoint,
    confirmation,
    completedPhase: latest.phase,
    nextPhase,
  };
}
