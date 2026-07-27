import type {
  ProjectNotesPhaseLinkOutcome,
  ProjectNotesSnapshot,
} from "./project-notes-repository.js";
import type { ActivePhaseContextV1, ActivePhaseExecutionStage } from "./phase-context.js";

export type PhaseCheckpointErrorCode =
  | "phase-stage-persistence-failed"
  | "notes-missing"
  | "notes-corrupt"
  | "phase-not-found"
  | "phase-archived"
  | "phase-link-persistence-failed";

export class PhaseCheckpointError extends Error {
  readonly retryable = true;

  constructor(
    readonly code: PhaseCheckpointErrorCode,
    readonly phaseId: string,
    message: string,
    readonly guidance: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PhaseCheckpointError";
  }
}

export type ActivePhaseStageResult =
  | { status: "no-active-phase" }
  | { status: "updated"; context: ActivePhaseContextV1 };

export type ActivePhaseLinkSyncResult =
  | { status: "no-active-phase" }
  | {
      status: "synchronized";
      snapshot: ProjectNotesSnapshot;
      context: ActivePhaseContextV1;
    };

export interface PhaseCheckpointSession {
  getActivePhaseContext(): ActivePhaseContextV1 | undefined;
  getState(): { sessionId: string; sessionPath: string | null };
  updateActivePhaseStage(
    executionStage: ActivePhaseExecutionStage,
    approvedPlanPath?: string,
  ): Promise<ActivePhaseContextV1>;
}

export interface PhaseCheckpointRepository {
  updatePhaseSessionLink(
    cwd: string,
    phaseId: string,
    session: { sessionId: string; sessionPath: string | null },
  ): Promise<ProjectNotesPhaseLinkOutcome>;
}

export interface PlanApprovalCheckpointResult {
  planTotal: number;
  phaseLink: ActivePhaseLinkSyncResult;
}

export interface PhaseCheckpointFailurePayload {
  code: PhaseCheckpointErrorCode;
  message: string;
  guidance: string;
  retryable: true;
  phaseId: string;
}

export async function persistActivePhaseStage(input: {
  session: PhaseCheckpointSession;
  executionStage: ActivePhaseExecutionStage;
  approvedPlanPath?: string;
}): Promise<ActivePhaseStageResult> {
  const activePhase = input.session.getActivePhaseContext();
  if (!activePhase) return { status: "no-active-phase" };

  try {
    const context = await input.session.updateActivePhaseStage(
      input.executionStage,
      input.approvedPlanPath,
    );
    return { status: "updated", context };
  } catch (cause) {
    throw new PhaseCheckpointError(
      "phase-stage-persistence-failed",
      activePhase.phase.id,
      "The active phase stage could not be saved.",
      "The plan is still pending. Fix the session storage problem, then retry approval.",
      { cause },
    );
  }
}

export async function syncActivePhaseSessionLink(input: {
  session: PhaseCheckpointSession;
  repository: PhaseCheckpointRepository;
  cwd: string;
  onSnapshot?: (snapshot: ProjectNotesSnapshot) => void;
}): Promise<ActivePhaseLinkSyncResult> {
  const activePhase = input.session.getActivePhaseContext();
  if (!activePhase) return { status: "no-active-phase" };

  let outcome: ProjectNotesPhaseLinkOutcome;
  try {
    const state = input.session.getState();
    outcome = await input.repository.updatePhaseSessionLink(input.cwd, activePhase.phase.id, {
      sessionId: state.sessionId,
      sessionPath: state.sessionPath,
    });
  } catch (cause) {
    throw new PhaseCheckpointError(
      "phase-link-persistence-failed",
      activePhase.phase.id,
      "The latest phase checkpoint could not be written to Project Notes.",
      "The current session remains authoritative. Fix Project Notes storage, then retry the action.",
      { cause },
    );
  }

  if (outcome.status !== "ok") throw phaseLinkOutcomeError(activePhase.phase.id, outcome);
  input.onSnapshot?.(outcome.snapshot);
  return { status: "synchronized", snapshot: outcome.snapshot, context: activePhase };
}

export async function commitPlanApprovalCheckpoint(input: {
  session: PhaseCheckpointSession;
  repository: PhaseCheckpointRepository;
  cwd: string;
  planPath?: string;
  prepareFreshSession: () => Promise<number>;
  onSnapshot?: (snapshot: ProjectNotesSnapshot) => void;
}): Promise<PlanApprovalCheckpointResult> {
  const planTotal = await input.prepareFreshSession();
  const phaseLink = await syncActivePhaseSessionLink(input);
  if (phaseLink.status === "no-active-phase") return { planTotal, phaseLink };
  const stage = await persistActivePhaseStage({
    session: input.session,
    executionStage: "implementing",
    approvedPlanPath: input.planPath,
  });
  if (stage.status === "no-active-phase") {
    throw new PhaseCheckpointError(
      "phase-stage-persistence-failed",
      phaseLink.context.phase.id,
      "The active phase disappeared before its implementation stage could be saved.",
      "The plan is still pending. Resume the linked phase, then retry approval.",
    );
  }
  return { planTotal, phaseLink };
}

export async function completeCompactionCheckpoint(input: {
  synchronize: () => Promise<ActivePhaseLinkSyncResult>;
  onComplete: () => void;
  onFailure: (error: PhaseCheckpointError) => void;
}): Promise<"completed" | "sync-failed"> {
  try {
    await input.synchronize();
    input.onComplete();
    return "completed";
  } catch (error) {
    const checkpointError =
      error instanceof PhaseCheckpointError
        ? error
        : new PhaseCheckpointError(
            "phase-link-persistence-failed",
            "unknown",
            "The latest phase checkpoint could not be synchronized after compaction.",
            "The current session remains authoritative. Fix Project Notes storage, then retry the action.",
            { cause: error },
          );
    input.onFailure(checkpointError);
    return "sync-failed";
  }
}

export function phaseCheckpointFailurePayload(
  error: PhaseCheckpointError,
): PhaseCheckpointFailurePayload {
  return {
    code: error.code,
    message: error.message,
    guidance: error.guidance,
    retryable: true,
    phaseId: error.phaseId,
  };
}

function phaseLinkOutcomeError(
  phaseId: string,
  outcome: Exclude<ProjectNotesPhaseLinkOutcome, { status: "ok" }>,
): PhaseCheckpointError {
  switch (outcome.status) {
    case "missing":
      return new PhaseCheckpointError(
        "notes-missing",
        phaseId,
        "Project Notes are missing, so the latest phase checkpoint was not saved.",
        "Restore or recreate Project Notes, then retry the action.",
      );
    case "corrupt":
      return new PhaseCheckpointError(
        "notes-corrupt",
        phaseId,
        "Project Notes are corrupt, so the latest phase checkpoint was not saved.",
        "Restore Project Notes from a valid backup, then retry the action.",
      );
    case "phase-not-found":
      return new PhaseCheckpointError(
        "phase-not-found",
        phaseId,
        "The active phase no longer exists in Project Notes.",
        "Restore the phase or start it again, then retry the action.",
      );
    case "phase-archived":
      return new PhaseCheckpointError(
        "phase-archived",
        phaseId,
        "The active phase is archived, so its latest checkpoint was not saved.",
        "Unarchive or restart the phase, then retry the action.",
      );
  }
}
