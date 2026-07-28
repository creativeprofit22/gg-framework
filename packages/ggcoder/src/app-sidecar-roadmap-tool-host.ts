import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { AppSidecarProjectAutopilotState } from "./app-sidecar-autopilot-state.js";
import type { AppSidecarRoadmapReconciliationCoordinator } from "./app-sidecar-roadmap-reconciliation.js";
import type { ActivePhaseContextV1 } from "./phase-context.js";
import type {
  NotesReference,
  ProjectNotesRepository,
  ProjectNotesSnapshot,
} from "./project-notes-repository.js";
import {
  createRoadmapStatusTool,
  type RoadmapStatusActor,
  type RoadmapStatusInput,
  type RoadmapStatusToolResult,
} from "./tools/roadmap-status.js";

export type AppSidecarRoadmapSessionRole = "coding" | "ken" | "ken-autopilot";

/** Ken stays read-only except for this structured Roadmap metadata write. */
export const APP_SIDECAR_KEN_ALLOWED_TOOL_NAMES = [
  "read",
  "grep",
  "find",
  "ls",
  "source_path",
  "web_fetch",
  "web_search",
  "screenshot",
  "roadmap_status",
] as const;

export interface AppSidecarRoadmapToolSession {
  getActivePhaseContext(): ActivePhaseContextV1 | undefined;
  getState(): { sessionId: string; sessionPath: string | null };
}

export interface AppSidecarRoadmapToolHostDependencies {
  cwd: string;
  repository: Pick<ProjectNotesRepository, "recordRoadmapStatusUpdate">;
  reconciliations: AppSidecarRoadmapReconciliationCoordinator;
  projectAutopilot: Pick<AppSidecarProjectAutopilotState, "isEnabled">;
  broadcastNotesSnapshot(snapshot: ProjectNotesSnapshot): void;
  now?: () => string;
  onNonCommit?(metadata: { result: string; phaseId: string; updateId: string }): void;
  onError?(error: unknown, metadata: { phaseId: string; updateId: string }): void;
}

const ACTOR_BY_ROLE: Record<AppSidecarRoadmapSessionRole, RoadmapStatusActor> = {
  coding: "gg-coder",
  ken: "ken",
  "ken-autopilot": "ken-autopilot",
};

/** Production host for every app-only roadmap_status registration and execution. */
export class AppSidecarRoadmapToolHost {
  constructor(private readonly dependencies: AppSidecarRoadmapToolHostDependencies) {}

  createSessionTools(
    role: AppSidecarRoadmapSessionRole,
    getOwningSession?: () => AppSidecarRoadmapToolSession,
  ): AgentTool[] {
    if (role === "coding" && !getOwningSession) {
      throw new Error("Coding roadmap_status registration requires an owning session.");
    }
    const actor = ACTOR_BY_ROLE[role];
    return [
      createRoadmapStatusTool(actor, ({ input }) =>
        this.record(actor, input, role === "coding" ? getOwningSession : undefined),
      ),
    ];
  }

  private async record(
    actor: RoadmapStatusActor,
    input: RoadmapStatusInput,
    getOwningSession?: () => AppSidecarRoadmapToolSession,
  ): Promise<RoadmapStatusToolResult> {
    const { cwd, reconciliations } = this.dependencies;
    const reconciliation = reconciliations.tryAcquire(cwd, "status-update");
    if (!reconciliation) {
      const owner = reconciliations.owner(cwd);
      return {
        result: "reconciliation-in-progress",
        phaseId: input.phase_id,
        owner: owner ? { operationId: owner.operationId, kind: owner.kind } : null,
      };
    }

    try {
      const activePhase = getOwningSession ? activePhaseContext(getOwningSession()) : undefined;
      if (actor === "gg-coder" && activePhase?.phaseId !== input.phase_id) {
        return { result: "phase-not-bound", phaseId: input.phase_id };
      }
      const outcome = await this.dependencies.repository.recordRoadmapStatusUpdate(cwd, {
        updateId: input.update_id,
        phaseId: input.phase_id,
        ...(input.expected_revision === undefined
          ? {}
          : { expectedRevision: input.expected_revision }),
        actor,
        transition: input.transition,
        progress: input.progress,
        blocker: input.transition === "blocked" ? input.blocker : null,
        evidence: [...input.evidence],
        proposedReferences: input.proposed_references.map(roadmapReferenceFromToolInput),
        timestamp: (this.dependencies.now ?? (() => new Date().toISOString()))(),
        ...(actor === "gg-coder"
          ? { expectedSession: activePhase!.session, requireBoundPhase: true }
          : {}),
        autopilotEnabled: this.dependencies.projectAutopilot.isEnabled(cwd),
      });
      if (outcome.status === "committed") {
        this.dependencies.broadcastNotesSnapshot(outcome.snapshot);
        return {
          result: "committed",
          phaseId: input.phase_id,
          revision: outcome.snapshot.revision,
          statusOutcome: outcome.statusOutcome,
          proposals: outcome.proposals,
        };
      }
      if (outcome.status === "duplicate") {
        return {
          result: "duplicate",
          phaseId: input.phase_id,
          revision: outcome.revision,
          statusOutcome: outcome.statusOutcome,
          proposals: outcome.proposals,
        };
      }
      const result =
        outcome.status === "missing"
          ? "notes-missing"
          : outcome.status === "corrupt"
            ? "notes-corrupt"
            : outcome.status;
      this.dependencies.onNonCommit?.({
        result,
        phaseId: input.phase_id,
        updateId: input.update_id,
      });
      return {
        result,
        phaseId: input.phase_id,
        ...("revision" in outcome ? { revision: outcome.revision } : {}),
        ...(outcome.status === "invalid-reference"
          ? { path: outcome.path, message: outcome.message }
          : {}),
      };
    } catch (error) {
      this.dependencies.onError?.(error, {
        phaseId: input.phase_id,
        updateId: input.update_id,
      });
      throw error;
    } finally {
      reconciliation.release();
    }
  }
}

function activePhaseContext(session: AppSidecarRoadmapToolSession):
  | {
      phaseId: string;
      session: { sessionId: string; sessionPath: string | null };
    }
  | undefined {
  const context = session.getActivePhaseContext();
  if (!context) return undefined;
  const state = session.getState();
  return {
    phaseId: context.phase.id,
    session: { sessionId: state.sessionId, sessionPath: state.sessionPath },
  };
}

function roadmapReferenceFromToolInput(
  reference: RoadmapStatusInput["proposed_references"][number],
): Omit<NotesReference, "id" | "capturedAt"> {
  return {
    provider: reference.provider,
    tool: reference.tool,
    canonicalUrl: reference.canonical_url,
    owner: reference.owner,
    repo: reference.repo,
    revision: reference.revision,
    path: reference.path,
    range: reference.range
      ? { startLine: reference.range.start_line, endLine: reference.range.end_line }
      : null,
    issue: reference.issue,
    pullRequest: reference.pull_request,
    query: reference.query,
    anchor: reference.anchor,
    relevance: reference.relevance,
  };
}
