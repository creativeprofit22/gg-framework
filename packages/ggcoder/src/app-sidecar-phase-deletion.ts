import {
  canonicalProjectKey, isPhaseDeletionRequest, type PhaseDeletionOutcome,
  type ProjectNotesSnapshot,
} from "@kenkaiiii/gg-core/project-notes";
import type { AppSidecarRoadmapReconciliationCoordinator } from "./app-sidecar-roadmap-reconciliation.js";
import type { ActivePhaseContextV1 } from "./phase-context.js";
import type { ProjectNotesRepository } from "./project-notes-repository.js";
import type { RoadmapPhaseLeaseRepository } from "./roadmap-phase-lease-repository.js";
import {
  isAppSidecarSessionBusy, type AppSidecarSessionBusyState,
  type AppSidecarSessionMutationCoordinator, type SessionMutationLease,
} from "./app-sidecar-session-mutation.js";

export interface PhaseDeletionSession {
  getState(): { cwd: string; sessionId: string; sessionPath: string | null };
  getBusyState(): AppSidecarSessionBusyState;
  getActivePhaseContext(): ActivePhaseContextV1 | undefined;
  setActivePhaseContext(context: ActivePhaseContextV1 | undefined): Promise<void>;
  mutations: AppSidecarSessionMutationCoordinator;
}

export interface AppSidecarPhaseDeletionOptions {
  repository: Pick<ProjectNotesRepository, "mutatePhaseDeletion">;
  leases: Pick<RoadmapPhaseLeaseRepository, "withNoConflictingLease">;
  reconciliations: Pick<AppSidecarRoadmapReconciliationCoordinator, "tryAcquire">;
  /** Host-owned live logical sessions, not session identifiers from request JSON. */
  listSessions(): readonly PhaseDeletionSession[];
  onCommittedSnapshot(snapshot: ProjectNotesSnapshot): void;
}

const busy = (): Extract<PhaseDeletionOutcome, { status: "refused" }> => ({ status: "refused", reason: "active-execution",
  message: "A project session is running or accepting a new action. Wait for it to finish, or use Cancel run separately." });

/** Native authenticated Notes route only. No model-callable deletion tool. */
export function createAppSidecarPhaseDeletionCoordinator(options: AppSidecarPhaseDeletionOptions) {
  return {
    async execute(input: unknown, authenticatedSession: PhaseDeletionSession): Promise<PhaseDeletionOutcome> {
      const state = authenticatedSession.getState();
      const projectKey = canonicalProjectKey(state.cwd);
      if (!isPhaseDeletionRequest(input) || input.expectedProjectKey !== projectKey) return {
        status: "unavailable", message: "Invalid deletion request or project scope." };
      const scopedSessions = () => options.listSessions().filter(session =>
        canonicalProjectKey(session.getState().cwd) === projectKey);
      const sessions = scopedSessions();
      if (!sessions.includes(authenticatedSession)) return {
        status: "unavailable", message: "The authenticated project session is no longer available." };
      const rejectOrReplay = async (refusal: Extract<PhaseDeletionOutcome, { status: "refused" }>) => {
        // Busy/lease refusals must not turn a lost acknowledgement into a false failure.
        // The always-denying commit guard permits historical replay only, never a new write.
        const outcome = await options.repository.mutatePhaseDeletion(state.cwd, input, async () => refusal);
        if (outcome.status === "committed" || outcome.status === "conflict") options.onCommittedSnapshot(outcome.snapshot);
        return outcome;
      };
      const reconciliation = options.reconciliations.tryAcquire(state.cwd, "phase-deletion");
      if (!reconciliation) return rejectOrReplay({ status: "refused", reason: "recovery-required",
        message: "Another Roadmap action is being reconciled. Wait for it to finish before trying again." });
      const mutations: SessionMutationLease[] = [];
      try {
        // Fail-fast, not queued. These leases span the accepted-prompt/start gap as well
        // as Notes persistence; the busy state includes the outer run lifecycle.
        for (const session of sessions) {
          if (isAppSidecarSessionBusy(session.getBusyState())) return await rejectOrReplay(busy());
          const mutation = session.mutations.tryAcquire("phase-deletion");
          if (!mutation) return await rejectOrReplay(busy());
          mutations.push(mutation);
        }
        const fenced = await options.leases.withNoConflictingLease(state.cwd, input.phaseId, () =>
          options.repository.mutatePhaseDeletion(state.cwd, input, async (_snapshot, phase) => {
            const fresh = scopedSessions();
            if (fresh.length !== sessions.length || fresh.some(session => !sessions.includes(session)) ||
                authenticatedSession.getState().sessionId !== state.sessionId ||
                fresh.some(session => isAppSidecarSessionBusy(session.getBusyState()))) {
              return busy();
            }
            // Unseen legacy nonterminal bindings have no trustworthy liveness proof.
            if (phase.session && !fresh.some(session => session.getState().sessionId === phase.session!.sessionId) &&
                phase.status !== "done" && phase.status !== "cancelled") return {
              status: "refused", reason: "recovery-required",
              message: "Open the phase's linked session and resolve its execution state before deleting it." };
            return null;
          }));
        if (fenced.status !== "executed") return await rejectOrReplay({ status: "refused", reason: fenced.status,
          message: fenced.status === "ambiguous-lease"
            ? "The phase lease state is uncertain. Resolve execution recovery before deleting or recovering this phase."
            : "A phase lease still protects this phase. Finish or cancel its run before deleting or recovering it." });
        const outcome = fenced.value;
        if (outcome.status === "committed" || outcome.status === "conflict") {
          // Broadcast the actual current snapshot, including historical replay after recovery.
          options.onCommittedSnapshot(outcome.snapshot);
        }
        if (outcome.status === "committed" && outcome.action === "delete" &&
            outcome.snapshot.document.phases.find(phase => phase.id === input.phaseId)?.deletion?.currentDeletionId !== null) {
          for (const session of sessions) {
            if (session.getActivePhaseContext()?.phase.id !== input.phaseId) continue;
            // Durable tombstone remains authoritative even if historical marker cleanup fails.
            // Execution admission must independently reject it, never trust the local marker.
            await session.setActivePhaseContext(undefined).catch(() => {});
          }
        }
        return outcome;
      } catch {
        return { status: "uncertain", operationId: input.operationId,
          message: "The operation outcome is uncertain. Retry this same request after reconnecting." };
      } finally {
        for (const mutation of mutations.reverse()) mutation.release();
        reconciliation.release();
      }
    },
  };
}
