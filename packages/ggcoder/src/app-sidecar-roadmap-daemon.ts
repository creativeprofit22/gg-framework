import { randomUUID } from "node:crypto";
import type http from "node:http";
import { log } from "./core/logger.js";
import { captureSidecarError } from "./core/sidecar-error-reporter.js";
import { daemonJson } from "./app-sidecar/http.js";
import { createAppSidecarNotesHandler } from "./app-sidecar-notes.js";
import { AppSidecarProjectAutopilotState } from "./app-sidecar-autopilot-state.js";
import {
  createAppSidecarPhaseBindingService,
  hasLivePhaseLeaseSession,
  type PhaseBindingSession,
} from "./app-sidecar-phase-binding.js";
import {
  AppSidecarPhaseCancellationCoordinator,
  type PhaseCancellationSession,
} from "./app-sidecar-phase-cancellation.js";
import {
  createAppSidecarPhaseDeletionCoordinator,
  type PhaseDeletionSession,
} from "./app-sidecar-phase-deletion.js";
import {
  AppSidecarReminderCoordinator,
  createAppSidecarReminderHandler,
} from "./app-sidecar-reminders.js";
import { AppSidecarRoadmapDraftDecisionService } from "./app-sidecar-roadmap-draft-route.js";
import { AppSidecarRoadmapDraftCoordinator } from "./app-sidecar-roadmap-drafts.js";
import { AppSidecarRoadmapReconciliationCoordinator } from "./app-sidecar-roadmap-reconciliation.js";
import { createAppSidecarStorageDiagnostics } from "./app-sidecar-storage-diagnostics.js";
import {
  ProjectNotesRepository,
  canonicalProjectKey,
  type ProjectNotesSnapshot,
} from "./project-notes-repository.js";
import {
  isRoadmapPhaseLeasePredecessorProofV1,
  RoadmapPhaseLeaseRepository,
  type RoadmapPhaseLeasePredecessorProofV1,
} from "./roadmap-phase-lease-repository.js";

/**
 * Local Fork Roadmap/Project Notes daemon services. Built once per daemon by
 * `main()` in app-sidecar.ts and shared by every logical session.
 */

type RoadmapDurabilityDiagnostic =
  "legacy-plan-missing" | "legacy-plan-identity-mismatch" | "phase-lease-lost";
const roadmapDurabilityDiagnostics = new Map<RoadmapDurabilityDiagnostic, number>();

export function recordRoadmapDurabilityDiagnostic(code: RoadmapDurabilityDiagnostic): void {
  const count = (roadmapDurabilityDiagnostics.get(code) ?? 0) + 1;
  roadmapDurabilityDiagnostics.set(code, count);
  log("INFO", "roadmap-durability", "typed compatibility diagnostic", { code, count });
}

