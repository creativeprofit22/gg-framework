import {
  notesSessionLinksEqual,
  type NotesImplementationRunOutcome,
  type NotesSessionLink,
} from "@kenkaiiii/gg-core/project-notes";
import type { AutopilotVerdict } from "./core/autopilot-verdict.js";
import type { KenVerificationException } from "./core/ken-context.js";
import { latestVerificationExceptionEventForReview } from "./project-notes-completion-policy.js";
import type {
  NotesPhase,
  ProjectNotesCompletionReviewOutcome,
  ProjectNotesCompletionReviewRequest,
  ProjectNotesImplementationCheckpointOutcome,
  ProjectNotesImplementationCheckpointRequest,
  ProjectNotesSnapshot,
} from "./project-notes-repository.js";

/** Adapt the current typed verification exception into Autopilot Ken's review context. */
export function latestVerificationExceptionForReview(
  phase: NotesPhase | undefined,
): KenVerificationException | null {
  const verification = latestVerificationExceptionEventForReview(phase);
  if (!verification) return null;
  return {
    id: verification.id,
    requesterActor: verification.actor,
    reason: verification.verificationReason,
    timestamp: verification.timestamp,
    evidence: [...verification.evidence],
  };
}

/** An ALL_CLEAR accepts an exception only by naming the exact current request. */
export function autopilotVerdictAcceptsVerificationException(
  verdict: Extract<AutopilotVerdict, { kind: "all_clear" }>,
  currentException: KenVerificationException | null,
): boolean {
  return (
    currentException !== null && verdict.acceptedVerificationExceptionId === currentException.id
  );
}

export interface PhaseCompletionRepository {
  recordImplementationCheckpoint(
    cwd: string,
    request: ProjectNotesImplementationCheckpointRequest,
  ): Promise<ProjectNotesImplementationCheckpointOutcome>;
  recordCompletionReview(
    cwd: string,
    request: ProjectNotesCompletionReviewRequest,
  ): Promise<ProjectNotesCompletionReviewOutcome>;
}

export type PhaseCompletionCoordinatorOutcome =
  | ProjectNotesImplementationCheckpointOutcome
  | ProjectNotesCompletionReviewOutcome
  | { status: "storage-failure"; error: unknown };

export interface PhaseImplementationPlanProgress {
  total: number;
  completed: number[];
}

interface RetainedPhaseImplementationPlanProgress extends PhaseImplementationPlanProgress {
  phaseId: string;
  session: NotesSessionLink;
}

/** Retain canonical plan evidence after prompt/UI cleanup so a rejected phase's
 * correction run can write the fresh implementation checkpoint required for
 * the new review round. Evidence never crosses a phase or session binding. */
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

/** Rehydrate completed-plan evidence from the durable same-phase/same-session
 * checkpoint log after a sidecar restart. The checkpoint remains subject to
 * the normal post-rejection freshness gate; only its canonical plan shape is
 * reused to write the correction run's new checkpoint. */
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
  onError?(error: unknown, kind: "implementation-checkpoint" | "completion-review"): void;
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

  review(request: ProjectNotesCompletionReviewRequest): Promise<PhaseCompletionCoordinatorOutcome> {
    return this.enqueue("completion-review", () =>
      this.options.repository.recordCompletionReview(this.options.cwd, request),
    );
  }

  private enqueue(
    kind: "implementation-checkpoint" | "completion-review",
    operation: () => Promise<
      ProjectNotesImplementationCheckpointOutcome | ProjectNotesCompletionReviewOutcome
    >,
  ): Promise<PhaseCompletionCoordinatorOutcome> {
    const queued = this.tail.then(async () => {
      try {
        const outcome = await operation();
        if (outcome.status === "committed") this.options.broadcastSnapshot(outcome.snapshot);
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

/** Persist the settled implementation run with live plan evidence, or with the
 * same phase/session's retained evidence after completed-plan prompt cleanup. */
export function checkpointSettledPhaseImplementation(input: {
  coordinator: AppSidecarPhaseCompletionCoordinator;
  tracker: AppSidecarPhaseImplementationPlanTracker;
  checkpointId: string;
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
  if (!progress) return Promise.resolve(null);
  return input.coordinator.checkpoint({
    checkpointId: input.checkpointId,
    phaseId: input.phaseId,
    expectedSession: input.expectedSession,
    planStepTotal: progress.total,
    completedPlanSteps: progress.completed,
    runOutcome: input.runOutcome,
    timestamp: input.timestamp,
  });
}
