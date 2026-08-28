import {
  classifyRoadmapAutoStartEligibility,
  notesSessionLinksEqual,
  type NotesPhase,
  type NotesRoadmapAutoStartEligibility,
  type NotesRoadmapPhaseAdvancementCheckpoint,
  type NotesRoadmapPhaseAdvancementConfirmation,
} from "@kenkaiiii/gg-core/project-notes";
import { createActivePhaseContext, type ActivePhaseContextV1 } from "./phase-context.js";
import type {
  ProjectNotesAutomaticPhaseAdvancementOutcome,
  ProjectNotesRepository,
  ProjectNotesSnapshot,
} from "./project-notes-repository.js";

export type RoadmapPhaseAdvancementMode = "manual" | "autopilot";
export type RoadmapPhaseAdvancementState = "pending" | "confirmed" | "stale";
export type RoadmapPhaseEligibility = NotesRoadmapAutoStartEligibility;

export interface RoadmapPhaseAdvancementPresentation {
  state: RoadmapPhaseAdvancementState;
  checkpoint: NotesRoadmapPhaseAdvancementCheckpoint;
  confirmation: NotesRoadmapPhaseAdvancementConfirmation | null;
  completedPhase: NotesPhase;
  nextPhase: NotesPhase | null;
}

export interface RoadmapPhaseAdvancementSession {
  getState(): { cwd: string; sessionId: string; sessionPath: string | null };
  setActivePhaseContext(context: ActivePhaseContextV1 | undefined): Promise<void>;
}

export interface AppSidecarRoadmapPhaseAdvancementCoordinator {
  coordinate(
    checkpoint: NotesRoadmapPhaseAdvancementCheckpoint,
    expectedRevision: number,
    session: RoadmapPhaseAdvancementSession,
  ): Promise<
    ProjectNotesAutomaticPhaseAdvancementOutcome | { status: "none" | "missing-session-path" }
  >;
  recover(
    session: RoadmapPhaseAdvancementSession,
  ): Promise<
    ProjectNotesAutomaticPhaseAdvancementOutcome | { status: "none" | "missing-session-path" }
  >;
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

/** Classify every automatically startable phase after authoritative completion. */
export function selectNextEligibleRoadmapPhase(
  snapshot: ProjectNotesSnapshot,
  completedPhaseId: string,
  completionReviewId: string,
  mode: RoadmapPhaseAdvancementMode,
): RoadmapPhaseEligibility {
  const source = snapshot.document.phases.find((phase) => phase.id === completedPhaseId);
  if (
    !source ||
    source.archivedAt !== null ||
    source.status !== "done" ||
    source.overrides.status !== null
  ) {
    return { kind: "none" };
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
    return { kind: "none" };
  }

  return classifyRoadmapAutoStartEligibility(orderedRoadmapPhases(snapshot), completedPhaseId);
}

function roadmapPhaseAdvancementPresentations(
  snapshot: ProjectNotesSnapshot,
): RoadmapPhaseAdvancementPresentation[] {
  const candidates = orderedRoadmapPhases(snapshot).flatMap((phase, roadmapIndex) =>
    phase.roadmapEvents.flatMap((event, eventIndex) =>
      event.type === "phase-advancement-checkpoint"
        ? [{ phase, checkpoint: event, roadmapIndex, eventIndex }]
        : [],
    ),
  );
  return candidates
    .sort((left, right) => {
      const timestampOrder =
        Date.parse(right.checkpoint.timestamp) - Date.parse(left.checkpoint.timestamp);
      return (
        timestampOrder ||
        right.roadmapIndex - left.roadmapIndex ||
        right.eventIndex - left.eventIndex
      );
    })
    .map(({ phase, checkpoint }) => {
      const confirmation =
        phase.roadmapEvents.find(
          (event): event is NotesRoadmapPhaseAdvancementConfirmation =>
            event.type === "phase-advancement-confirmation" && event.checkpointId === checkpoint.id,
        ) ?? null;
      const mode: RoadmapPhaseAdvancementMode =
        checkpoint.reviewer === "ken" ? "manual" : "autopilot";
      const eligibility = selectNextEligibleRoadmapPhase(
        snapshot,
        checkpoint.completedPhaseId,
        checkpoint.completionReviewId,
        mode,
      );
      const nextPhase =
        snapshot.document.phases.find((candidate) => candidate.id === checkpoint.nextPhaseId) ??
        null;
      const targetMatches =
        eligibility.kind === "unique" && eligibility.phase.id === checkpoint.nextPhaseId;

      return {
        state: confirmation ? "confirmed" : targetMatches ? "pending" : "stale",
        checkpoint,
        confirmation,
        completedPhase: phase,
        nextPhase,
      };
    });
}

/** Reconstruct the newest durable advancement checkpoint without causing side effects. */
export function selectLatestRoadmapPhaseAdvancement(
  snapshot: ProjectNotesSnapshot,
): RoadmapPhaseAdvancementPresentation | null {
  return roadmapPhaseAdvancementPresentations(snapshot)[0] ?? null;
}

export function createAppSidecarRoadmapPhaseAdvancementCoordinator(options: {
  repository: Pick<ProjectNotesRepository, "load" | "confirmAutomaticPhaseAdvancement">;
  onCommittedSnapshot?: (snapshot: ProjectNotesSnapshot) => void;
  now?: () => string;
}): AppSidecarRoadmapPhaseAdvancementCoordinator {
  const now = options.now ?? (() => new Date().toISOString());

  async function coordinate(
    checkpoint: NotesRoadmapPhaseAdvancementCheckpoint,
    expectedRevision: number,
    session: RoadmapPhaseAdvancementSession,
  ) {
    if (checkpoint.reviewer !== "ken-autopilot") return { status: "none" } as const;
    const state = session.getState();
    if (!state.sessionPath) return { status: "missing-session-path" } as const;
    const outcome = await options.repository.confirmAutomaticPhaseAdvancement(state.cwd, {
      checkpointId: checkpoint.id,
      expectedRevision,
      destinationSession: { sessionId: state.sessionId, sessionPath: state.sessionPath },
      timestamp: now(),
    });
    if (outcome.status === "accepted" || outcome.status === "already-bound") {
      options.onCommittedSnapshot?.(outcome.snapshot);
      await session.setActivePhaseContext(
        createActivePhaseContext({
          projectKey: outcome.snapshot.projectKey,
          phase: outcome.phase,
          references: outcome.references,
          session: outcome.session,
          executionStage: "planning",
        }),
      );
    }
    return outcome;
  }

  return {
    coordinate,
    async recover(session) {
      const state = session.getState();
      if (!state.sessionPath) return { status: "missing-session-path" };
      const loaded = await options.repository.load(state.cwd);
      if (loaded.status !== "ok") return { status: "none" };
      const currentSession = { sessionId: state.sessionId, sessionPath: state.sessionPath };
      const advancement = roadmapPhaseAdvancementPresentations(loaded.snapshot).find((candidate) =>
        notesSessionLinksEqual(candidate.completedPhase.session, currentSession),
      );
      if (
        !advancement ||
        advancement.state === "stale" ||
        (advancement.state === "confirmed" && advancement.confirmation?.actor !== "system")
      ) {
        return { status: "none" };
      }
      return coordinate(advancement.checkpoint, loaded.snapshot.revision, session);
    },
  };
}
