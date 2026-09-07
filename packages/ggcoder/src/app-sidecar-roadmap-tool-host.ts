import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { Message } from "@kenkaiiii/gg-ai";
import type { NotesWorkspaceSnapshotV1, NotesSessionLink } from "@kenkaiiii/gg-core/project-notes";
import type { AppSidecarProjectAutopilotState } from "./app-sidecar-autopilot-state.js";
import type { PhaseImplementationPlanProgress } from "./app-sidecar-phase-completion.js";
import type { AppSidecarRoadmapReconciliationCoordinator } from "./app-sidecar-roadmap-reconciliation.js";
import type { PhaseStatusLeaseFailure } from "./app-sidecar-phase-binding.js";
import type { ActivePhaseContextV1 } from "./phase-context.js";
import type {
  NotesReference,
  ProjectNotesRepository,
  ProjectNotesSnapshot,
} from "./project-notes-repository.js";
import {
  createRoadmapCheckpointTool,
  type RoadmapCheckpointInput,
  type RoadmapCheckpointToolResult,
} from "./tools/roadmap-checkpoint.js";
import {
  createRoadmapStatusTool,
  type RoadmapStatusInput,
  type RoadmapStatusToolResult,
} from "./tools/roadmap-status.js";

export type AppSidecarRoadmapSessionRole = "coding" | "ken" | "ken-autopilot";

export const APP_SIDECAR_KEN_ALLOWED_TOOL_NAMES = [
  "read",
  "grep",
  "find",
  "ls",
  "source_path",
  "web_fetch",
  "web_search",
  "screenshot",
] as const;

export interface AppSidecarRoadmapToolSession {
  getActivePhaseContext(): ActivePhaseContextV1 | undefined;
  getMessages(): Message[];
  getState(): { sessionId: string; sessionPath: string | null };
}

export interface AppSidecarRoadmapToolHostDependencies {
  cwd: string;
  durableExecution: boolean;
  repository: Pick<ProjectNotesRepository, "recordRoadmapStatusUpdate"> &
    Partial<
      Pick<
        ProjectNotesRepository,
        "load" | "checkpointPhaseExecutionStep" | "recordPhaseExecutionEvidence"
      >
    >;
  reconciliations: AppSidecarRoadmapReconciliationCoordinator;
  projectAutopilot: Pick<AppSidecarProjectAutopilotState, "isEnabled">;
  resolvePlanProgress(input: {
    phaseId: string;
    session: NotesSessionLink;
  }): PhaseImplementationPlanProgress | null;
  broadcastNotesSnapshot(snapshot: ProjectNotesSnapshot): void;
  now?: () => string;
  captureWorkspaceSnapshot?: () => Promise<NotesWorkspaceSnapshotV1>;
  mutateWithLeaseFence?<T>(
    operation: () => Promise<T>,
  ): Promise<{ status: "executed"; value: T } | { status: "phase-lease-lost" | "corrupt" }>;
  mutateStatusWithLeaseFence?<T>(
    phaseId: string,
    operation: () => Promise<T>,
  ): Promise<{ status: "executed"; value: T } | { status: PhaseStatusLeaseFailure }>;
  onNonCommit?(metadata: { result: string; phaseId: string; updateId: string }): void;
  onError?(error: unknown, metadata: { phaseId: string; updateId: string }): void;
}

/** Production host for coding-session Roadmap mutation tool registration and execution. */
export class AppSidecarRoadmapToolHost {
  constructor(private readonly dependencies: AppSidecarRoadmapToolHostDependencies) {}

  createSessionTools(
    role: AppSidecarRoadmapSessionRole,
    getOwningSession?: () => AppSidecarRoadmapToolSession,
  ): AgentTool[] {
    if (role !== "coding") return [];
    if (!getOwningSession) {
      throw new Error("Coding roadmap_status registration requires an owning session.");
    }
    return [
      createRoadmapStatusTool("gg-coder", ({ input }) => this.record(input, getOwningSession)),
      ...(this.dependencies.repository.checkpointPhaseExecutionStep &&
      this.dependencies.captureWorkspaceSnapshot &&
      this.dependencies.mutateWithLeaseFence
        ? [
            createRoadmapCheckpointTool("gg-coder", ({ input }) =>
              this.checkpoint(input, getOwningSession),
            ),
          ]
        : []),
    ];
  }

