import type { ActivePhaseContextV1 } from "./phase-context.js";
import { canonicalProjectKey } from "./project-notes-repository.js";
import type {
  NotesSessionLink,
  ProjectNotesPhaseLifecycleOutcome,
  ProjectNotesRepository,
  ProjectNotesSnapshot,
} from "./project-notes-repository.js";

export type ActiveOperationCancellationResult =
  | { status: "cancelled" }
  | { status: "idle" }
  | { status: "failed"; reason: string };

export interface PhaseCancellationSession {
  cwd: string;
  getActivePhaseContext(): ActivePhaseContextV1 | undefined;
  isRunning(): boolean;
  cancelActiveOperation(): Promise<ActiveOperationCancellationResult>;
}

export type PhaseRunCancellationFailureCode =
  | "notes-unavailable"
  | "phase-not-found"
  | "phase-not-active"
  | "bound-session-not-running"
  | "bound-session-ambiguous"
  | "cancellation-failed"
  | "notes-update-failed";

export type PhaseRunCancellationResult =
  | {
      status: "cancelled";
      phaseId: string;
      session: NotesSessionLink;
    }
  | {
      status: "failed";
      phaseId: string;
      code: PhaseRunCancellationFailureCode;
      message: string;
      operationStopped: boolean;
    };

interface PhaseCancellationRepository {
  load: ProjectNotesRepository["load"];
  recordUserPhaseCancellation: ProjectNotesRepository["recordUserPhaseCancellation"];
}

export interface AppSidecarPhaseCancellationOptions {
  repository: PhaseCancellationRepository;
  sessions(): Iterable<PhaseCancellationSession>;
  broadcastSnapshot(snapshot: ProjectNotesSnapshot): void;
  now?: () => string;
}

function sameSession(left: NotesSessionLink, right: NotesSessionLink): boolean {
  return left.sessionId === right.sessionId && left.sessionPath === right.sessionPath;
}

function failed(
  phaseId: string,
  code: PhaseRunCancellationFailureCode,
  message: string,
  operationStopped = false,
): PhaseRunCancellationResult {
  return { status: "failed", phaseId, code, message, operationStopped };
}

function persistedCancellation(
  outcome: ProjectNotesPhaseLifecycleOutcome,
): outcome is Extract<ProjectNotesPhaseLifecycleOutcome, { status: "ok" }> {
  return outcome.status === "ok";
}

/**
 * Cancels the live operation owning a phase before committing its Notes status.
 * The authoritative Notes session link is resolved on every request so a caller
 * cannot accidentally cancel whichever pane happens to have Notes open.
 */
export class AppSidecarPhaseCancellationCoordinator {
  private readonly inFlight = new Map<string, Promise<PhaseRunCancellationResult>>();
  private readonly now: () => string;

  constructor(private readonly options: AppSidecarPhaseCancellationOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  cancel(cwd: string, phaseId: string): Promise<PhaseRunCancellationResult> {
    const key = `${cwd}\0${phaseId}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const operation = this.cancelOnce(cwd, phaseId).finally(() => {
      if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
    });
    this.inFlight.set(key, operation);
    return operation;
  }

  private async cancelOnce(cwd: string, phaseId: string): Promise<PhaseRunCancellationResult> {
    let loaded: Awaited<ReturnType<PhaseCancellationRepository["load"]>>;
    try {
      loaded = await this.options.repository.load(cwd);
    } catch (error) {
      return failed(
        phaseId,
        "notes-unavailable",
        `Couldn’t read Project Notes. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (loaded.status !== "ok") {
      return failed(
        phaseId,
        "notes-unavailable",
        loaded.status === "missing"
          ? "Project Notes no longer exists for this project."
          : "Project Notes is corrupt and the run was not cancelled.",
      );
    }

    const phase = loaded.snapshot.document.phases.find((candidate) => candidate.id === phaseId);
    if (!phase || phase.archivedAt !== null) {
      return failed(phaseId, "phase-not-found", "This Roadmap phase is no longer active.");
    }
    if (phase.status === "done" || phase.status === "cancelled" || phase.session === null) {
      return failed(
        phaseId,
        "phase-not-active",
        "This phase does not have an active bound run to cancel.",
      );
    }

    const boundSession = structuredClone(phase.session);
    const targets = [...this.options.sessions()].filter((candidate) => {
      if (
        !candidate.isRunning() ||
        canonicalProjectKey(candidate.cwd) !== loaded.snapshot.projectKey
      ) {
        return false;
      }
      const active = candidate.getActivePhaseContext();
      return (
        active?.projectKey === loaded.snapshot.projectKey &&
        active.phase.id === phaseId &&
        sameSession(active.session, boundSession)
      );
    });
    if (targets.length === 0) {
      return failed(
        phaseId,
        "bound-session-not-running",
        "The phase’s bound session is not running. Notes was left unchanged.",
      );
    }
    if (targets.length !== 1) {
      return failed(
        phaseId,
        "bound-session-ambiguous",
        "More than one live pane owns the phase’s bound session. No run was cancelled.",
      );
    }

    let cancellation: ActiveOperationCancellationResult;
    try {
      cancellation = await targets[0]!.cancelActiveOperation();
    } catch (error) {
      return failed(
        phaseId,
        "cancellation-failed",
        `The agent run could not be cancelled. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (cancellation.status !== "cancelled") {
      return failed(
        phaseId,
        "cancellation-failed",
        cancellation.status === "idle"
          ? "The bound session has no active agent operation. Notes was left unchanged."
          : `The agent operation did not stop (${cancellation.reason}). Notes was left unchanged.`,
      );
    }

    let outcome: ProjectNotesPhaseLifecycleOutcome;
    try {
      outcome = await this.options.repository.recordUserPhaseCancellation(
        cwd,
        phaseId,
        boundSession,
        this.now(),
      );
    } catch (error) {
      return failed(
        phaseId,
        "notes-update-failed",
        `The run stopped, but Notes could not mark it cancelled. ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }

    if (!persistedCancellation(outcome)) {
      return failed(
        phaseId,
        "notes-update-failed",
        `The run stopped, but Notes rejected the Cancelled update (${outcome.status}).`,
        true,
      );
    }

    this.options.broadcastSnapshot(outcome.snapshot);
    return { status: "cancelled", phaseId, session: boundSession };
  }
}
