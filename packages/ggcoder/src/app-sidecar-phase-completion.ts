import {
  notesSessionLinksEqual,
  type NotesImplementationRunOutcome,
  type NotesSessionLink,
} from "@kenkaiiii/gg-core/project-notes";
import type {
  NotesPhase,
  ProjectNotesImplementationCheckpointOutcome,
  ProjectNotesImplementationCheckpointRequest,
  ProjectNotesPhaseCompletionSettlementOutcome,
  ProjectNotesPhaseCompletionSettlementRequest,
  ProjectNotesSnapshot,
} from "./project-notes-repository.js";

export interface PhaseCompletionRepository {
  recordImplementationCheckpoint(
    cwd: string,
    request: ProjectNotesImplementationCheckpointRequest,
  ): Promise<ProjectNotesImplementationCheckpointOutcome>;
  settlePhaseCompletion(
    cwd: string,
    request: ProjectNotesPhaseCompletionSettlementRequest,
  ): Promise<ProjectNotesPhaseCompletionSettlementOutcome>;
}

export type PhaseCompletionCoordinatorOutcome =
  | ProjectNotesImplementationCheckpointOutcome
  | ProjectNotesPhaseCompletionSettlementOutcome
  | { status: "storage-failure"; error: unknown }
  | {
      status: "missing-plan-progress";
      completionIntentId: string;
      message: string;
    };

export interface PhaseImplementationPlanProgress {
  total: number;
  completed: number[];
}

interface RetainedPhaseImplementationPlanProgress extends PhaseImplementationPlanProgress {
  phaseId: string;
  session: NotesSessionLink;
}

/** Retains canonical plan evidence across prompt cleanup for one phase/session. */
export class AppSidecarPhaseImplementationPlanTracker {
  private retained: RetainedPhaseImplementationPlanProgress | null = null;

  clear(): void {
    this.retained = null;
  }

  resolve(input: {
    phaseId: string;
    session: NotesSessionLink;
    current: PhaseImplementationPlanProgress;
  }): PhaseImplementationPlanProgress | null {
    if (input.current.total > 0) {
      this.retained = {
        phaseId: input.phaseId,
        session: { ...input.session },
        total: input.current.total,
        completed: [...input.current.completed],
      };
      return { total: input.current.total, completed: [...input.current.completed] };
    }
    if (
      this.retained?.phaseId !== input.phaseId ||
      !notesSessionLinksEqual(this.retained.session, input.session)
    ) {
      return null;
    }
    return { total: this.retained.total, completed: [...this.retained.completed] };
  }
}

/** Rehydrates plan shape only; interrupted runs must still provide fresh verification. */
export function restorePhaseImplementationPlanEvidence(input: {
  tracker: AppSidecarPhaseImplementationPlanTracker;
  phase: NotesPhase;
  expectedSession: NotesSessionLink;
}): boolean {
  if (!input.phase.session || !notesSessionLinksEqual(input.phase.session, input.expectedSession)) {
    return false;
  }
  const checkpoint = [...input.phase.roadmapEvents]
    .reverse()
    .find(
      (event) =>
        event.type === "implementation-checkpoint" &&
        event.planStepTotal > 0 &&
        notesSessionLinksEqual(event.session, input.expectedSession),
    );
  if (!checkpoint || checkpoint.type !== "implementation-checkpoint") return false;
  return (
    input.tracker.resolve({
      phaseId: input.phase.id,
      session: input.expectedSession,
      current: {
        total: checkpoint.planStepTotal,
        completed: checkpoint.completedPlanSteps,
      },
    }) !== null
  );
}

export interface PhaseCompletionCoordinatorOptions {
  cwd: string;
  repository: PhaseCompletionRepository;
  broadcastSnapshot(snapshot: ProjectNotesSnapshot): void;
  onError?(error: unknown, kind: "implementation-checkpoint" | "completion-settlement"): void;
}

export class AppSidecarPhaseCompletionCoordinator {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly options: PhaseCompletionCoordinatorOptions) {}

  checkpoint(
    request: ProjectNotesImplementationCheckpointRequest,
  ): Promise<PhaseCompletionCoordinatorOutcome> {
    return this.enqueue("implementation-checkpoint", () =>
      this.options.repository.recordImplementationCheckpoint(this.options.cwd, request),
    );
  }

  settle(
    request: ProjectNotesPhaseCompletionSettlementRequest,
  ): Promise<PhaseCompletionCoordinatorOutcome> {
    return this.enqueue("completion-settlement", () =>
      this.options.repository.settlePhaseCompletion(this.options.cwd, request),
    );
  }

  private enqueue(
    kind: "implementation-checkpoint" | "completion-settlement",
    operation: () => Promise<
      ProjectNotesImplementationCheckpointOutcome | ProjectNotesPhaseCompletionSettlementOutcome
    >,
  ): Promise<PhaseCompletionCoordinatorOutcome> {
    const queued = this.tail.then(async () => {
      try {
        const outcome = await operation();
        if (outcome.status === "committed" || outcome.status === "open") {
          this.options.broadcastSnapshot(outcome.snapshot);
        }
        return outcome;
      } catch (error) {
        this.options.onError?.(error, kind);
        return { status: "storage-failure" as const, error };
      }
    });
    this.tail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }
}

/** Persist a settled run; direct completion uses only this run's retained intent. */
export function checkpointSettledPhaseImplementation(input: {
  coordinator: AppSidecarPhaseCompletionCoordinator;
  tracker: AppSidecarPhaseImplementationPlanTracker;
  checkpointId: string;
  completionIntentId?: string;
  phaseId: string;
  expectedSession: NotesSessionLink;
  currentPlanProgress: PhaseImplementationPlanProgress;
  runOutcome: NotesImplementationRunOutcome;
  timestamp: string;
}): Promise<PhaseCompletionCoordinatorOutcome | null> {
  const progress = input.tracker.resolve({
    phaseId: input.phaseId,
    session: input.expectedSession,
    current: input.currentPlanProgress,
  });
  if (!progress) {
    return Promise.resolve(
      input.completionIntentId
        ? {
            status: "missing-plan-progress",
            completionIntentId: input.completionIntentId,
            message:
              "Completion was not settled because same-session canonical plan progress is unavailable.",
          }
        : null,
    );
  }
  const request = {
    checkpointId: input.checkpointId,
    phaseId: input.phaseId,
    expectedSession: input.expectedSession,
    planStepTotal: progress.total,
    completedPlanSteps: progress.completed,
    runOutcome: input.runOutcome,
    timestamp: input.timestamp,
  };
  return input.completionIntentId
    ? input.coordinator.settle({ ...request, completionIntentId: input.completionIntentId })
    : input.coordinator.checkpoint(request);
}