  private async checkpoint(
    input: RoadmapCheckpointInput,
    getOwningSession: () => AppSidecarRoadmapToolSession,
  ): Promise<RoadmapCheckpointToolResult> {
    const { cwd, reconciliations, repository, captureWorkspaceSnapshot } = this.dependencies;
    const reconciliation = reconciliations.tryAcquire(cwd, "implementation-checkpoint");
    if (!reconciliation) {
      return {
        result: "reconciliation-in-progress",
        phaseId: input.phase_id,
        stepId: input.step_id,
      };
    }

    try {
      const activePhase = activePhaseContext(getOwningSession());
      if (activePhase?.phaseId !== input.phase_id) {
        return { result: "phase-not-bound", phaseId: input.phase_id, stepId: input.step_id };
      }
      const fenced = await this.dependencies.mutateWithLeaseFence!(async () => {
        let workspace: NotesWorkspaceSnapshotV1;
        try {
          workspace = await captureWorkspaceSnapshot!();
        } catch {
          return { kind: "workspace-unavailable" as const };
        }
        const outcome = await repository.checkpointPhaseExecutionStep!(cwd, {
          phaseId: input.phase_id,
          expectedRevision: input.expected_revision,
          planHash: input.plan_hash,
          stepId: input.step_id,
          completedAt: (this.dependencies.now ?? (() => new Date().toISOString()))(),
          workspace,
        });
        return { kind: "outcome" as const, outcome };
      });
      if (fenced.status !== "executed") {
        return {
          result: "phase-lease-lost",
          phaseId: input.phase_id,
          stepId: input.step_id,
          revision: input.expected_revision,
          message: "The checkpoint was not saved because this session lost its phase lease.",
        };
      }
      if (fenced.value.kind === "workspace-unavailable") {
        return {
          result: "repository-unverifiable",
          phaseId: input.phase_id,
          stepId: input.step_id,
          revision: input.expected_revision,
          message: "The checkpoint was not saved because the Git workspace could not be verified.",
        };
      }
      const outcome = fenced.value.outcome;
      if (outcome.status === "committed") {
        this.dependencies.broadcastNotesSnapshot(outcome.snapshot);
        return {
          result: "committed",
          phaseId: input.phase_id,
          stepId: input.step_id,
          revision: outcome.snapshot.revision,
        };
      }
      return {
        result: outcome.status,
        phaseId: input.phase_id,
        stepId: input.step_id,
        ...("revision" in outcome ? { revision: outcome.revision } : {}),
      };
    } finally {
      reconciliation.release();
    }
  }

  private async record(
    input: RoadmapStatusInput,
    getOwningSession: () => AppSidecarRoadmapToolSession,
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
      const { sessionId, sessionPath } = getOwningSession().getState();
      const expectedRevision = input.expected_revision;
      const mutate = this.dependencies.mutateStatusWithLeaseFence;
      if (!mutate) throw new Error("Roadmap status requires authenticated mutation fencing.");
      const statusMutation = await mutate(input.phase_id, () =>
        this.dependencies.repository.recordRoadmapStatusUpdate(cwd, {
          updateId: input.update_id,
          phaseId: input.phase_id,
          expectedRevision,
          actor: "gg-coder",
          transition: input.transition,
          progress: input.progress,
          blocker: input.transition === "blocked" ? input.blocker : null,
          requiredExternalAction:
            input.transition === "blocked" ? input.required_external_action : null,
          evidence: input.evidence,
          verification: input.verification?.result ?? null,
          verificationReason:
            input.verification && "reason" in input.verification ? input.verification.reason : null,
          proposedReferences: input.proposed_references.map(roadmapReferenceFromToolInput),
          timestamp: (this.dependencies.now ?? (() => new Date().toISOString()))(),
          expectedSession: { sessionId, sessionPath },
          requireBoundPhase: false,
          autopilotEnabled: this.dependencies.projectAutopilot.isEnabled(cwd),
        }),
      );
      if (statusMutation.status !== "executed") {
        return {
          result: "phase-lease-lost",
          phaseId: input.phase_id,
          revision: expectedRevision,
          message: "Roadmap status was not saved because this session lost its phase lease.",
        };
      }
      const outcome = statusMutation.value;
      if (outcome.status === "committed" || outcome.status === "duplicate") {
        const revision =
          outcome.status === "committed" ? outcome.snapshot.revision : outcome.revision;
        if (outcome.status === "committed") {
          this.dependencies.broadcastNotesSnapshot(outcome.snapshot);
        }
        return {
          result: outcome.status,
          phaseId: input.phase_id,
          revision,
          statusOutcome: outcome.statusOutcome,
          phaseTransitionOutcome: outcome.statusOutcome,

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
          : outcome.status === "verification-incomplete" || outcome.status === "unsupported"
            ? { message: outcome.message }
            : outcome.status === "stale-revision"
              ? { message: staleRevisionMessage(input.expected_revision, outcome.revision) }
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

function staleRevisionMessage(expected: number, current: number): string {
  return `Project Notes revision is stale: expected ${expected}, current ${current}. Reload the current snapshot and retry once with expected_revision=${current}.`;
}

function activePhaseContext(session: AppSidecarRoadmapToolSession):
  | {
      phaseId: string;
      doneWhen: string[];
      session: { sessionId: string; sessionPath: string | null };
    }
  | undefined {
  const context = session.getActivePhaseContext();
  if (!context) return undefined;
  const state = session.getState();
  return {
    phaseId: context.phase.id,
    doneWhen: [...context.phase.doneWhen],
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
