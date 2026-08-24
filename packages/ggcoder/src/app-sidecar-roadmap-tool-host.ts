import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { Message } from "@kenkaiiii/gg-ai";
import type { AppSidecarProjectAutopilotState } from "./app-sidecar-autopilot-state.js";
import type { AppSidecarRoadmapReviewTrigger } from "./app-sidecar-roadmap-review-scheduler.js";
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
import {
  evaluateRoadmapVerificationEvidence,
  partitionVerificationMessagesForWorkspaceMutation,
} from "./core/verification-evidence.js";

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
  getMessages(): Message[];
  getState(): { sessionId: string; sessionPath: string | null };
  updateActivePhaseStage?(executionStage: "implementing" | "reviewing"): Promise<unknown>;
}

export interface AppSidecarRoadmapToolHostDependencies {
  cwd: string;
  repository: Pick<
    ProjectNotesRepository,
    "recordRoadmapStatusUpdate" | "recordRoadmapFinalReview"
  >;
  canSubmitFinalReview?(actor: Exclude<RoadmapStatusActor, "gg-coder">): boolean;
  getAutopilotFinalReviewClaim?(): AppSidecarRoadmapReviewTrigger | null;
  reconciliations: AppSidecarRoadmapReconciliationCoordinator;
  projectAutopilot: Pick<AppSidecarProjectAutopilotState, "isEnabled">;
  broadcastNotesSnapshot(snapshot: ProjectNotesSnapshot): void;
  now?: () => string;
  onFinalReview?(attempt: AppSidecarFinalReviewAttempt): void;
  onNonCommit?(metadata: { result: string; phaseId: string; updateId: string }): void;
  onError?(error: unknown, metadata: { phaseId: string; updateId: string }): void;
}

