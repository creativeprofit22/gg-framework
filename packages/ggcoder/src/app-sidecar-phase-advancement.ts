import type { NotesPhase, ProjectNotesSnapshot } from "./project-notes-repository.js";

export type RoadmapPhaseAdvancementMode = "manual" | "autopilot";

export interface PendingAutopilotRoadmapAdvancement {
  completedPhaseId: string;
  reviewId: string;
  revision: number;
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

/**
 * Select the first unbound, untouched Roadmap phase after a durably completed phase.
 * The supplied completion review must still be the completed phase's latest review.
 */
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

export function resolvePendingAutopilotRoadmapAdvancement(
  snapshot: ProjectNotesSnapshot,
  pending: PendingAutopilotRoadmapAdvancement,
  guards: { enabled: boolean; cancelled: boolean },
): NotesPhase | null {
  if (!guards.enabled || guards.cancelled || snapshot.revision !== pending.revision) return null;
  return selectNextEligibleRoadmapPhase(
    snapshot,
    pending.completedPhaseId,
    pending.reviewId,
    "autopilot",
  );
}

/** Recover only the newest durable completion review, never an older superseded outcome. */
export function findPendingAutopilotRoadmapAdvancement(
  snapshot: ProjectNotesSnapshot,
): { completedPhaseId: string; reviewId: string; nextPhase: NotesPhase } | null {
  let newest: {
    reviewedAt: number;
    roadmapIndex: number;
    completedPhaseId: string;
    reviewId: string;
  } | null = null;

  orderedRoadmapPhases(snapshot).forEach((source, roadmapIndex) => {
    const review = latestCompletionReview(source);
    if (review?.type !== "completion-review") return;
    const reviewedAt = Date.parse(review.timestamp);
    if (
      newest === null ||
      reviewedAt > newest.reviewedAt ||
      (reviewedAt === newest.reviewedAt && roadmapIndex > newest.roadmapIndex)
    ) {
      newest = {
        reviewedAt,
        roadmapIndex,
        completedPhaseId: source.id,
        reviewId: review.id,
      };
    }
  });

  if (newest === null) return null;
  const source = newest as { completedPhaseId: string; reviewId: string };
  const nextPhase = selectNextEligibleRoadmapPhase(
    snapshot,
    source.completedPhaseId,
    source.reviewId,
    "autopilot",
  );
  return nextPhase
    ? { completedPhaseId: source.completedPhaseId, reviewId: source.reviewId, nextPhase }
    : null;
}
