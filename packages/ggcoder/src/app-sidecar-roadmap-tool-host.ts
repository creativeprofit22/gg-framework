import { relative } from "node:path";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { Message } from "@kenkaiiii/gg-ai";
import type {
  NotesVerificationEvidenceV2,
  NotesWorkspaceSnapshotV1,
} from "@kenkaiiii/gg-core/project-notes";
import type { AppSidecarProjectAutopilotState } from "./app-sidecar-autopilot-state.js";
import type { PhaseImplementationPlanProgress } from "./app-sidecar-phase-completion.js";
import type { AppSidecarRoadmapReconciliationCoordinator } from "./app-sidecar-roadmap-reconciliation.js";
import type { ActivePhaseContextV1 } from "./phase-context.js";
import { RepositoryUnverifiableError } from "./roadmap-phase-execution.js";
import type {
  NotesReference,
  ProjectNotesRepository,
  ProjectNotesRoadmapCompletionMode,
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
import {
  ROADMAP_VERIFICATION_CLASSIFIER_VERSION,
  createDurableVerificationEvidence,
  evaluateDurableVerificationEvidence,
  evaluateRoadmapVerificationEvidence,
  formatVerificationCommandDisplay,
  partitionVerificationMessagesForWorkspaceMutation,
  safeToolEnvironmentDigest,
  workspaceVerificationEvidenceMatches,
  type RoadmapVerificationBinding,
  type RoadmapVerificationEvidenceEvaluation,
  type SessionVerificationEvidenceLedgerSnapshot,
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
  getVerificationEvidenceLedgerSnapshot?(): SessionVerificationEvidenceLedgerSnapshot;
  evaluateRoadmapVerificationEvidence?(input: {
    doneWhen: readonly string[];
    evidence: readonly string[];
    verificationBindings: readonly RoadmapVerificationBinding[];
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
    session: AppSidecarCompletionIntent["session"];
  }): PhaseImplementationPlanProgress | null;
  broadcastNotesSnapshot(snapshot: ProjectNotesSnapshot): void;
  now?: () => string;
  captureWorkspaceSnapshot?: () => Promise<NotesWorkspaceSnapshotV1>;
  captureVerificationWorkspace?: () => Promise<NotesWorkspaceSnapshotV1>;
  captureSafeToolEnvironmentDigest?: () => string;
  getRunGeneration?: () => number;
  mutateWithLeaseFence?<T>(
    operation: () => Promise<T>,
  ): Promise<{ status: "executed"; value: T } | { status: "phase-lease-lost" | "corrupt" }>;
  onCompletionIntent?(intent: AppSidecarCompletionIntent): void;
  onNonCommit?(metadata: { result: string; phaseId: string; updateId: string }): void;
  onError?(error: unknown, metadata: { phaseId: string; updateId: string }): void;
}

function partitionLedgerEvidenceForWorkspace(
  ledger: SessionVerificationEvidenceLedgerSnapshot | undefined,
  workspace: NotesWorkspaceSnapshotV1,
  safeToolEnvironmentDigest: string,
  cwd: string,
): SessionVerificationEvidenceLedgerSnapshot {
  const candidates = ledger?.currentEvidence ?? [];
  // Snapshot equality cannot undo start/end generation invalidation in the ledger.
  const currentEvidence = candidates.filter(
    (item) =>
      item.cwd &&
      relative(cwd, item.cwd) === "" &&
      item.workspace &&
      item.safeToolEnvironmentDigest &&
      item.classifierVersion === ROADMAP_VERIFICATION_CLASSIFIER_VERSION &&
      workspaceVerificationEvidenceMatches(
        {
          workspace: item.workspace,
          safeToolEnvironmentDigest: item.safeToolEnvironmentDigest,
        },
        { workspace, safeToolEnvironmentDigest },
      ),
  );
  return {
    currentEvidence,
    staleEvidence: [
      ...(ledger?.staleEvidence ?? []),
      ...candidates.filter((item) => !currentEvidence.includes(item)),
    ],
  };
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

  private mutate<T>(
    operation: () => Promise<T>,
  ): Promise<{ status: "executed"; value: T } | { status: "phase-lease-lost" | "corrupt" }> {
    return this.dependencies.mutateWithLeaseFence
      ? this.dependencies.mutateWithLeaseFence(operation)
      : operation().then((value) => ({ status: "executed" as const, value }));
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

  private async prepareDurableCompletion(
    input: RoadmapStatusInput,
    owningSession: AppSidecarRoadmapToolSession,
    activePhase: NonNullable<ReturnType<typeof activePhaseContext>>,
    expectedRevision: number,
  ): Promise<
    | { kind: "legacy"; expectedRevision: number }
    | {
        kind: "ready";
        expectedRevision: number;
        workspace: NotesWorkspaceSnapshotV1;
        planHash: string;
        runGeneration: number;
        evidence: string[];
        verificationEvidence: NotesVerificationEvidenceV2[];
        safeToolEnvironmentDigest: string;
      }
    | { kind: "failure"; expectedRevision: number; result: RoadmapStatusToolResult }
  > {
    if (!this.dependencies.durableExecution) return { kind: "legacy", expectedRevision };
    const { repository, captureWorkspaceSnapshot, getRunGeneration } = this.dependencies;
    if (!repository.load || !captureWorkspaceSnapshot) {
      return {
        kind: "failure",
        expectedRevision,
        result: {
          result: "missing-plan-progress",
          phaseId: input.phase_id,
          revision: expectedRevision,
          message: "Done was not recorded because durable completion preparation is unavailable.",
        },
      };
    }
    const loaded = await repository.load(this.dependencies.cwd);
    if (loaded.status !== "ok") {
      return {
        kind: "failure",
        expectedRevision,
        result: {
          result: loaded.status === "missing" ? "notes-missing" : "notes-corrupt",
          phaseId: input.phase_id,
        },
      };
    }
    if (loaded.snapshot.revision !== expectedRevision) {
      return {
        kind: "failure",
        expectedRevision,
        result: {
          result: "stale-revision",
          phaseId: input.phase_id,
          revision: loaded.snapshot.revision,
          message: staleRevisionMessage(expectedRevision, loaded.snapshot.revision),
        },
      };
    }
    const phase = loaded.snapshot.document.phases.find(
      (candidate) => candidate.id === input.phase_id,
    );
    const execution = phase?.execution;
    if (!phase || !execution?.plan) {
      return {
        kind: "failure",
        expectedRevision,
        result: {
          result: "missing-plan-progress",
          phaseId: input.phase_id,
          revision: expectedRevision,
          message: "Done was not recorded because the durable execution plan is unavailable.",
        },
      };
    }
    if (!getRunGeneration) {
      return {
        kind: "failure",
        expectedRevision,
        result: {
          result: "missing-plan-progress",
          phaseId: input.phase_id,
          revision: expectedRevision,
          message: "Done was not recorded because durable run-journal recovery is unavailable.",
        },
      };
    }

    let workspace: NotesWorkspaceSnapshotV1;
    try {
      workspace = await captureWorkspaceSnapshot();
    } catch (error) {
      return {
        kind: "failure",
        expectedRevision,
        result:
          error instanceof RepositoryUnverifiableError
            ? {
                result: "repository-unverifiable",
                phaseId: input.phase_id,
                revision: expectedRevision,
                message: error.message,
              }
            : {
                result: "verification-incomplete",
                phaseId: input.phase_id,
                revision: expectedRevision,
                unmetEvidenceCodes: ["stale-evidence", "missing-approved-evidence"],
                message: "Done was not recorded because the Git workspace could not be verified.",
              },
      };
    }

    const currentEnvironmentDigest =
      this.dependencies.captureSafeToolEnvironmentDigest?.() ?? safeToolEnvironmentDigest();
    const persisted = evaluateDurableVerificationEvidence({
      doneWhen: activePhase.doneWhen,
      evidence: execution.evidence,
      verificationBindings: input.verification_bindings.map((binding) => ({
        criterionId: binding.criterion_id,
        executionId: binding.execution_id,
      })),
      workspace,
      safeToolEnvironmentDigest: currentEnvironmentDigest,
    });
    let verificationEvidence = persisted.ready
      ? persisted.criterionCoverage.map(
          (coverage) =>
            execution.evidence.find(
              (record): record is NotesVerificationEvidenceV2 =>
                "version" in record &&
                record.version === 2 &&
                record.executionId === coverage.executionId,
            )!,
        )
      : [];
    let statusEvidence = verificationEvidence.map((record) => record.commandDisplay);
    if (!persisted.ready) {
      const ledgerPartition = partitionLedgerEvidenceForWorkspace(
        owningSession.getVerificationEvidenceLedgerSnapshot?.(),
        workspace,
        currentEnvironmentDigest,
        this.dependencies.cwd,
      );
      const transient = evaluateRoadmapVerificationEvidence({
        doneWhen: activePhase.doneWhen,
        evidence: input.evidence,
        verificationBindings: input.verification_bindings.map((binding) => ({
          criterionId: binding.criterion_id,
          executionId: binding.execution_id,
        })),
        expectedRevision,
        currentMessages: [],
        staleMessages: [],
        currentLedgerEvidence: ledgerPartition.currentEvidence,
        staleLedgerEvidence: ledgerPartition.staleEvidence,
      });
      if (!transient.ready) {
        return {
          kind: "failure",
          expectedRevision,
          result: {
            result: "verification-incomplete",
            phaseId: input.phase_id,
            revision: expectedRevision,
            unmetEvidenceCodes: transient.unmetEvidenceCodes,
            staleCriterionIds: persisted.staleCriterionIds,
            missingCriterionIds: persisted.missingCriterionIds,
            message:
              "Done was not recorded. Rerun verification only for the listed stale or missing criteria on the current workspace.",
          },
        };
      }
      verificationEvidence = createDurableVerificationEvidence({
        coverage: transient.criterionCoverage,
      });
      statusEvidence = verificationEvidence.map((record) => record.commandDisplay);
    }
    if (!phase.execution?.plan?.steps.every((step) => step.state === "completed")) {
      return {
        kind: "failure",
        expectedRevision,
        result: {
          result: "missing-plan-progress",
          phaseId: input.phase_id,
          revision: expectedRevision,
          message:
            "Done was not recorded because durable plan steps remain incomplete or need revalidation.",
        },
      };
    }
    return {
      kind: "ready",
      expectedRevision,
      workspace,
      planHash: execution.plan.contentHash,
      runGeneration: getRunGeneration(),
      evidence: statusEvidence,
      verificationEvidence,
      safeToolEnvironmentDigest: currentEnvironmentDigest,
    };
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
      let expectedRevision = input.expected_revision;
      let statusEvidence = [...input.evidence];
      const completionMode: ProjectNotesRoadmapCompletionMode | undefined =
        input.transition === "done"
          ? this.dependencies.durableExecution
            ? "durable"
            : "legacy-run-finalizer"
          : undefined;
      let durableCompletion: {
        workspace: NotesWorkspaceSnapshotV1;
        planHash: string;
        runJournal: { sessionPath: string | null; generation: number };
        safeToolEnvironmentDigest: string;
        verificationEvidence: NotesVerificationEvidenceV2[];
      } | null = null;
      if (input.transition === "done") {
        const durable = await this.prepareDurableCompletion(
          input,
          owningSession,
          activePhase,
          expectedRevision,
        );
        if (durable.kind === "failure") return durable.result;
        expectedRevision = durable.expectedRevision;
        if (durable.kind === "ready") {
          durableCompletion = {
            workspace: durable.workspace,
            planHash: durable.planHash,
            runJournal: {
              sessionPath: activePhase.session.sessionPath,
              generation: durable.runGeneration,
            },
            safeToolEnvironmentDigest: durable.safeToolEnvironmentDigest,
            verificationEvidence: durable.verificationEvidence,
          };
          statusEvidence = durable.evidence;
        }
        if (durable.kind === "legacy") {
          const evaluationInput = {
            doneWhen: activePhase.doneWhen,
            evidence: input.evidence,
            verificationBindings: input.verification_bindings.map((binding) => ({
              criterionId: binding.criterion_id,
              executionId: binding.execution_id,
            })),
            expectedRevision,
          };
          const captureWorkspace = this.dependencies.captureVerificationWorkspace;
          if (!captureWorkspace) {
            return {
              result: "verification-incomplete",
              phaseId: input.phase_id,
              revision: expectedRevision,
              unmetEvidenceCodes: ["stale-evidence", "missing-approved-evidence"],
              message:
                "Done was not recorded because the current Git workspace could not be verified.",
            };
          }
          let workspace: NotesWorkspaceSnapshotV1;
          try {
            workspace = await captureWorkspace();
          } catch (error) {
            return error instanceof RepositoryUnverifiableError
              ? {
                  result: "repository-unverifiable",
                  phaseId: input.phase_id,
                  revision: expectedRevision,
                  message: error.message,
                }
              : {
                  result: "verification-incomplete",
                  phaseId: input.phase_id,
                  revision: expectedRevision,
                  unmetEvidenceCodes: ["stale-evidence", "missing-approved-evidence"],
                  message:
                    "Done was not recorded because the current Git workspace could not be verified.",
                };
          }
          const currentEnvironmentDigest =
            this.dependencies.captureSafeToolEnvironmentDigest?.() ?? safeToolEnvironmentDigest();
          const ledgerPartition = partitionLedgerEvidenceForWorkspace(
            owningSession.getVerificationEvidenceLedgerSnapshot?.(),
            workspace,
            currentEnvironmentDigest,
            cwd,
          );
          const partition = partitionVerificationMessagesForWorkspaceMutation(
            owningSession.getMessages(),
          );
          const verificationEvidence = evaluateRoadmapVerificationEvidence({
            ...evaluationInput,
            ...partition,
            currentLedgerEvidence: ledgerPartition.currentEvidence,
            staleLedgerEvidence: ledgerPartition.staleEvidence,
          });
          if (!verificationEvidence.ready) {
            return {
              result: "verification-incomplete",
              phaseId: input.phase_id,
              revision: expectedRevision,
              unmetEvidenceCodes: verificationEvidence.unmetEvidenceCodes,
              message:
                "Done was not recorded. Passed verification requires one distinct, current-workspace classifier-approved command for each Done When criterion.",
            };
          }
          statusEvidence = verificationEvidence.criterionCoverage.map((coverage) =>
            formatVerificationCommandDisplay(coverage.command),
          );
          const planProgress = this.dependencies.resolvePlanProgress({
            phaseId: input.phase_id,
            session: activePhase.session,
          });
          if (!planProgress) {
            return {
              result: "missing-plan-progress",
              phaseId: input.phase_id,
              revision: expectedRevision,
              message:
                "Done was not recorded because canonical approved-plan/checkpoint progress is unavailable for the bound session. Rebinding or status prose does not create canonical progress. Resume the original approved-plan session or obtain approval for a new recovery plan.",
            };
          }
        }
      }

      const statusMutation = await this.mutate(() =>
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
          evidence: statusEvidence,
          verification: input.verification?.result ?? null,
          verificationReason:
            input.verification && "reason" in input.verification ? input.verification.reason : null,
          proposedReferences: input.proposed_references.map(roadmapReferenceFromToolInput),
          timestamp: (this.dependencies.now ?? (() => new Date().toISOString()))(),
          expectedSession: activePhase.session,
          requireBoundPhase: true,
          autopilotEnabled: this.dependencies.projectAutopilot.isEnabled(cwd),
          ...(completionMode ? { completionMode } : {}),
          ...(durableCompletion ? { durableCompletion } : {}),
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
