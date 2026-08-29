import {
  canonicalProjectKey,
  notesSessionLinksEqual,
  type NotesSessionLink,
  type ProjectNotesLoadOutcome,
  type ProjectNotesSnapshot,
} from "@kenkaiiii/gg-core/project-notes";
import type {
  PhaseBindingOutcome,
  PhaseBindingRequest,
} from "@kenkaiiii/gg-core/phase-binding-protocol";
import {
  createActivePhaseContext,
  type ActivePhaseContextClearReason,
  type ActivePhaseContextV1,
} from "./phase-context.js";
import { publishCommittedNotesSnapshot } from "./app-sidecar-committed-notes.js";
import type {
  ProjectNotesPhaseBindingRequest,
  ProjectNotesRepository,
} from "./project-notes-repository.js";

export interface PhaseBindingSession {
  getState(): { cwd: string; sessionId: string; sessionPath: string | null };
  getActivePhaseContext(): ActivePhaseContextV1 | undefined;
  setActivePhaseContext(context: ActivePhaseContextV1 | undefined): Promise<void>;
  clearActivePhaseContext?(reason: ActivePhaseContextClearReason): Promise<void>;
}

export interface AppSidecarPhaseBindingService {
  bind(request: PhaseBindingRequest, session: PhaseBindingSession): Promise<PhaseBindingOutcome>;
  reconcile(session: PhaseBindingSession): Promise<"none" | "consistent" | "cleared">;
}

export interface AppSidecarPhaseBindingOptions {
  repository: Pick<ProjectNotesRepository, "load" | "bindPhaseToCurrentSession">;
  onCommittedSnapshot?: (snapshot: ProjectNotesSnapshot) => void;
  now?: () => string;
}

export function createAppSidecarPhaseBindingService(
  options: AppSidecarPhaseBindingOptions,
): AppSidecarPhaseBindingService {
  const now = options.now ?? (() => new Date().toISOString());
  return {
    async bind(request, session) {
      const state = session.getState();
      const destinationSession: NotesSessionLink = {
        sessionId: state.sessionId,
        sessionPath: state.sessionPath,
      };
      if (!destinationSession.sessionPath) return { status: "missing-session-path" };
      const loaded = await options.repository.load(state.cwd);
      const preflight = bindingPreflight(loaded, request);
      if (preflight) return preflight;
      if (loaded.status !== "ok") return loaded;
      const phase = loaded.snapshot.document.phases.find(
        (candidate) => candidate.id === request.phaseId,
      )!;
      const activeContext = createActivePhaseContext({
        projectKey: loaded.snapshot.projectKey,
        phase,
        references: loaded.snapshot.document.references,
        session: destinationSession,
        executionStage: "implementing",
      });
      await session.setActivePhaseContext(activeContext);
      const repositoryRequest: ProjectNotesPhaseBindingRequest = {
        action: request.action,
        phaseId: request.phaseId,
        expectedProjectKey: request.expectedProjectKey,
        expectedRevision: request.expectedRevision,
        expectedPreviousSession: request.expectedPreviousSession,
        operationId: request.operationId,
        destinationSession,
        timestamp: now(),
      };
      let outcome: PhaseBindingOutcome;
      try {
        outcome = await options.repository.bindPhaseToCurrentSession(state.cwd, repositoryRequest);
      } catch (error) {
        await clearSessionContext(session, "binding-compensation");
        throw error;
      }
      if (outcome.status === "committed") {
        await publishCommittedNotesSnapshot(
          options.repository,
          state.cwd,
          outcome.revision,
          options.onCommittedSnapshot,
        );
      } else if (outcome.status !== "duplicate" && outcome.status !== "already-bound") {
        await clearSessionContext(session, "binding-compensation");
      }
      return outcome;
    },

    async reconcile(session) {
      const context = session.getActivePhaseContext();
      if (!context) return "none";
      const state = session.getState();
      const loaded = await options.repository.load(state.cwd);
      if (loaded.status !== "ok") {
        await clearSessionContext(session, "binding-reconciliation");
        return "cleared";
      }
      const phase = loaded.snapshot.document.phases.find(
        (candidate) => candidate.id === context.phase.id,
      );
      const currentSession: NotesSessionLink = {
        sessionId: state.sessionId,
        sessionPath: state.sessionPath,
      };
      if (
        context.projectKey !== canonicalProjectKey(state.cwd) ||
        !phase ||
        phase.archivedAt !== null ||
        phase.status === "done" ||
        !notesSessionLinksEqual(context.session, currentSession) ||
        !notesSessionLinksEqual(phase.session, currentSession)
      ) {
        await clearSessionContext(
          session,
          phase?.session && !notesSessionLinksEqual(phase.session, currentSession)
            ? "phase-rebound"
            : "binding-reconciliation",
        );
        return "cleared";
      }
      return "consistent";
    },
  };
}

function bindingPreflight(
  loaded: ProjectNotesLoadOutcome,
  request: PhaseBindingRequest,
): PhaseBindingOutcome | null {
  if (loaded.status !== "ok") return loaded;
  if (loaded.snapshot.projectKey !== request.expectedProjectKey) {
    return {
      status: "project-mismatch",
      revision: loaded.snapshot.revision,
      currentProjectKey: loaded.snapshot.projectKey,
    };
  }
  if (loaded.snapshot.revision !== request.expectedRevision) {
    return { status: "stale-revision", revision: loaded.snapshot.revision };
  }
  const phase = loaded.snapshot.document.phases.find(
    (candidate) => candidate.id === request.phaseId,
  );
  if (!phase) return { status: "phase-not-found" };
  if (phase.archivedAt !== null) return { status: "phase-archived" };
  if (phase.status === "done") return { status: "phase-terminal" };
  return null;
}

async function clearSessionContext(
  session: PhaseBindingSession,
  reason: ActivePhaseContextClearReason,
): Promise<void> {
  if (session.clearActivePhaseContext) await session.clearActivePhaseContext(reason);
  else await session.setActivePhaseContext(undefined);
}
