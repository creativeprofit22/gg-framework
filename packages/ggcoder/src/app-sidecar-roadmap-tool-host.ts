import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { Message } from "@kenkaiiii/gg-ai";
import type { AppSidecarProjectAutopilotState } from "./app-sidecar-autopilot-state.js";
import type { PhaseImplementationPlanProgress } from "./app-sidecar-phase-completion.js";
import type { AppSidecarRoadmapReconciliationCoordinator } from "./app-sidecar-roadmap-reconciliation.js";
import type { ActivePhaseContextV1 } from "./phase-context.js";
import type {
  NotesReference,
  ProjectNotesRepository,
  ProjectNotesSnapshot,
} from "./project-notes-repository.js";
import {
  createRoadmapStatusTool,
  type RoadmapStatusInput,
  type RoadmapStatusToolResult,
} from "./tools/roadmap-status.js";
import {
  evaluateRoadmapVerificationEvidence,
  partitionVerificationMessagesForWorkspaceMutation,
  type RoadmapVerificationEvidenceEvaluation,
} from "./core/verification-evidence.js";

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
  evaluateRoadmapVerificationEvidence?(input: {
    doneWhen: readonly string[];
    evidence: readonly string[];
    expectedRevision: number | undefined;
  }): RoadmapVerificationEvidenceEvaluation;
}

export interface AppSidecarCompletionIntent {
  phaseId: string;
  statusUpdateId: string;
  revision: number;
  session: { sessionId: string; sessionPath: string | null };
}

export interface AppSidecarRoadmapToolHostDependencies {
  cwd: string;
  repository: Pick<ProjectNotesRepository, "recordRoadmapStatusUpdate">;
  reconciliations: AppSidecarRoadmapReconciliationCoordinator;
  projectAutopilot: Pick<AppSidecarProjectAutopilotState, "isEnabled">;
  resolvePlanProgress(input: {
    phaseId: string;
    session: AppSidecarCompletionIntent["session"];
  }): PhaseImplementationPlanProgress | null;
  broadcastNotesSnapshot(snapshot: ProjectNotesSnapshot): void;
  now?: () => string;
  onCompletionIntent?(intent: AppSidecarCompletionIntent): void;
  onNonCommit?(metadata: { result: string; phaseId: string; updateId: string }): void;
  onError?(error: unknown, metadata: { phaseId: string; updateId: string }): void;
}

/** Production host for coding-session roadmap_status registration and execution. */
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
    ];
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
      const owningSession = getOwningSession();
      const activePhase = activePhaseContext(owningSession);
      if (activePhase?.phaseId !== input.phase_id) {
        return { result: "phase-not-bound", phaseId: input.phase_id };
      }
      if (input.transition === "done") {
        const evaluationInput = {
          doneWhen: activePhase.doneWhen,
          evidence: input.evidence,
          expectedRevision: input.expected_revision,
        };
        const messages = owningSession.getMessages();
        const partition = partitionVerificationMessagesForWorkspaceMutation(messages);
        const verificationEvidence =
          owningSession.evaluateRoadmapVerificationEvidence?.(evaluationInput) ??
          evaluateRoadmapVerificationEvidence({ ...evaluationInput, ...partition });
        if (!verificationEvidence.ready) {
          return {
            result: "verification-incomplete",
            phaseId: input.phase_id,
            revision: input.expected_revision,
            unmetEvidenceCodes: verificationEvidence.unmetEvidenceCodes,
            message:
              "Done was not recorded. Passed verification requires one distinct, current-workspace classifier-approved command for each Done When criterion.",
          };
        }
        const planProgress = this.dependencies.resolvePlanProgress({
          phaseId: input.phase_id,
          session: activePhase.session,
        });
        if (!planProgress) {
          return {
            result: "missing-plan-progress",
            phaseId: input.phase_id,
            revision: input.expected_revision,
            message:
              "Done was not recorded because same-session canonical plan progress is unavailable.",
          };
        }
      }

      const outcome = await this.dependencies.repository.recordRoadmapStatusUpdate(cwd, {
        updateId: input.update_id,
        phaseId: input.phase_id,
        expectedRevision: input.expected_revision,
        actor: "gg-coder",
        transition: input.transition,
        progress: input.progress,
        blocker: input.transition === "blocked" ? input.blocker : null,
        requiredExternalAction:
          input.transition === "blocked" ? input.required_external_action : null,
        evidence: [...input.evidence],
        verification: input.verification?.result ?? null,
        verificationReason:
          input.verification && "reason" in input.verification ? input.verification.reason : null,
        proposedReferences: input.proposed_references.map(roadmapReferenceFromToolInput),
        timestamp: (this.dependencies.now ?? (() => new Date().toISOString()))(),
        expectedSession: activePhase.session,
        requireBoundPhase: true,
        autopilotEnabled: this.dependencies.projectAutopilot.isEnabled(cwd),
      });
      if (outcome.status === "committed" || outcome.status === "duplicate") {
        const revision =
          outcome.status === "committed" ? outcome.snapshot.revision : outcome.revision;
        if (outcome.status === "committed") {
          this.dependencies.broadcastNotesSnapshot(outcome.snapshot);
        }
        if (input.transition === "done") {
          this.dependencies.onCompletionIntent?.({
            phaseId: input.phase_id,
            statusUpdateId: input.update_id,
            revision,
            session: { ...activePhase.session },
          });
        }
        return {
          result: outcome.status,
          phaseId: input.phase_id,
          revision,
          statusOutcome: outcome.statusOutcome,
          phaseTransitionOutcome: outcome.statusOutcome,
          ...(input.transition === "done" ? { completionIntentId: input.update_id } : {}),
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
          : outcome.status === "verification-incomplete"
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