export interface AppSidecarFinalReviewAttempt {
  actor: Exclude<RoadmapStatusActor, "gg-coder">;
  input: RoadmapStatusInput;
  result: RoadmapStatusToolResult;
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
    if (actor === "gg-coder" && input.final_review !== null) {
      return { result: "reviewer-not-authorized", phaseId: input.phase_id };
    }
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
      const owningSession = getOwningSession?.();
      const activePhase = owningSession ? activePhaseContext(owningSession) : undefined;
      if (actor === "gg-coder" && activePhase?.phaseId !== input.phase_id) {
        return { result: "phase-not-bound", phaseId: input.phase_id };
      }
      if (
        actor === "gg-coder" &&
        input.transition === "review" &&
        input.verification?.result === "passed"
      ) {
        const messages = owningSession?.getMessages() ?? [];
        const partition =
          input.expected_revision === undefined
            ? { currentMessages: messages, staleMessages: [] }
            : partitionVerificationMessagesForWorkspaceMutation(messages);
        const verificationEvidence = evaluateRoadmapVerificationEvidence({
          doneWhen: activePhase?.doneWhen ?? [],
          evidence: input.evidence,
          expectedRevision: input.expected_revision,
          ...partition,
        });
        if (!verificationEvidence.ready) {
          return {
            result: "verification-incomplete",
            phaseId: input.phase_id,
            ...(input.expected_revision === undefined ? {} : { revision: input.expected_revision }),
            unmetEvidenceCodes: verificationEvidence.unmetEvidenceCodes,
            message:
              "Review was not applied. Passed verification requires one distinct, current-workspace classifier-approved command for each Done When criterion.",
          };
        }
      }
      const statusRequest = {
        updateId: input.update_id,
        phaseId: input.phase_id,
        ...(input.expected_revision === undefined
          ? {}
          : { expectedRevision: input.expected_revision }),
        actor,
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
        ...(actor === "gg-coder"
          ? { expectedSession: activePhase!.session, requireBoundPhase: true }
          : {}),
        autopilotEnabled: this.dependencies.projectAutopilot.isEnabled(cwd),
      };
      if (input.final_review !== null) {
        const reviewActor = actor as Exclude<RoadmapStatusActor, "gg-coder">;
        const result = await this.recordFinalReview(reviewActor, input, statusRequest);
        this.dependencies.onFinalReview?.({ actor: reviewActor, input, result });
        return result;
      }
      const outcome = await this.dependencies.repository.recordRoadmapStatusUpdate(
        cwd,
        statusRequest,
      );
      if (outcome.status === "committed" || outcome.status === "duplicate") {
        if (
          actor === "gg-coder" &&
          input.transition === "review" &&
          outcome.phase.status === "review"
        ) {
          await getOwningSession?.().updateActivePhaseStage?.("reviewing");
        }
        if (outcome.status === "committed") {
          this.dependencies.broadcastNotesSnapshot(outcome.snapshot);
        }
        return {
          result: outcome.status,
          phaseId: input.phase_id,
          revision: outcome.status === "committed" ? outcome.snapshot.revision : outcome.revision,
          statusOutcome: outcome.statusOutcome,
          proposals: outcome.proposals,
          ...(input.transition === "review"
            ? {
                message:
                  "Review submitted and applied. The phase remains in Review until final-review and completion gates pass.",
              }
            : {}),
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

  private async recordFinalReview(
    actor: Exclude<RoadmapStatusActor, "gg-coder">,
    input: RoadmapStatusInput,
    statusUpdate: Parameters<ProjectNotesRepository["recordRoadmapFinalReview"]>[1]["statusUpdate"],
  ): Promise<RoadmapStatusToolResult> {
    const finalReview = input.final_review!;
    const autopilotClaim =
      actor === "ken-autopilot"
        ? this.dependencies.getAutopilotFinalReviewClaim?.()
        : undefined;
    if (
      actor === "ken-autopilot" &&
      (!autopilotClaim ||
        autopilotClaim.phaseId !== input.phase_id ||
        autopilotClaim.reviewId !== finalReview.review_id)
    ) {
      this.dependencies.onNonCommit?.({
        result: "final-review-claim-mismatch",
        phaseId: input.phase_id,
        updateId: input.update_id,
      });
      return {
        result: "final-review-claim-mismatch",
        phaseId: input.phase_id,
        message: "Autopilot final_review must use the active claim's exact phase_id and review_id.",
      };
    }
    if (this.dependencies.canSubmitFinalReview?.(actor) === false) {
      return { result: "completion-checkpoint-blocked", phaseId: input.phase_id };
    }
    const completion = await this.dependencies.repository.recordRoadmapFinalReview(
      this.dependencies.cwd,
      {
        statusUpdate: { ...statusUpdate, actor },
        review: {
          reviewId: finalReview.review_id,
          decision: finalReview.decision,
          evidence: [...finalReview.evidence],
          reason: finalReview.reason,
          acceptsVerificationException: finalReview.accepts_verification_exception,
        },
      },
    );
    if (completion.status === "committed") {
      this.dependencies.broadcastNotesSnapshot(completion.snapshot);
      return {
        result: "completion-review-committed",
        phaseId: input.phase_id,
        revision: completion.snapshot.revision,
        statusOutcome: completion.statusOutcome,
        proposals: completion.proposals,
        gateOutcome: completion.evaluation.gateOutcome,
        unmetGateCodes: completion.evaluation.unmetGateCodes,
        message:
          completion.evaluation.gateOutcome === "done"
            ? "Final review submitted and applied; the phase is complete."
            : "Final review submitted and applied; the phase remains in Review because completion gates are unmet.",
      };
    }
    if (completion.status === "duplicate") {
      return {
        result: "completion-review-duplicate",
        phaseId: input.phase_id,
        revision: completion.revision,
        statusOutcome: completion.statusOutcome,
        proposals: completion.proposals,
        gateOutcome: completion.evaluation.gateOutcome,
        unmetGateCodes: completion.evaluation.unmetGateCodes,
        message:
          completion.evaluation.gateOutcome === "done"
            ? "Final review submitted and applied; the phase is complete."
            : "Final review submitted and applied; the phase remains in Review because completion gates are unmet.",
      };
    }
    if (completion.status === "completion-gate-blocked") {
      const unmetGateCodes = completion.evaluation.unmetGateCodes;
      const result = "completion-gate-blocked" as const;
      this.dependencies.onNonCommit?.({
        result,
        phaseId: input.phase_id,
        updateId: input.update_id,
      });
      return {
        result,
        phaseId: input.phase_id,
        revision: completion.revision,
        gateOutcome: completion.evaluation.gateOutcome,
        unmetGateCodes,
        message: `Final review was not committed because completion gates are unmet: ${unmetGateCodes.join(", ")}.`,
      };
    }
    const result =
      completion.status === "missing"
        ? "notes-missing"
        : completion.status === "corrupt"
          ? "notes-corrupt"
          : completion.status;
    this.dependencies.onNonCommit?.({
      result,
      phaseId: input.phase_id,
      updateId: input.update_id,
    });
    return {
      result,
      phaseId: input.phase_id,
      ...("revision" in completion ? { revision: completion.revision } : {}),
      ...(completion.status === "invalid-review"
        ? { message: completion.message }
        : completion.status === "invalid-reference"
          ? { path: completion.path, message: completion.message }
          : {}),
    };
  }
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