function parseDaemonPredecessorProof(
  raw: string | undefined,
): RoadmapPhaseLeasePredecessorProofV1 | undefined {
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return isRoadmapPhaseLeasePredecessorProofV1(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The parts of a live session context the Roadmap daemon services read. */
interface AppSidecarRoadmapDaemonSessionContext extends PhaseCancellationSession {
  session: Pick<PhaseBindingSession, "getState" | "getCompactionPredecessorSessions">;
  broadcast: (type: string, data: unknown) => void;
  broadcastNotesChange: (snapshot: ProjectNotesSnapshot) => void;
  phaseDeletionSession: PhaseDeletionSession;
}

interface AppSidecarRoadmapDaemonServicesOptions {
  paths: { agentDir: string };
  applicationIdentity: string | null;
  /** Live session registry; read lazily so later-created sessions are seen. */
  sessions: {
    values(): Iterable<AppSidecarRoadmapDaemonSessionContext>;
    get(sessionId: string): AppSidecarRoadmapDaemonSessionContext | undefined;
  };
}

export function createAppSidecarRoadmapDaemonServices({
  paths,
  applicationIdentity,
  sessions,
}: AppSidecarRoadmapDaemonServicesOptions) {
  const notesRepository = new ProjectNotesRepository(paths.agentDir);
  // Mutation fencing is standard, independent of historical completion rollout settings.
  const durableRoadmapExecution = true;
  const phaseLeaseRepository = new RoadmapPhaseLeaseRepository(paths.agentDir, {
    // Only consulted for expired leases recorded by this process: a lease whose
    // session is not live here (directly or via compaction lineage) is orphaned.
    hasLiveLocalSession: (holder) =>
      hasLivePhaseLeaseSession(
        Array.from(sessions.values(), (context) => context.session),
        holder,
      ),
  });
  const daemonInstanceId = process.env.GG_DAEMON_INSTANCE_ID?.trim() || randomUUID();
  const processStartToken =
    process.env.GG_PROCESS_START_TOKEN?.trim() || `${process.pid}:${Date.now()}`;
  const predecessorProof = parseDaemonPredecessorProof(process.env.GG_DAEMON_PREDECESSOR_PROOF);
  const storageDiagnostics = createAppSidecarStorageDiagnostics({
    applicationIdentity,
    agentDataRoot: paths.agentDir,
    repository: notesRepository,
  });
  const roadmapReconciliations = new AppSidecarRoadmapReconciliationCoordinator();
  const roadmapDrafts = new AppSidecarRoadmapDraftCoordinator({
    onChange: (projectKey, draft) => {
      for (const context of sessions.values()) {
        if (canonicalProjectKey(context.cwd) === projectKey) {
          context.broadcast("roadmap_phase_draft_change", draft);
        }
      }
    },
  });
  const projectAutopilot = new AppSidecarProjectAutopilotState();
  const broadcastNotesSnapshot = (snapshot: ProjectNotesSnapshot): void => {
    reminderCoordinator?.observeSnapshot(snapshot);
    for (const context of sessions.values()) {
      if (canonicalProjectKey(context.cwd) === snapshot.projectKey) {
        context.broadcastNotesChange(snapshot);
      }
    }
  };
  const phaseBinding = createAppSidecarPhaseBindingService({
    repository: notesRepository,
    onCommittedSnapshot: broadcastNotesSnapshot,
    leaseRepository: phaseLeaseRepository,
    daemonInstanceId,
    processId: process.pid,
    processStartToken,
    predecessorProof,
  });
  const roadmapDraftDecisions = new AppSidecarRoadmapDraftDecisionService({
    drafts: roadmapDrafts,
    repository: notesRepository,
    reconciliations: roadmapReconciliations,
    onCommittedSnapshot: broadcastNotesSnapshot,
  });
  const phaseCancellations = new AppSidecarPhaseCancellationCoordinator({
    repository: notesRepository,
    sessions: () => sessions.values(),
    broadcastSnapshot: broadcastNotesSnapshot,
  });
  const reminderCoordinator = new AppSidecarReminderCoordinator({
    repository: notesRepository,
    onReminderDue: (projectKey) => {
      for (const context of sessions.values()) {
        if (canonicalProjectKey(context.cwd) === projectKey) {
          context.broadcast("roadmap_reminder_due", {});
        }
      }
    },
    onCommitted: broadcastNotesSnapshot,
    onError: (error) => captureSidecarError(error, "app-sidecar.reminders.coordinator"),
  });
  const reminders = createAppSidecarReminderHandler(reminderCoordinator, (error) =>
    captureSidecarError(error, "app-sidecar.reminders.request"),
  );
  const phaseDeletion = createAppSidecarPhaseDeletionCoordinator({
    repository: notesRepository,
    leases: phaseLeaseRepository,
    reconciliations: roadmapReconciliations,
    listSessions: () => [...sessions.values()].map((context) => context.phaseDeletionSession),
    onCommittedSnapshot: broadcastNotesSnapshot,
  });
  const notes = createAppSidecarNotesHandler({
    repository: notesRepository,
    phaseDeletion: {
      execute: async (input, context) => {
        const owner = sessions.get(context.logicalSessionId);
        if (!owner || canonicalProjectKey(owner.cwd) !== canonicalProjectKey(context.cwd)) {
          return {
            status: "unavailable",
            message: "The authenticated project session is unavailable.",
          };
        }
        return phaseDeletion.execute(input, owner.phaseDeletionSession);
      },
    },
    diagnostics: storageDiagnostics,
    onCommittedSnapshot: broadcastNotesSnapshot,
    onError: (error) => {
      captureSidecarError(error, "app-sidecar.notes.request");
      log("ERROR", "app-sidecar", "notes request failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    },
  });
  return {
    notesRepository,
    durableRoadmapExecution,
    storageDiagnostics,
    roadmapReconciliations,
    roadmapDrafts,
    projectAutopilot,
    broadcastNotesSnapshot,
    phaseBinding,
    roadmapDraftDecisions,
    phaseCancellations,
    reminderCoordinator,
    reminders,
    notes,
  };
}

/** Daemon-level `POST /phases/:id/cancel`. Returns true when it handled the request. */
export function handleAppSidecarPhaseCancellationRoute(
  method: string,
  url: string,
  res: http.ServerResponse,
  ctx: { cwd: string },
  phaseCancellations: AppSidecarPhaseCancellationCoordinator,
): boolean {
  const phaseCancellationMatch = method === "POST" ? /^\/phases\/([^/]+)\/cancel$/.exec(url) : null;
  if (phaseCancellationMatch) {
    let phaseId: string;
    try {
      phaseId = decodeURIComponent(phaseCancellationMatch[1] ?? "");
    } catch {
      daemonJson(res, 400, { error: "invalid phase id" });
      return true;
    }
    void phaseCancellations
      .cancel(ctx.cwd, phaseId)
      .then((result) => daemonJson(res, 200, result))
      .catch((error) => {
        captureSidecarError(error, "app-sidecar.phase.cancel");
        daemonJson(res, 500, { error: "phase cancellation failed" });
      });
    return true;
  }
  return false;
}
