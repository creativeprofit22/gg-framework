import {
  notesSessionLinksEqual,
  type NotesImplementationRunOutcome,
  type NotesSessionLink,
  type NotesWorkspaceSnapshotV1,
} from "@kenkaiiii/gg-core/project-notes";
import type {
  NotesPhase,
  ProjectNotesDurableSettlementOutcome,
  ProjectNotesDurableSettlementRequest,
  ProjectNotesExecutionMutationOutcome,
  ProjectNotesImplementationCheckpointOutcome,
  ProjectNotesImplementationCheckpointRequest,
  ProjectNotesLoadOutcome,
  ProjectNotesPhaseCompletionSettlementOutcome,
  ProjectNotesPhaseCompletionSettlementRequest,
  ProjectNotesSnapshot,
} from "./project-notes-repository.js";
import { workspaceSnapshotsEqual } from "./roadmap-phase-execution.js";

export interface PhaseCompletionRepository {
  load?(cwd: string): Promise<ProjectNotesLoadOutcome>;
  clearDurablePhaseCompletion?(
    cwd: string,
    request: {
      phaseId: string;
      expectedRevision: number;
      completionId: string;
      currentWorkspace: NotesWorkspaceSnapshotV1;
    },
  ): Promise<ProjectNotesExecutionMutationOutcome>;
  recordImplementationCheckpoint(
    cwd: string,
    request: ProjectNotesImplementationCheckpointRequest,
  ): Promise<ProjectNotesImplementationCheckpointOutcome>;
  settlePhaseCompletion(
    cwd: string,
    request: ProjectNotesPhaseCompletionSettlementRequest,
  ): Promise<ProjectNotesPhaseCompletionSettlementOutcome>;
  settleDurablePhaseCompletion?(
    cwd: string,
    request: ProjectNotesDurableSettlementRequest,
  ): Promise<ProjectNotesDurableSettlementOutcome>;
}

export type PhaseCompletionCoordinatorOutcome =
  | ProjectNotesDurableSettlementOutcome
  | ProjectNotesImplementationCheckpointOutcome
  | ProjectNotesPhaseCompletionSettlementOutcome
  | ProjectNotesExecutionMutationOutcome
  | { status: "storage-failure"; error: unknown }
  | { status: "phase-lease-lost" }
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
  planHash: string | null;
}

/** Caches the durable phase/plan projection; session identity is never authorization. */
export class AppSidecarPhaseImplementationPlanTracker {
  private retained: RetainedPhaseImplementationPlanProgress | null = null;

  clear(): void {
    this.retained = null;
  }

  resolve(input: {
    phaseId: string;
    session: NotesSessionLink;
    current: PhaseImplementationPlanProgress;
    planHash?: string | null;
  }): PhaseImplementationPlanProgress | null {
    if (input.current.total > 0) {
      const retainedCompleted =
        this.retained?.phaseId === input.phaseId && this.retained.total === input.current.total
          ? this.retained.completed
          : [];
      const completed = [...new Set([...retainedCompleted, ...input.current.completed])].sort(
        (left, right) => left - right,
      );
      this.retained = {
        phaseId: input.phaseId,
        planHash: input.planHash ?? this.retained?.planHash ?? null,
        total: input.current.total,
        completed,
      };
      return { total: input.current.total, completed: [...completed] };
    }
    if (this.retained?.phaseId !== input.phaseId) return null;
    if (input.planHash !== undefined && this.retained.planHash !== input.planHash) return null;
    return { total: this.retained.total, completed: [...this.retained.completed] };
  }
}

/** Rehydrates plan shape only; interrupted runs must still provide fresh verification. */
export function restorePhaseImplementationPlanEvidence(input: {
  tracker: AppSidecarPhaseImplementationPlanTracker;
  phase: NotesPhase;
  expectedSession: NotesSessionLink;
}): boolean {
  if (input.phase.execution?.plan) {
    const plan = input.phase.execution.plan;
    const completed = plan.steps
      .filter((step) => step.state === "completed")
      .map((step) => step.index);
    return input.tracker.resolve({
      phaseId: input.phase.id,
      session: input.expectedSession,
      planHash: plan.contentHash,
      current: { total: plan.steps.length, completed },
    }) !== null;
  }
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
  captureWorkspaceSnapshot?: () => Promise<NotesWorkspaceSnapshotV1>;
  mutateWithLeaseFence?<T>(
    operation: () => Promise<T>,
  ): Promise<{ status: "executed"; value: T } | { status: "phase-lease-lost" | "corrupt" }>;
  onError?(
    error: unknown,
    kind: "implementation-checkpoint" | "completion-settlement" | "completion-recovery",
  ): void;
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

  async settle(
    request: ProjectNotesPhaseCompletionSettlementRequest,
  ): Promise<PhaseCompletionCoordinatorOutcome> {
    const outcome = await this.enqueue("completion-settlement", () =>
      this.options.repository.settlePhaseCompletion(this.options.cwd, request),
    );
    return outcome;
  }

  async settleDurableRun(input: {
    phaseId: string;
    expectedSession: NotesSessionLink;
    runGeneration: number;
    runOutcome: NotesImplementationRunOutcome;
  }): Promise<PhaseCompletionCoordinatorOutcome | null> {
    const { repository, captureWorkspaceSnapshot } = this.options;
    if (!repository.load || !repository.clearDurablePhaseCompletion || !captureWorkspaceSnapshot) {
      return null;
    }
    const loaded = await repository.load(this.options.cwd);
    if (loaded.status !== "ok") return null;
    const phase = loaded.snapshot.document.phases.find((candidate) => candidate.id === input.phaseId);
    const pending = phase?.execution?.pendingCompletion;
    if (!phase?.execution?.plan || !pending) return null;
    if (!repository.settleDurablePhaseCompletion) {
      return {
        status: "storage-failure",
        error: new Error("Durable completion settlement is unavailable."),
      };
    }
    if (
      pending.runJournal.generation !== input.runGeneration ||
      pending.runJournal.sessionPath !== input.expectedSession.sessionPath
    ) {
      return {
        status: "missing-plan-progress",
        completionIntentId: pending.completionId,
        message: "Durable completion belongs to a different provider run journal.",
      };
    }
    let workspace: NotesWorkspaceSnapshotV1;
    try {
      workspace = await captureWorkspaceSnapshot();
    } catch (error) {
      return { status: "storage-failure", error };
    }
    if (input.runOutcome !== "succeeded" || !workspaceSnapshotsEqual(workspace, pending.workspace)) {
      return this.enqueue("completion-recovery", () =>
        repository.clearDurablePhaseCompletion!(this.options.cwd, {
          phaseId: phase.id,
          expectedRevision: loaded.snapshot.revision,
          completionId: pending.completionId,
          currentWorkspace: workspace,
        }),
      );
    }
    const outcome = await this.enqueue("completion-settlement", () =>
      repository.settleDurablePhaseCompletion!(this.options.cwd, {
        phaseId: phase.id,
        expectedRevision: loaded.snapshot.revision,
        completionId: pending.completionId,
        planHash: pending.planHash,
        workspace: pending.workspace,
      }),
    );
    return outcome;
  }

  private enqueue(
    kind: "implementation-checkpoint" | "completion-settlement" | "completion-recovery",
    operation: () => Promise<
      | ProjectNotesImplementationCheckpointOutcome
      | ProjectNotesPhaseCompletionSettlementOutcome
      | ProjectNotesExecutionMutationOutcome
    >,
  ): Promise<PhaseCompletionCoordinatorOutcome> {
    const queued = this.tail.then(async () => {
      try {
        const mutation = this.options.mutateWithLeaseFence
          ? await this.options.mutateWithLeaseFence(operation)
          : { status: "executed" as const, value: await operation() };
        if (mutation.status !== "executed") return { status: "phase-lease-lost" as const };
        const outcome = mutation.value;
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
  runGeneration?: number;
  timestamp: string;
}): Promise<PhaseCompletionCoordinatorOutcome | null> {
  return checkpointSettledPhaseImplementationInternal(input);
}

async function checkpointSettledPhaseImplementationInternal(input: {
  coordinator: AppSidecarPhaseCompletionCoordinator;
  tracker: AppSidecarPhaseImplementationPlanTracker;
  checkpointId: string;
  completionIntentId?: string;
  phaseId: string;
  expectedSession: NotesSessionLink;
  currentPlanProgress: PhaseImplementationPlanProgress;
  runOutcome: NotesImplementationRunOutcome;
  runGeneration?: number;
  timestamp: string;
}): Promise<PhaseCompletionCoordinatorOutcome | null> {
  if (input.runGeneration !== undefined) {
    const durable = await input.coordinator.settleDurableRun({
      phaseId: input.phaseId,
      expectedSession: input.expectedSession,
      runGeneration: input.runGeneration,
      runOutcome: input.runOutcome,
    });
    if (durable) return durable;
  }
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
