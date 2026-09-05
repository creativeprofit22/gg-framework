import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  ManualCompletionApprovalCommitOutcome,
  ManualCompletionApprovalGateCode,
} from "@kenkaiiii/gg-core/manual-completion-approval-protocol";
import type {
  PhaseBindingAction,
  PhaseBindingOutcome,
  PhaseExecutionReconciliationOutcome,
  PhaseExecutionReconciliationRequestV3,
} from "@kenkaiiii/gg-core/phase-binding-protocol";
import { withFileLock } from "@kenkaiiii/gg-core";
import {
  canonicalProjectKey,
  canonicalReferenceIdentity,
  classifyLegacyNotesLifecycleEvent,
  classifyRoadmapAutoStartEligibility,
  isNotesDirectCompletionAuthority,
  isNotesLifecycleEventSource,
  isNotesPhaseStatus,
  isNotesReminderDeliveryChannel,
  isNotesReminderPermission,
  isNotesVerificationEvidenceSatisfied,
  isValidNotesReminderDeliveryPair,
  migrateNotesDocumentV2,
  migrateNotesDocumentV3PhaseShape,
  normalizeCanonicalUrl,
  notesPhaseStatusForRoadmapTransition,
  notesSessionLinksEqual,
  validateNotesDocumentV3,
  validateNotesImplementationCheckpointFields,
  validateNotesPhaseExecution,
  type NotesDocumentV3,
  type NotesApprovedPlanV1,
  type NotesImplementationRunOutcome,
  type NotesLifecycleEventKind,
  type NotesLifecycleEventSource,
  type NotesPendingCompletionV1,
  type NotesPhase,
  type NotesPhaseExecutionV1,
  type NotesPhaseStatus,
  type NotesReference,
  type NotesReminderDeliveryChannel,
  type NotesReminderPermission,
  type NotesRoadmapActor,
  type NotesRoadmapBlockerResolution,
  type NotesRoadmapCompletionReview,
  type NotesRoadmapImplementationCheckpoint,
  type NotesRoadmapManualCompletionApproval,
  type NotesRoadmapPhaseAdvancementCheckpoint,
  type NotesRoadmapPhaseAdvancementConfirmation,
  type NotesRoadmapPhaseBinding,
  type NotesRoadmapReferencePolicyOutcome,
  type NotesRoadmapReferenceProposal,
  type NotesRoadmapStatusOutcome,
  type NotesRoadmapStatusUpdate,
  type NotesRoadmapTransition,
  type NotesRepositoryIdentityV1,
  type NotesSessionLink,
  type NotesValidationError,
  type NotesVerificationEvidence,
  type NotesVerificationEvidenceV2,
  type NotesWorkspaceSnapshotV1,
  type NotesValidationResult,
  type NotesVerificationStatus,
  type ProjectNotesCorruptReason,
  type ProjectNotesCorruption,
  type ProjectNotesLoadOutcome,
  type ProjectNotesMigrationOutcome,
  type ProjectNotesSaveOutcome,
  type ProjectNotesSnapshot,
} from "@kenkaiiii/gg-core/project-notes";
export * from "@kenkaiiii/gg-core/project-notes";
import {
  validateRoadmapPhaseDraft,
  type RoadmapPhaseDraft,
  type RoadmapPhaseDraftApprovalResult,
} from "@kenkaiiii/gg-core/roadmap-workflow";
import {
  evaluateDirectPhaseCompletion,
  evaluateManualCompletionApproval,
  type PhaseCompletionEvaluation,
} from "./project-notes-completion-policy.js";
import {
  ROADMAP_VERIFICATION_CLASSIFIER_VERSION,
  roadmapCriterionId,
} from "./core/verification-evidence.js";
import {
  isEvidenceCurrent,
  reconcilePlanSteps,
  workspaceSnapshotsEqual,
} from "./roadmap-phase-execution.js";

export interface StoredProjectNotesV1 {
  storeVersion: 1;
  projectKey: string;
  revision: number;
  document: NotesDocumentV3;
}

export interface ProjectNotesReminderDeliveryRequest {
  phaseId: string;
  occurrenceKey: string;
  attemptedAt: string;
  channel: NotesReminderDeliveryChannel;
  permission: NotesReminderPermission;
}

export type ProjectNotesReminderDeliveryOutcome =
  | { status: "ok"; snapshot: ProjectNotesSnapshot; phase: NotesPhase }
  | {
      status:
        | "phase-not-found"
        | "phase-inactive"
        | "phase-archived"
        | "reminder-not-found"
        | "stale-occurrence"
        | "not-due"
        | "already-delivered";
    }
  | { status: "invalid"; error: NotesValidationError }
  | { status: "missing" }
  | ({ status: "corrupt" } & ProjectNotesCorruption);

export interface FrozenPhaseLaunchContext {
  projectKey: string;
  phase: NotesPhase;
  references: NotesReference[];
}

export type ProjectNotesPhaseLaunchOutcome =
  | {
      status: "accepted";
      snapshot: ProjectNotesSnapshot;
      phase: NotesPhase;
      references: NotesReference[];
      session: NotesSessionLink;
    }
  | {
      status: "already-bound";
      snapshot: ProjectNotesSnapshot;
      phase: NotesPhase;
      references: NotesReference[];
      session: NotesSessionLink;
    }
  | { status: "phase-not-found" }
  | { status: "phase-archived" }
  | { status: "done-terminal" }
  | { status: "advancement-confirmation-required"; checkpointId: string }
  | { status: "missing" }
  | ({ status: "corrupt" } & ProjectNotesCorruption);

export type ProjectNotesManualApprovalPreviewOutcome =
  | {
      status: "ready";
      revision: number;
      projectKey: string;
      phaseId: string;
      session: NotesSessionLink;
      implementationCheckpointId: string;
      verificationStatusUpdateId: string;
    }
  | { status: "stale-revision"; revision: number }
  | { status: "unmet-gate"; revision: number; code: ManualCompletionApprovalGateCode }
  | { status: "missing" }
  | {
      status: "corrupt";
      primary: ProjectNotesCorruptReason | null;
      backup: ProjectNotesCorruptReason | null;
    };

export interface ProjectNotesManualApprovalCommitRequest {
  phaseId: string;
  expectedRevision: number;
  expectedSession: NotesSessionLink;
  implementationCheckpointId: string;
  verificationStatusUpdateId: string;
  approvalId: string;
  timestamp: string;
}

export interface ProjectNotesPhaseBindingRequest {
  action: PhaseBindingAction;
  phaseId: string;
  expectedProjectKey: string;
  expectedRevision: number;
  expectedPreviousSession: NotesSessionLink | null;
  operationId: string;
  destinationSession: NotesSessionLink;
  timestamp: string;
}

export interface ProjectNotesPhaseAdvancementStartRequest {
  checkpointId: string;
  nextPhaseId: string;
  action: "start-next-phase";
  operationId: string;
}

export type ProjectNotesPhaseAdvancementStartOutcome =
  | Extract<ProjectNotesPhaseLaunchOutcome, { status: "accepted" | "already-bound" }>
  | {
      status: "stale";
      reason:
        | "checkpoint-not-found"
        | "checkpoint-confirmed"
        | "completion-not-authoritative"
        | "target-mismatch"
        | "target-ineligible";
    }
  | { status: "invalid-confirmation" }
  | { status: "missing" }
  | ({ status: "corrupt" } & ProjectNotesCorruption);

export interface ProjectNotesAutomaticPhaseAdvancementRequest {
  checkpointId: string;
  expectedRevision: number;
  destinationSession: NotesSessionLink;
  timestamp: string;
}

export type ProjectNotesAutomaticPhaseAdvancementOutcome =
  | (Extract<ProjectNotesPhaseLaunchOutcome, { status: "accepted" | "already-bound" }> & {
      operationId: string;
    })
  | {
      status: "stale";
      reason:
        | "checkpoint-not-found"
        | "checkpoint-confirmed"
        | "manual-confirmation-required"
        | "completion-not-authoritative"
        | "target-mismatch"
        | "target-ineligible"
        | "stale-revision"
        | "session-mismatch"
        | "session-in-use";
    }
  | { status: "invalid-confirmation" }
  | { status: "missing" }
  | ({ status: "corrupt" } & ProjectNotesCorruption);

export type ProjectNotesPhaseLinkOutcome =
  | { status: "ok"; snapshot: ProjectNotesSnapshot; phase: NotesPhase }
  | { status: "stale-session" }
  | { status: "phase-not-found" }
  | { status: "phase-archived" }
  | { status: "missing" }
  | ({ status: "corrupt" } & ProjectNotesCorruption);

export type NotesAutomaticPhaseStatus = Exclude<NotesPhaseStatus, "not-started" | "done">;

export interface ProjectNotesPhaseLifecycleTransition {
  status: NotesAutomaticPhaseStatus;
  source: NotesLifecycleEventSource;
  reason: string;
  timestamp: string;
  kind?: NotesLifecycleEventKind;
  expectedSession?: NotesSessionLink | null;
}

export type ProjectNotesPhaseLifecycleOutcome =
  | { status: "ok"; snapshot: ProjectNotesSnapshot; phase: NotesPhase }
  | {
      status: "manual-override";
      snapshot: ProjectNotesSnapshot;
      phase: NotesPhase;
    }
  | {
      status:
        | "same-status"
        | "phase-not-found"
        | "phase-archived"
        | "stale-session"
        | "done-terminal";
    }
  | { status: "missing" }
  | ({ status: "corrupt" } & ProjectNotesCorruption);

export interface ProjectNotesRoadmapBlockerResolutionRequest {
  resolutionId: string;
  phaseId: string;
  blockerUpdateId: string;
  expectedRevision: number;
  expectedSession: NotesSessionLink | null;
  resolver: "user";
  timestamp: string;
}

export type ProjectNotesRoadmapBlockerResolutionOutcome =
  | { status: "committed"; snapshot: ProjectNotesSnapshot; phase: NotesPhase }
  | { status: "duplicate" | "already-resolved"; revision: number; phaseId: string }
  | { status: "duplicate-id-conflict" | "stale-revision"; revision: number }
  | {
      status: "phase-not-found" | "phase-archived" | "stale-session" | "blocker-not-found";
    }
  | { status: "missing" }
  | ({ status: "corrupt" } & ProjectNotesCorruption);

export type ProjectNotesRoadmapCompletionMode = "legacy-run-finalizer" | "durable";

export interface ProjectNotesRoadmapStatusRequest {
  updateId: string;
  phaseId: string;
  expectedRevision?: number;
  actor: NotesRoadmapActor;
  transition: NotesRoadmapTransition;
  completionMode?: ProjectNotesRoadmapCompletionMode;
  progress: string;
  blocker: string | null;
  requiredExternalAction: string | null;
  evidence: string[];
  verification: NotesVerificationStatus | null;
  verificationReason: string | null;
  proposedReferences: Array<Omit<NotesReference, "id" | "capturedAt">>;
  timestamp: string;
  expectedSession?: NotesSessionLink | null;
  requireBoundPhase?: boolean;
  autopilotEnabled: boolean;
  durableCompletion?: Omit<NotesPendingCompletionV1, "completionId" | "statusRevision"> & {
    safeToolEnvironmentDigest: string;
    verificationEvidence: NotesVerificationEvidenceV2[];
  };
}

export interface ProjectNotesRoadmapProposalOutcome {
  proposalId: string;
  outcome: "pending" | "accepted" | "reused";
  policyOutcome: NotesRoadmapReferencePolicyOutcome;
  referenceId: string | null;
}

export interface ProjectNotesImplementationCheckpointRequest {
  checkpointId: string;
  phaseId: string;
  expectedSession: NotesSessionLink;
  planStepTotal: number;
  completedPlanSteps: number[];
  runOutcome: NotesImplementationRunOutcome;
  timestamp: string;
}

export type ProjectNotesImplementationCheckpointOutcome =
  | { status: "committed"; snapshot: ProjectNotesSnapshot; phase: NotesPhase }
  | { status: "duplicate"; revision: number; phaseId: string }
  | { status: "duplicate-id-conflict" | "operation-conflict"; revision: number }
  | { status: "invalid-checkpoint"; message: string }
  | { status: "phase-not-found" | "phase-archived" | "stale-session" }
  | { status: "missing" }
  | ({ status: "corrupt" } & ProjectNotesCorruption);

export interface ProjectNotesPhaseCompletionSettlementRequest extends ProjectNotesImplementationCheckpointRequest {
  completionIntentId: string;
  expectedRevision?: number;
}

export type ProjectNotesPhaseCompletionSettlementOutcome =
  | {
      status: "committed" | "open";
      snapshot: ProjectNotesSnapshot;
      phase: NotesPhase;
      evaluation: PhaseCompletionEvaluation;
      advancementCheckpoint: NotesRoadmapPhaseAdvancementCheckpoint | null;
    }
  | {
      status: "duplicate";
      revision: number;
      phase: NotesPhase;
      evaluation: PhaseCompletionEvaluation;
      advancementCheckpoint: NotesRoadmapPhaseAdvancementCheckpoint | null;
    }
  | { status: "duplicate-id-conflict" | "operation-conflict" | "stale-revision"; revision: number }
  | { status: "invalid-checkpoint" | "completion-intent-missing"; message: string }
  | { status: "phase-not-found" | "phase-archived" | "stale-session" }
  | { status: "missing" }
  | ({ status: "corrupt" } & ProjectNotesCorruption);

export interface ProjectNotesExecutionPlanRequest {
  operationId: string;
  phaseId: string;
  expectedRevision: number;
  repository: NotesRepositoryIdentityV1;
  plan: NotesApprovedPlanV1;
  lastSession: NotesSessionLink | null;
}

export interface ProjectNotesExecutionImportRequest {
  operationId: string;
  phaseId: string;
  expectedRevision: number;
  execution: NotesPhaseExecutionV1;
}

export interface ProjectNotesExecutionReconciliationRequiredRequest {
  phaseId: string;
  expectedRevision: number;
  planHash: string;
  timestamp: string;
}

export interface ProjectNotesExecutionReconciliationRequest extends PhaseExecutionReconciliationRequestV3 {
  currentWorkspace: NotesWorkspaceSnapshotV1;
  currentSafeToolEnvironmentDigest: string;
  cleanAncestorStepIds: string[];
  reconciledAt: string;
}

type ProjectNotesExecutionReconciliationSuccess = Extract<
  PhaseExecutionReconciliationOutcome,
  { status: "reconciled" | "duplicate" }
>;

export type ProjectNotesExecutionReconciliationOutcome =
  | Exclude<PhaseExecutionReconciliationOutcome, ProjectNotesExecutionReconciliationSuccess>
  | (Omit<ProjectNotesExecutionReconciliationSuccess, "status"> & {
      status: "reconciled";
      snapshot: ProjectNotesSnapshot;
      phase: NotesPhase;
    })
  | (Omit<ProjectNotesExecutionReconciliationSuccess, "status"> & { status: "duplicate" });

export interface ProjectNotesExecutionStepRequest {
  phaseId: string;
  expectedRevision: number;
  planHash: string;
  stepId: string;
  completedAt: string;
  workspace: NotesWorkspaceSnapshotV1;
}

export interface ProjectNotesExecutionEvidenceRequest {
  phaseId: string;
  expectedRevision: number;
  planHash: string;
  evidence: NotesVerificationEvidence;
}

export interface ProjectNotesPendingCompletionRequest {
  phaseId: string;
  expectedRevision: number;
  pendingCompletion: NotesPendingCompletionV1;
}

export interface ProjectNotesClearPendingCompletionRequest {
  phaseId: string;
  expectedRevision: number;
  completionId: string;
  currentWorkspace: NotesWorkspaceSnapshotV1;
}

export interface ProjectNotesDurableSettlementRequest {
  phaseId: string;
  expectedRevision: number;
  completionId: string;
  planHash: string;
  workspace: NotesWorkspaceSnapshotV1;
}

export type ProjectNotesDurableSettlementOutcome =
  | ProjectNotesPhaseCompletionSettlementOutcome
  | {
      status: "operation-conflict" | "plan-mismatch" | "workspace-mismatch";
      revision: number;
    }
  | { status: "execution-missing" | "completion-intent-missing" };

export type ProjectNotesExecutionMutationOutcome =
  | { status: "committed"; snapshot: ProjectNotesSnapshot; phase: NotesPhase }
  | { status: "duplicate" | "operation-conflict" | "stale-revision"; revision: number }
  | {
      status:
        | "phase-not-found"
        | "phase-archived"
        | "execution-missing"
        | "plan-mismatch"
        | "step-not-found"
        | "step-order-invalid"
        | "workspace-mismatch"
        | "completion-intent-missing";
    }
  | { status: "missing" }
  | ({ status: "corrupt" } & ProjectNotesCorruption);

export type ProjectNotesRoadmapStatusOutcome =
  | {
      status: "committed";
      snapshot: ProjectNotesSnapshot;
      phase: NotesPhase;
      statusOutcome: NotesRoadmapStatusOutcome;
      proposals: ProjectNotesRoadmapProposalOutcome[];
    }
  | {
      status: "duplicate";
      revision: number;
      phaseId: string;
      phase: NotesPhase;
      statusOutcome: NotesRoadmapStatusOutcome;
      proposals: ProjectNotesRoadmapProposalOutcome[];
    }
  | { status: "verification-incomplete"; revision: number; message: string }
  | { status: "duplicate-id-conflict" | "operation-conflict"; revision: number }
  | { status: "stale-revision"; revision: number }
  | {
      status: "phase-not-found" | "phase-archived" | "phase-not-bound" | "stale-session";
    }
  | { status: "invalid-reference"; path: string; message: string }
  | { status: "missing" }
  | ({ status: "corrupt" } & ProjectNotesCorruption);

export interface ProjectNotesPaths {
  directory: string;
  primary: string;
  backup: string;
  lock: string;
}

export interface ProjectNotesFileHandle {
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface ProjectNotesFileSystem {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  chmod(path: string, mode: number): Promise<void>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(
    path: string,
    data: string,
    options: { encoding: "utf8"; mode: number; flag: "wx" },
  ): Promise<void>;
  open(path: string, flags: "r" | "r+"): Promise<ProjectNotesFileHandle>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface ProjectNotesRepositoryOptions {
  fileSystem?: ProjectNotesFileSystem;
  lock?: <T>(filePath: string, operation: () => Promise<T>) => Promise<T>;
  createId?: () => string;
}

type Candidate =
  | { status: "missing" }
  | { status: "invalid"; reason: ProjectNotesCorruptReason }
  | { status: "valid"; envelope: StoredProjectNotesV1; migratedFromV2: boolean };

type CurrentState =
  | { status: "missing" }
  | ({ status: "corrupt" } & ProjectNotesCorruption)
  | {
      status: "ok";
      envelope: StoredProjectNotesV1;
      source: "primary" | "backup";
      migratedFromV2: boolean;
    };

type UnavailableCurrentState = Exclude<CurrentState, { status: "ok" }>;

interface CommitDocumentOptions {
  validationMode: "trusted" | "validated";
  context: string;
}

export const NOTES_PHASE_LIFECYCLE_REASON_MAX_LENGTH = 240;

const STORE_DIRECTORY = "project-notes";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set([
  "EISDIR",
  "EINVAL",
  "ENOSYS",
  "ENOTSUP",
  "EPERM",
]);
const ENVELOPE_KEYS = ["storeVersion", "projectKey", "revision", "document"];

export function projectNotesHash(projectKey: string): string {
  return createHash("sha256").update(projectKey, "utf8").digest("hex");
}

export function projectNotesPaths(agentDir: string, cwd: string): ProjectNotesPaths {
  const projectKey = canonicalProjectKey(cwd);
  const directory = path.join(agentDir, STORE_DIRECTORY);
  const primary = path.join(directory, `${projectNotesHash(projectKey)}.json`);
  return {
    directory,
    primary,
    backup: path.join(directory, `${projectNotesHash(projectKey)}.backup.json`),
    lock: `${primary}.lock`,
  };
}

function coerceNotesDocumentV3(value: unknown): NotesValidationResult & {
  migratedLegacyShape?: boolean;
} {
  const current = validateNotesDocumentV3(value);
  if (current.ok) return { ...current, migratedLegacyShape: false };
  if (typeof value === "object" && value !== null && "version" in value && value.version === 2) {
    const migrated = migrateNotesDocumentV2(value);
    return { ...migrated, migratedLegacyShape: migrated.ok };
  }
  const migrated = migrateNotesDocumentV3PhaseShape(value);
  return migrated.ok ? { ...migrated, migratedLegacyShape: true } : migrated;
}

function validationError(path: string, message: string): NotesValidationError {
  return { path, message };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateSession(value: unknown, pathPrefix: string): NotesValidationError | null {
  if (value === null) return null;
  if (!isRecordWithKeys(value, ["sessionId", "sessionPath"])) {
    return validationError(pathPrefix, "expected sessionId and sessionPath or null");
  }
  if (!isNonEmptyString(value.sessionId)) {
    return validationError(`${pathPrefix}.sessionId`, "session ID is required");
  }
  if (value.sessionPath !== null && !isNonEmptyString(value.sessionPath)) {
    return validationError(`${pathPrefix}.sessionPath`, "expected a non-empty path or null");
  }
  return null;
}

function validateImmutableReferenceCapturedAt(
  previous: NotesDocumentV3,
  next: NotesDocumentV3,
): NotesValidationError | null {
  const previousById = new Map(previous.references.map((reference) => [reference.id, reference]));
  for (let index = 0; index < next.references.length; index += 1) {
    const nextReference = next.references[index]!;
    const previousReference = previousById.get(nextReference.id);
    if (previousReference && previousReference.capturedAt !== nextReference.capturedAt) {
      return validationError(
        `references[${index}].capturedAt`,
        "existing reference capture time cannot be changed",
      );
    }
  }
  return null;
}

function validateAppendOnlyLifecycleEvents(
  previous: NotesDocumentV3,
  next: NotesDocumentV3,
): NotesValidationError | null {
  const nextById = new Map(next.phases.map((phase, index) => [phase.id, { phase, index }]));
  for (const previousPhase of previous.phases) {
    const current = nextById.get(previousPhase.id);
    if (!current) {
      if (previousPhase.lifecycleEvents.length > 0) {
        return validationError(
          `phases.${previousPhase.id}.lifecycleEvents`,
          "cannot remove a phase with lifecycle history",
        );
      }
      continue;
    }
    if (current.phase.lifecycleEvents.length < previousPhase.lifecycleEvents.length) {
      return validationError(
        `phases[${current.index}].lifecycleEvents`,
        "lifecycle events are append-only",
      );
    }
    for (let index = 0; index < previousPhase.lifecycleEvents.length; index += 1) {
      if (
        !isDeepStrictEqual(
          current.phase.lifecycleEvents[index],
          previousPhase.lifecycleEvents[index],
        )
      ) {
        return validationError(
          `phases[${current.index}].lifecycleEvents[${index}]`,
          "existing lifecycle events cannot be changed",
        );
      }
    }
  }
  return null;
}

function validateAppendOnlyRoadmapEvents(
  previous: NotesDocumentV3,
  next: NotesDocumentV3,
): NotesValidationError | null {
  const nextById = new Map(next.phases.map((phase, index) => [phase.id, { phase, index }]));
  for (const previousPhase of previous.phases) {
    const current = nextById.get(previousPhase.id);
    if (!current) {
      if (previousPhase.roadmapEvents.length > 0) {
        return validationError(
          `phases.${previousPhase.id}.roadmapEvents`,
          "cannot remove a phase with roadmap history",
        );
      }
      continue;
    }
    if (current.phase.roadmapEvents.length < previousPhase.roadmapEvents.length) {
      return validationError(
        `phases[${current.index}].roadmapEvents`,
        "roadmap events are append-only",
      );
    }
    for (let index = 0; index < previousPhase.roadmapEvents.length; index += 1) {
      if (
        !isDeepStrictEqual(current.phase.roadmapEvents[index], previousPhase.roadmapEvents[index])
      ) {
        return validationError(
          `phases[${current.index}].roadmapEvents[${index}]`,
          "existing roadmap events and proposals cannot be changed",
        );
      }
    }
  }
  return null;
}

function validateGenericSaveEventSuffixes(
  previous: NotesDocumentV3,
  next: NotesDocumentV3,
): NotesValidationError | null {
  const previousById = new Map(previous.phases.map((phase) => [phase.id, phase]));
  for (let phaseIndex = 0; phaseIndex < next.phases.length; phaseIndex += 1) {
    const phase = next.phases[phaseIndex]!;
    const previousPhase = previousById.get(phase.id);
    const lifecyclePrefixLength = previousPhase?.lifecycleEvents.length ?? 0;
    for (
      let eventIndex = lifecyclePrefixLength;
      eventIndex < phase.lifecycleEvents.length;
      eventIndex += 1
    ) {
      const event = phase.lifecycleEvents[eventIndex]!;
      const pending = previousPhase?.pendingAutomaticLifecycleTransition;
      const appliesPendingReset =
        previousPhase !== undefined &&
        pending !== null &&
        pending !== undefined &&
        phase.pendingAutomaticLifecycleTransition === null &&
        previousPhase.overrides.status !== null &&
        phase.overrides.status === null &&
        previousPhase.status !== "done" &&
        notesSessionLinksEqual(previousPhase.session, pending.expectedSession) &&
        event.fromStatus === previousPhase.status &&
        event.toStatus === pending.status &&
        event.source === pending.source &&
        event.reason === pending.reason &&
        event.kind === pending.kind &&
        Date.parse(event.timestamp) >= Date.parse(pending.timestamp);
      if (event.source !== "user" && !appliesPendingReset) {
        return validationError(
          `phases[${phaseIndex}].lifecycleEvents[${eventIndex}].source`,
          "generic saves may only append user lifecycle events or apply a pending automatic transition",
        );
      }
    }

    const roadmapPrefixLength = previousPhase?.roadmapEvents.length ?? 0;
    for (
      let eventIndex = roadmapPrefixLength;
      eventIndex < phase.roadmapEvents.length;
      eventIndex += 1
    ) {
      const event = phase.roadmapEvents[eventIndex]!;
      if (event.type !== "reference-decision" && event.type !== "override-reset") {
        return validationError(
          `phases[${phaseIndex}].roadmapEvents[${eventIndex}].type`,
          "privileged roadmap events require their dedicated authority path",
        );
      }
    }
  }
  return null;
}

function validateGenericSaveCompletionAuthority(
  previous: NotesDocumentV3,
  next: NotesDocumentV3,
): NotesValidationError | null {
  const previousById = new Map(previous.phases.map((phase) => [phase.id, phase]));
  for (const [index, phase] of next.phases.entries()) {
    const prior = previousById.get(phase.id);
    const pathPrefix = `phases[${index}]`;
    if (phase.status === "done" && prior?.status !== "done") {
      return validationError(
        `${pathPrefix}.status`,
        "phase completion requires the dedicated completion authority path",
      );
    }
    if (prior && prior.status === "done" && phase.status !== "done") {
      return validationError(`${pathPrefix}.status`, "completed phase status is repository-owned");
    }
    if (prior && !isDeepStrictEqual(prior.completedAt, phase.completedAt)) {
      return validationError(
        `${pathPrefix}.completedAt`,
        "completion provenance is repository-owned",
      );
    }
    if (phase.overrides.status?.value === "done" && prior?.overrides.status?.value !== "done") {
      return validationError(
        `${pathPrefix}.overrides.status`,
        "phase completion overrides require the dedicated completion authority path",
      );
    }
  }
  return null;
}

function validateGenericSavePendingLifecycleAuthority(
  previous: NotesDocumentV3,
  next: NotesDocumentV3,
): NotesValidationError | null {
  const previousById = new Map(previous.phases.map((phase) => [phase.id, phase]));
  const nextById = new Map(next.phases.map((phase, index) => [phase.id, { phase, index }]));
  for (const [index, phase] of next.phases.entries()) {
    if (!previousById.has(phase.id) && phase.pendingAutomaticLifecycleTransition !== null) {
      return validationError(
        `phases[${index}].pendingAutomaticLifecycleTransition`,
        "pending automatic lifecycle state is repository-owned",
      );
    }
  }
  for (const previousPhase of previous.phases) {
    const current = nextById.get(previousPhase.id);
    if (!current) continue;
    const previousPending = previousPhase.pendingAutomaticLifecycleTransition;
    const nextPending = current.phase.pendingAutomaticLifecycleTransition;
    const pathPrefix = `phases[${current.index}].pendingAutomaticLifecycleTransition`;
    if (previousPending === null) {
      if (nextPending !== null) {
        return validationError(pathPrefix, "pending automatic lifecycle state is repository-owned");
      }
      continue;
    }
    if (isDeepStrictEqual(previousPending, nextPending)) continue;
    if (nextPending !== null) {
      return validationError(pathPrefix, "pending automatic lifecycle state is repository-owned");
    }
    const appendedRoadmapEvents = current.phase.roadmapEvents.slice(
      previousPhase.roadmapEvents.length,
    );
    const hasStatusReset = appendedRoadmapEvents.some(
      (event) => event.type === "override-reset" && event.field === "status",
    );
    if (
      previousPhase.overrides.status === null ||
      current.phase.overrides.status !== null ||
      !hasStatusReset
    ) {
      return validationError(pathPrefix, "can only be cleared by a status override reset");
    }
    const appliesPending =
      previousPhase.status !== "done" &&
      notesSessionLinksEqual(previousPhase.session, previousPending.expectedSession);
    if (!appliesPending) continue;
    if (current.phase.status !== previousPending.status) {
      return validationError(`${pathPrefix}.status`, "status reset must apply the pending target");
    }
    const appendedLifecycleEvents = current.phase.lifecycleEvents.slice(
      previousPhase.lifecycleEvents.length,
    );
    if (previousPhase.status === previousPending.status) {
      if (appendedLifecycleEvents.length !== 0) {
        return validationError(
          pathPrefix,
          "same-status reset cannot append a lifecycle transition",
        );
      }
      continue;
    }
    if (appendedLifecycleEvents.length !== 1) {
      return validationError(
        pathPrefix,
        "status reset must append one pending lifecycle transition",
      );
    }
    const event = appendedLifecycleEvents[0]!;
    if (
      event.fromStatus !== previousPhase.status ||
      event.toStatus !== previousPending.status ||
      event.source !== previousPending.source ||
      event.reason !== previousPending.reason ||
      event.kind !== previousPending.kind ||
      Date.parse(event.timestamp) < Date.parse(previousPending.timestamp)
    ) {
      return validationError(
        pathPrefix,
        "status reset lifecycle transition must match the pending provenance",
      );
    }
  }
  return null;
}

function validateGenericSaveReminderAuthority(
  previous: NotesDocumentV3,
  next: NotesDocumentV3,
): NotesValidationError | null {
  const previousById = new Map(previous.phases.map((phase) => [phase.id, phase]));
  for (let phaseIndex = 0; phaseIndex < next.phases.length; phaseIndex += 1) {
    const phase = next.phases[phaseIndex]!;
    const currentReminder = phase.reminder;
    if (currentReminder === null) continue;
    const previousReminder = previousById.get(phase.id)?.reminder ?? null;
    const pathPrefix = `phases[${phaseIndex}].reminder`;

    if (previousReminder === null) {
      if (currentReminder.lastDelivery !== null) {
        return validationError(
          `${pathPrefix}.lastDelivery`,
          "new reminders cannot supply delivery evidence",
        );
      }
      continue;
    }

    if (currentReminder.id !== previousReminder.id) {
      return validationError(`${pathPrefix}.id`, "existing reminder ID cannot be changed");
    }
    if (currentReminder.occurrenceKey === previousReminder.occurrenceKey) {
      if (!isDeepStrictEqual(currentReminder.lastDelivery, previousReminder.lastDelivery)) {
        return validationError(
          `${pathPrefix}.lastDelivery`,
          "delivery evidence is repository-owned",
        );
      }
      continue;
    }
    if (!isDeepStrictEqual(currentReminder.lastDelivery, previousReminder.lastDelivery)) {
      return validationError(
        `${pathPrefix}.lastDelivery`,
        "a new occurrence must preserve prior delivery evidence",
      );
    }
  }
  return null;
}

function chronologicalLifecycleTimestamp(phase: NotesPhase, requested: string): string {
  const requestedTime = Date.parse(requested);
  if (!Number.isFinite(requestedTime)) {
    throw new Error("Cannot record a phase lifecycle transition with an invalid timestamp.");
  }
  const previousTimes = [
    phase.lifecycleEvents.at(-1)?.timestamp,
    phase.pendingAutomaticLifecycleTransition?.timestamp,
  ]
    .filter((value): value is string => value !== undefined)
    .map(Date.parse);
  return new Date(Math.max(requestedTime, ...previousTimes)).toISOString();
}

function boundedLifecycleReason(reason: string): string {
  const normalized = reason.replace(/\s+/g, " ").trim();
  const fallback = "Phase lifecycle changed.";
  return (normalized || fallback).slice(0, NOTES_PHASE_LIFECYCLE_REASON_MAX_LENGTH).trimEnd();
}

function pendingAutomaticLifecycleTransition(
  phase: NotesPhase,
  transition: ProjectNotesPhaseLifecycleTransition,
  timestamp: string,
): NotesPhase["pendingAutomaticLifecycleTransition"] {
  const reason = boundedLifecycleReason(transition.reason);
  return {
    status: transition.status,
    source: transition.source,
    reason,
    kind:
      transition.kind ??
      classifyLegacyNotesLifecycleEvent({
        toStatus: transition.status,
        source: transition.source,
        reason,
      }),
    timestamp,
    expectedSession: structuredClone(
      transition.expectedSession === undefined ? phase.session : transition.expectedSession,
    ),
  };
}

function applyPhaseLifecycleTransition(
  phase: NotesPhase,
  transition: ProjectNotesPhaseLifecycleTransition,
  createId: () => string,
): "updated" | "same-status" | "manual-override" | "done-terminal" {
  if (phase.overrides.status !== null) return "manual-override";
  if (phase.status === "done") return "done-terminal";
  if (phase.status === transition.status) return "same-status";

  const reason = boundedLifecycleReason(transition.reason);
  const fromStatus = phase.status;
  phase.status = transition.status;
  phase.pendingAutomaticLifecycleTransition = null;
  phase.attentionReason = transition.status === "needs-attention" ? reason : null;
  phase.completedAt = transition.status === "cancelled" ? transition.timestamp : null;
  phase.updatedAt = transition.timestamp;
  phase.lifecycleEvents.push({
    id: createId(),
    fromStatus,
    toStatus: transition.status,
    source: transition.source,
    timestamp: transition.timestamp,
    reason,
    kind:
      transition.kind ??
      classifyLegacyNotesLifecycleEvent({
        toStatus: transition.status,
        source: transition.source,
        reason,
      }),
  });
  return "updated";
}

function roadmapStatusOutcome(
  outcome: "updated" | "same-status" | "manual-override" | "done-terminal",
): NotesRoadmapStatusOutcome {
  return outcome === "updated" ? "applied" : outcome;
}

function chronologicalRoadmapTimestamp(phase: NotesPhase, requested: string): string {
  const requestedTime = Date.parse(requested);
  if (!Number.isFinite(requestedTime)) throw new Error("Invalid roadmap status timestamp.");
  const priorTimes = [
    phase.lifecycleEvents.at(-1)?.timestamp,
    phase.roadmapEvents.at(-1)?.timestamp,
    phase.updatedAt,
  ]
    .filter((value): value is string => value !== undefined)
    .map(Date.parse)
    .filter(Number.isFinite);
  return new Date(Math.max(requestedTime, ...priorTimes)).toISOString();
}

function normalizeRoadmapProposedReference(
  proposed: Omit<NotesReference, "id" | "capturedAt">,
): Omit<NotesReference, "id" | "capturedAt"> {
  const canonicalUrl = normalizeCanonicalUrl(proposed.canonicalUrl);
  return {
    ...proposed,
    provider: proposed.provider.trim().toLowerCase(),
    canonicalUrl: canonicalUrl ?? proposed.canonicalUrl.trim(),
    owner: proposed.owner.trim(),
    repo: proposed.repo.trim(),
  };
}

function roadmapProposalOutcome(
  proposal: NotesRoadmapReferenceProposal,
): ProjectNotesRoadmapProposalOutcome {
  return {
    proposalId: proposal.id,
    outcome: proposal.disposition,
    policyOutcome: proposal.policyOutcome,
    referenceId: proposal.referenceId,
  };
}

function validateRoadmapProposedReferences(
  references: Array<Omit<NotesReference, "id" | "capturedAt">>,
  timestamp: string,
): { path: string; message: string } | null {
  for (let index = 0; index < references.length; index += 1) {
    const validation = validateNotesDocumentV3({
      version: 3,
      reference: "",
      currentFocus: "",
      tasks: [],
      handoff: { text: "", updatedAt: null, readAt: null },
      updatedAt: timestamp,
      legacyImportedAt: null,
      phases: [],
      references: [{ ...references[index]!, id: `proposal-${index + 1}`, capturedAt: timestamp }],
    });
    if (!validation.ok) {
      return {
        path: validation.error.path.replace("references[0]", `proposed_references[${index}]`),
        message: validation.error.message,
      };
    }
  }
  return null;
}

function appendRoadmapStatusEvent(
  document: NotesDocumentV3,
  phaseIndex: number,
  request: ProjectNotesRoadmapStatusRequest,
  normalizedReferences: Array<Omit<NotesReference, "id" | "capturedAt">>,
  timestamp: string,
  statusOutcome: NotesRoadmapStatusOutcome,
  createId: () => string,
): NotesRoadmapReferenceProposal[] {
  const phase = document.phases[phaseIndex]!;
  const proposals: NotesRoadmapReferenceProposal[] = [];
  for (const proposed of normalizedReferences) {
    let disposition: NotesRoadmapReferenceProposal["disposition"] = "pending";
    let policyOutcome: NotesRoadmapReferencePolicyOutcome = request.autopilotEnabled
      ? "reference-override-protected"
      : "manual-review";
    let referenceId: string | null = null;
    if (request.autopilotEnabled && phase.overrides.referenceIds === null) {
      const identity = canonicalReferenceIdentity(proposed)!;
      const existing = document.references.find(
        (reference) => canonicalReferenceIdentity(reference) === identity,
      );
      if (existing) {
        referenceId = existing.id;
        disposition = "reused";
        policyOutcome = "reused";
      } else {
        referenceId = createId();
        document.references.push({ ...proposed, id: referenceId, capturedAt: timestamp });
        disposition = "accepted";
        policyOutcome = "accepted";
      }
      if (!phase.referenceIds.includes(referenceId)) phase.referenceIds.push(referenceId);
    }
    proposals.push({
      ...proposed,
      id: createId(),
      disposition,
      policyOutcome,
      referenceId,
    });
  }

  phase.roadmapEvents.push({
    type: "status-update",
    id: request.updateId,
    actor: request.actor,
    transition: request.transition,
    progress: request.progress,
    blocker: request.blocker,
    requiredExternalAction: request.requiredExternalAction,
    evidence: [...request.evidence],
    verification: request.verification,
    verificationReason: request.verificationReason,
    verificationSession:
      request.verification === null || phase.session === null ? null : { ...phase.session },
    statusOutcome,
    proposedReferences: proposals,
    timestamp,
  });
  phase.updatedAt = timestamp;
  document.updatedAt = timestamp;
  return proposals;
}

function sameImplementationCheckpointPayload(
  event: NotesRoadmapImplementationCheckpoint,
  request: ProjectNotesImplementationCheckpointRequest,
): boolean {
  return isDeepStrictEqual(
    {
      session: event.session,
      planStepTotal: event.planStepTotal,
      completedPlanSteps: event.completedPlanSteps,
      runOutcome: event.runOutcome,
    },
    {
      session: request.expectedSession,
      planStepTotal: request.planStepTotal,
      completedPlanSteps: request.completedPlanSteps,
      runOutcome: request.runOutcome,
    },
  );
}

function sameCompletionSettlementPayload(
  event: NotesRoadmapImplementationCheckpoint,
  request: ProjectNotesPhaseCompletionSettlementRequest,
): boolean {
  return (
    sameImplementationCheckpointPayload(event, request) &&
    event.verificationStatusUpdateId === request.completionIntentId
  );
}

function validateImplementationCheckpointRequest(
  request: ProjectNotesImplementationCheckpointRequest,
): string | null {
  if (!isNonEmptyString(request.checkpointId)) return "Checkpoint ID is required.";
  if (!isTimestamp(request.timestamp)) return "Checkpoint timestamp is invalid.";
  const issue = validateNotesImplementationCheckpointFields(request);
  if (issue?.code === "not-positive-integer") return "Plan step total must be positive.";
  if (issue?.code === "unknown-run-outcome") return "Run outcome is invalid.";
  if (issue?.code === "not-array") return "Completed plan steps must be an array.";
  if (issue?.code === "invalid-step") {
    return "Completed plan steps must be unique, ascending, and within the plan total.";
  }
  return validateSession(request.expectedSession, "expectedSession")?.message ?? null;
}

function applyCompletionEvaluation(
  phase: NotesPhase,
  evaluation: PhaseCompletionEvaluation,
  timestamp: string,
  createId: () => string,
): void {
  if (evaluation.targetStatus === null) return;
  const reason = boundedLifecycleReason(evaluation.reason);
  if (phase.status === evaluation.targetStatus) {
    if (evaluation.targetStatus === "needs-attention") phase.attentionReason = reason;
    return;
  }
  const fromStatus = phase.status;
  phase.status = evaluation.targetStatus;
  phase.attentionReason = evaluation.targetStatus === "needs-attention" ? reason : null;
  phase.completedAt = evaluation.targetStatus === "done" ? timestamp : null;
  phase.lifecycleEvents.push({
    id: createId(),
    fromStatus,
    toStatus: evaluation.targetStatus,
    source: "system",
    timestamp,
    reason,
    kind:
      evaluation.targetStatus === "waiting-for-approval"
        ? "approval-opened"
        : evaluation.targetStatus === "needs-attention"
          ? "attention-generic-opened"
          : "other",
  });
}

function orderedRoadmapPhaseIndexes(document: NotesDocumentV3): number[] {
  return document.phases
    .map((phase, documentIndex) => ({ phase, documentIndex }))
    .sort(
      (left, right) =>
        left.phase.order - right.phase.order || left.documentIndex - right.documentIndex,
    )
    .map(({ documentIndex }) => documentIndex);
}

function latestCompletionReview(phase: NotesPhase): NotesRoadmapCompletionReview | undefined {
  return [...phase.roadmapEvents]
    .reverse()
    .find((event): event is NotesRoadmapCompletionReview => event.type === "completion-review");
}

function isAdvancementCheckpointConfirmed(phase: NotesPhase, checkpointId: string): boolean {
  return phase.roadmapEvents.some(
    (event) =>
      event.type === "phase-advancement-confirmation" && event.checkpointId === checkpointId,
  );
}

interface PendingAdvancementAuthority {
  source: NotesPhase;
  checkpoint: NotesRoadmapPhaseAdvancementCheckpoint;
}

function pendingAdvancementAuthorities(document: NotesDocumentV3): PendingAdvancementAuthority[] {
  const authorities: PendingAdvancementAuthority[] = [];
  for (const source of document.phases) {
    for (const event of source.roadmapEvents) {
      if (
        event.type === "phase-advancement-checkpoint" &&
        !isAdvancementCheckpointConfirmed(source, event.id)
      ) {
        authorities.push({ source, checkpoint: event });
      }
    }
  }
  return authorities;
}

function pendingAdvancementCheckpointForSuccessor(
  document: NotesDocumentV3,
  phaseId: string,
): NotesRoadmapPhaseAdvancementCheckpoint | null {
  const orderedIndexes = orderedRoadmapPhaseIndexes(document);
  const candidateOrderIndex = orderedIndexes.findIndex(
    (documentIndex) => document.phases[documentIndex]!.id === phaseId,
  );
  if (candidateOrderIndex < 0) return null;
  for (const authority of pendingAdvancementAuthorities(document)) {
    const sourceOrderIndex = orderedIndexes.findIndex(
      (documentIndex) => document.phases[documentIndex]!.id === authority.source.id,
    );
    if (sourceOrderIndex >= 0 && candidateOrderIndex > sourceOrderIndex) {
      return authority.checkpoint;
    }
  }
  return null;
}

function isCompletionCheckpointAuthoritative(
  source: NotesPhase,
  checkpoint: NotesRoadmapPhaseAdvancementCheckpoint,
): boolean {
  if (source.archivedAt !== null || source.status !== "done" || source.overrides.status !== null) {
    return false;
  }
  if ("completionReviewId" in checkpoint) {
    const review = latestCompletionReview(source);
    return (
      review?.id === checkpoint.completionReviewId &&
      review.reviewer === checkpoint.reviewer &&
      review.decision === "accepted" &&
      review.gateOutcome === "done"
    );
  }
  return isNotesDirectCompletionAuthority(source, checkpoint);
}

function selectNextEligibleRoadmapPhaseIndexForCheckpoint(
  document: NotesDocumentV3,
  checkpoint: NotesRoadmapPhaseAdvancementCheckpoint,
): number | null {
  const source = document.phases.find((phase) => phase.id === checkpoint.completedPhaseId);
  if (!source || !isCompletionCheckpointAuthoritative(source, checkpoint)) return null;
  const eligibility = classifyRoadmapAutoStartEligibility(
    document.phases,
    checkpoint.completedPhaseId,
  );
  return eligibility.kind === "unique"
    ? document.phases.findIndex((phase) => phase.id === eligibility.phase.id)
    : null;
}

function selectedAdvancementTargetId(
  document: NotesDocumentV3,
  authority: PendingAdvancementAuthority,
): string | null {
  const targetIndex = selectNextEligibleRoadmapPhaseIndexForCheckpoint(
    document,
    authority.checkpoint,
  );
  return targetIndex === null ? null : document.phases[targetIndex]!.id;
}

function validateGenericSaveAdvancementAuthority(
  previous: NotesDocumentV3,
  next: NotesDocumentV3,
): NotesValidationError | null {
  for (const authority of pendingAdvancementAuthorities(previous)) {
    const previousTargetId = selectedAdvancementTargetId(previous, authority);
    const nextSource = next.phases.find((phase) => phase.id === authority.source.id);
    if (!nextSource) continue;
    const nextAuthority = { source: nextSource, checkpoint: authority.checkpoint };
    const nextTargetId = selectedAdvancementTargetId(next, nextAuthority);
    const expectedTargetId = authority.checkpoint.nextPhaseId;
    const preservesCurrentTarget = nextTargetId === previousTargetId;
    const recoversCheckpointTarget = nextTargetId === expectedTargetId;
    if (!preservesCurrentTarget && !recoversCheckpointTarget) {
      return validationError(
        "phases",
        `Roadmap topology is protected by pending advancement checkpoint ${authority.checkpoint.id}; keep ${expectedTargetId} as the first eligible successor or restore it before changing the target`,
      );
    }
  }
  return null;
}

function phaseLaunchContext(
  document: NotesDocumentV3,
  phase: NotesPhase,
): { references: NotesReference[] } {
  const referencesById = new Map(document.references.map((reference) => [reference.id, reference]));
  return { references: phase.referenceIds.map((id) => referencesById.get(id)!) };
}

function sameRoadmapStatusPayload(
  event: NotesRoadmapStatusUpdate,
  request: ProjectNotesRoadmapStatusRequest,
): boolean {
  const storedReferences = event.proposedReferences.map(
    ({
      id: _id,
      disposition: _disposition,
      policyOutcome: _policyOutcome,
      referenceId: _referenceId,
      ...reference
    }) => reference,
  );
  return isDeepStrictEqual(
    {
      actor: event.actor,
      transition: event.transition,
      progress: event.progress,
      blocker: event.blocker,
      requiredExternalAction: event.requiredExternalAction,
      evidence: event.evidence,
      verification: event.verification,
      verificationReason: event.verificationReason,
      proposedReferences: storedReferences,
    },
    {
      actor: request.actor,
      transition: request.transition,
      progress: request.progress,
      blocker: request.blocker,
      requiredExternalAction: request.requiredExternalAction,
      evidence: request.evidence,
      verification: request.verification,
      verificationReason: request.verificationReason,
      proposedReferences: request.proposedReferences,
    },
  );
}

function sameDurableCompletionPayload(
  pending: NotesPendingCompletionV1 | null | undefined,
  phase: NotesPhase,
  request: ProjectNotesRoadmapStatusRequest,
): boolean {
  if (!request.durableCompletion) return true;
  const evidence = phase.execution?.evidence;
  const requestedEvidence = request.durableCompletion.verificationEvidence;
  const expectedCriterionIds = phase.doneWhen.map((criterion, index) =>
    roadmapCriterionId(index + 1, criterion),
  );
  if (
    !pending ||
    pending.completionId !== request.updateId ||
    !evidence ||
    requestedEvidence.length !== expectedCriterionIds.length ||
    requestedEvidence.some((record) => !expectedCriterionIds.includes(record.criterionId))
  ) {
    return false;
  }
  const { completionId: _completionId, statusRevision: _statusRevision, ...stored } = pending;
  const { verificationEvidence, ...requestedPending } = request.durableCompletion;
  return (
    isDeepStrictEqual(stored, requestedPending) &&
    verificationEvidence.every((record) =>
      evidence.some(
        (storedRecord) =>
          "version" in storedRecord &&
          storedRecord.version === 2 &&
          storedRecord.executionId === record.executionId &&
          isDeepStrictEqual(storedRecord, record),
      ),
    )
  );
}

function validateAtomicCompletionEvidence(
  phase: NotesPhase,
  request: NonNullable<ProjectNotesRoadmapStatusRequest["durableCompletion"]>,
): "operation-conflict" | string | null {
  const execution = phase.execution;
  if (!execution || request.verificationEvidence.length !== phase.doneWhen.length) {
    return "Durable completion requires exactly one execution-backed record per criterion.";
  }
  const expectedCriterionIds = phase.doneWhen.map((criterion, index) =>
    roadmapCriterionId(index + 1, criterion),
  );
  const records = request.verificationEvidence;
  if (
    new Set(records.map((record) => record.executionId)).size !== records.length ||
    new Set(records.map((record) => record.criterionId)).size !== records.length ||
    records.some((record) => !expectedCriterionIds.includes(record.criterionId))
  ) {
    return "Durable completion bindings must uniquely cover every current criterion.";
  }
  for (const record of records) {
    if (
      !workspaceSnapshotsEqual(record.workspace, request.workspace) ||
      record.safeToolEnvironmentDigest !== request.safeToolEnvironmentDigest
    ) {
      return "Durable verification evidence is stale for the current executable inputs.";
    }
    const existing = execution.evidence.find(
      (candidate) =>
        "version" in candidate &&
        candidate.version === 2 &&
        candidate.executionId === record.executionId,
    );
    if (existing && !isDeepStrictEqual(existing, record)) return "operation-conflict";
  }
  const merged = [
    ...execution.evidence,
    ...records.filter(
      (record) =>
        !execution.evidence.some(
          (candidate) =>
            "version" in candidate &&
            candidate.version === 2 &&
            candidate.executionId === record.executionId,
        ),
    ),
  ];
  return validateNotesPhaseExecution({ ...execution, evidence: merged })?.message ?? null;
}

function reconciliationSummary(phase: NotesPhase): {
  preservedStepIds: string[];
  revalidationStepIds: string[];
  revalidationEvidenceCount: number;
  reconciledAt: string;
} {
  const execution = phase.execution!;
  return {
    preservedStepIds: execution
      .plan!.steps.filter((step) => step.state === "completed")
      .map((step) => step.id),
    revalidationStepIds: execution
      .plan!.steps.filter((step) => step.state === "needs-revalidation")
      .map((step) => step.id),
    revalidationEvidenceCount: execution.evidence.filter(
      (evidence) => evidence.state === "needs-revalidation",
    ).length,
    reconciledAt: execution.migration.reconciledAt ?? phase.updatedAt,
  };
}

function reconciliationDuplicateOutcome(
  phase: NotesPhase,
  revision: number,
): Omit<ProjectNotesExecutionReconciliationSuccess, "status"> & { status: "duplicate" } {
  return {
    status: "duplicate",
    revision,
    phaseId: phase.id,
    ...reconciliationSummary(phase),
  };
}
export class ProjectNotesRepository {
  private readonly fileSystem: ProjectNotesFileSystem;
  private readonly lock: <T>(filePath: string, operation: () => Promise<T>) => Promise<T>;
  private readonly createId: () => string;

  constructor(
    private readonly agentDir: string,
    options: ProjectNotesRepositoryOptions = {},
  ) {
    this.fileSystem = options.fileSystem ?? fs;
    this.lock = options.lock ?? withFileLock;
    this.createId = options.createId ?? randomUUID;
  }

  paths(cwd: string): ProjectNotesPaths {
    return projectNotesPaths(this.agentDir, cwd);
  }

  async load(cwd: string): Promise<ProjectNotesLoadOutcome> {
    const projectKey = canonicalProjectKey(cwd);
    const paths = this.paths(cwd);
    const initial = await this.readCurrent(paths, projectKey);
    if (initial.status === "missing" || initial.status === "corrupt") return initial;
    if (initial.source === "primary" && !initial.migratedFromV2) {
      return { status: "ok", snapshot: toSnapshot(initial.envelope), recoveredFromBackup: false };
    }

    await this.ensureDirectory(paths.directory);
    return this.lock(paths.primary, async () => {
      const current = await this.readCurrent(paths, projectKey);
      if (current.status === "missing" || current.status === "corrupt") return current;
      const recoveredFromBackup = current.source === "backup";
      if (current.source === "primary" && !current.migratedFromV2) {
        return { status: "ok", snapshot: toSnapshot(current.envelope), recoveredFromBackup: false };
      }
      const serialized = serializeEnvelope(current.envelope);
      if (current.migratedFromV2) await this.atomicWrite(paths.backup, serialized);
      await this.atomicWrite(paths.primary, serialized);
      return { status: "ok", snapshot: toSnapshot(current.envelope), recoveredFromBackup };
    });
  }

  async migrate(cwd: string, document: unknown): Promise<ProjectNotesMigrationOutcome> {
    const validated = coerceNotesDocumentV3(document);
    if (!validated.ok) return { status: "invalid", error: validated.error };
    const projectKey = canonicalProjectKey(cwd);
    const paths = this.paths(cwd);
    await this.ensureDirectory(paths.directory);

    return this.lock(paths.primary, async () => {
      const current = await this.readCurrent(paths, projectKey);
      if (current.status === "corrupt") return current;
      if (current.status === "ok") {
        if (current.source === "backup" || current.migratedFromV2) {
          const serialized = serializeEnvelope(current.envelope);
          if (current.migratedFromV2) await this.atomicWrite(paths.backup, serialized);
          await this.atomicWrite(paths.primary, serialized);
        }
        return { status: "ok", snapshot: toSnapshot(current.envelope), migrated: false };
      }

      const envelope: StoredProjectNotesV1 = {
        storeVersion: 1,
        projectKey,
        revision: 1,
        document: validated.document,
      };
      const serialized = serializeEnvelope(envelope);
      await this.atomicWrite(paths.backup, serialized);
      await this.atomicWrite(paths.primary, serialized);
      return { status: "ok", snapshot: toSnapshot(envelope), migrated: true };
    });
  }

  async save(
    cwd: string,
    expectedRevision: number,
    document: unknown,
  ): Promise<ProjectNotesSaveOutcome> {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      return {
        status: "invalid",
        error: validationError("expectedRevision", "expected a non-negative integer"),
      };
    }
    const validated = coerceNotesDocumentV3(document);
    if (!validated.ok) return { status: "invalid", error: validated.error };
    const projectKey = canonicalProjectKey(cwd);
    const paths = this.paths(cwd);
    await this.ensureDirectory(paths.directory);

    return this.lock(paths.primary, async () => {
      const current = await this.readCurrent(paths, projectKey);
      if (current.status === "missing" || current.status === "corrupt") return current;
      if (current.envelope.revision !== expectedRevision) {
        return { status: "conflict", snapshot: toSnapshot(current.envelope) };
      }
      const capturedAtError = validateImmutableReferenceCapturedAt(
        current.envelope.document,
        validated.document,
      );
      if (capturedAtError) return { status: "invalid", error: capturedAtError };
      const appendOnlyError = validateAppendOnlyLifecycleEvents(
        current.envelope.document,
        validated.document,
      );
      if (appendOnlyError) return { status: "invalid", error: appendOnlyError };
      const roadmapAppendOnlyError = validateAppendOnlyRoadmapEvents(
        current.envelope.document,
        validated.document,
      );
      if (roadmapAppendOnlyError) return { status: "invalid", error: roadmapAppendOnlyError };
      const eventAuthorityError = validateGenericSaveEventSuffixes(
        current.envelope.document,
        validated.document,
      );
      if (eventAuthorityError) return { status: "invalid", error: eventAuthorityError };
      const completionAuthorityError = validateGenericSaveCompletionAuthority(
        current.envelope.document,
        validated.document,
      );
      if (completionAuthorityError) {
        return { status: "invalid", error: completionAuthorityError };
      }
      const pendingLifecycleAuthorityError = validateGenericSavePendingLifecycleAuthority(
        current.envelope.document,
        validated.document,
      );
      if (pendingLifecycleAuthorityError) {
        return { status: "invalid", error: pendingLifecycleAuthorityError };
      }
      const reminderAuthorityError = validateGenericSaveReminderAuthority(
        current.envelope.document,
        validated.document,
      );
      if (reminderAuthorityError) return { status: "invalid", error: reminderAuthorityError };
      const advancementAuthorityError = validateGenericSaveAdvancementAuthority(
        current.envelope.document,
        validated.document,
      );
      if (advancementAuthorityError) {
        return { status: "invalid", error: advancementAuthorityError };
      }

      const next: StoredProjectNotesV1 = {
        storeVersion: 1,
        projectKey,
        revision: expectedRevision + 1,
        document: validated.document,
      };
      await this.atomicWrite(paths.backup, serializeEnvelope(current.envelope));
      await this.atomicWrite(paths.primary, serializeEnvelope(next));
      return { status: "ok", snapshot: toSnapshot(next) };
    });
  }

  async createApprovedPhases(
    cwd: string,
    request: RoadmapPhaseDraft,
  ): Promise<RoadmapPhaseDraftApprovalResult> {
    const validated = validateRoadmapPhaseDraft(request);
    if (!validated.ok) {
      return {
        status: "invalid-proposal",
        message: `${validated.error.path}: ${validated.error.message}`,
      };
    }
    const draft = validated.value;
    const projectKey = canonicalProjectKey(cwd);
    if (canonicalProjectKey(draft.projectKey) !== projectKey) {
      return { status: "proposal-project-mismatch" };
    }

    const outcome = await this.withLockedCurrent<
      | Extract<RoadmapPhaseDraftApprovalResult, { status: "created" }>
      | Extract<RoadmapPhaseDraftApprovalResult, { status: "stale-revision" }>
      | Extract<RoadmapPhaseDraftApprovalResult, { status: "invalid-proposal" }>
    >(cwd, async (paths, current) => {
      if (current.revision !== draft.basedOnRevision) {
        return {
          status: "stale-revision",
          expectedRevision: draft.basedOnRevision,
          currentRevision: current.revision,
        };
      }

      const timestamp = new Date().toISOString();
      const document = structuredClone(current.document);
      const currentReferencesById = new Map(
        document.references.map((reference) => [reference.id, reference] as const),
      );
      const currentReferenceIdsByIdentity = new Map(
        document.references.map(
          (reference) => [canonicalReferenceIdentity(reference)!, reference.id] as const,
        ),
      );
      const resolvedReferenceIds = new Map<string, string>();
      const newReferences: NotesReference[] = [];
      for (const reference of draft.references) {
        const identity = canonicalReferenceIdentity(reference)!;
        const collidingReference = currentReferencesById.get(reference.id);
        if (collidingReference && canonicalReferenceIdentity(collidingReference) !== identity) {
          return {
            status: "invalid-proposal",
            message: `references: generated reference ID collides with existing source: ${reference.id}`,
          };
        }
        const existingReferenceId = currentReferenceIdsByIdentity.get(identity);
        if (existingReferenceId) {
          resolvedReferenceIds.set(reference.id, existingReferenceId);
          continue;
        }
        const createdReference: NotesReference = {
          ...reference,
          range: reference.range ? { ...reference.range } : null,
          capturedAt: timestamp,
        };
        newReferences.push(createdReference);
        currentReferencesById.set(createdReference.id, createdReference);
        currentReferenceIdsByIdentity.set(identity, createdReference.id);
        resolvedReferenceIds.set(reference.id, createdReference.id);
      }

      const firstOrder =
        document.phases.reduce((maximum, phase) => Math.max(maximum, phase.order), -1) + 1;
      const phases: NotesPhase[] = draft.phases.map((phase, index) => ({
        id: phase.phaseId,
        title: phase.title,
        goal: phase.goal,
        doneWhen: [...phase.doneWhen],
        order: firstOrder + index,
        status: "not-started",
        sourcePrompt: phase.sourcePrompt,
        referenceIds: phase.referenceIds.map(
          (referenceId) => resolvedReferenceIds.get(referenceId)!,
        ),
        session: null,
        reminder: null,
        attentionReason: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: null,
        archivedAt: null,
        overrides: { status: null, referenceIds: null },
        pendingAutomaticLifecycleTransition: null,
        lifecycleEvents: [],
        roadmapEvents: [],
      }));
      document.references.push(...newReferences);
      document.phases.push(...phases);
      document.updatedAt = timestamp;

      const notesValidation = validateNotesDocumentV3(document);
      if (!notesValidation.ok) {
        return {
          status: "invalid-proposal",
          message: `${notesValidation.error.path}: ${notesValidation.error.message}`,
        };
      }
      const next = await this.commitDocument(paths, current, notesValidation.document, {
        validationMode: "trusted",
        context: "Approved phase creation commit",
      });
      return {
        status: "created",
        revision: next.revision,
        phaseIds: phases.map((phase) => phase.id),
      };
    });

    if (outcome.status === "missing") return { status: "notes-missing" };
    if (outcome.status === "corrupt") return { status: "notes-corrupt" };
    return outcome;
  }

  async recordReminderDelivery(
    cwd: string,
    request: ProjectNotesReminderDeliveryRequest,
  ): Promise<ProjectNotesReminderDeliveryOutcome> {
    if (!isNonEmptyString(request.phaseId)) {
      return {
        status: "invalid",
        error: validationError("phaseId", "phase ID is required"),
      };
    }
    if (!isNonEmptyString(request.occurrenceKey)) {
      return {
        status: "invalid",
        error: validationError("occurrenceKey", "occurrence key is required"),
      };
    }
    if (!isTimestamp(request.attemptedAt)) {
      return {
        status: "invalid",
        error: validationError("attemptedAt", "expected an ISO timestamp"),
      };
    }
    if (!isNotesReminderDeliveryChannel(request.channel)) {
      return {
        status: "invalid",
        error: validationError("channel", "unknown delivery channel"),
      };
    }
    if (!isNotesReminderPermission(request.permission)) {
      return {
        status: "invalid",
        error: validationError("permission", "unknown notification permission"),
      };
    }
    if (!isValidNotesReminderDeliveryPair(request.channel, request.permission)) {
      return {
        status: "invalid",
        error: validationError("permission", "permission does not match delivery channel"),
      };
    }

    return this.withLockedCurrent(cwd, async (paths, current) => {
      const phaseIndex = current.document.phases.findIndex((phase) => phase.id === request.phaseId);
      if (phaseIndex < 0) return { status: "phase-not-found" };
      const currentPhase = current.document.phases[phaseIndex]!;
      if (currentPhase.archivedAt !== null) return { status: "phase-archived" };
      if (currentPhase.status === "done" || currentPhase.status === "cancelled") {
        return { status: "phase-inactive" };
      }
      const currentReminder = currentPhase.reminder;
      if (currentReminder === null) return { status: "reminder-not-found" };
      if (currentReminder.occurrenceKey !== request.occurrenceKey) {
        return { status: "stale-occurrence" };
      }
      if (currentReminder.lastDelivery?.occurrenceKey === request.occurrenceKey) {
        return { status: "already-delivered" };
      }
      if (Date.parse(currentReminder.dueAt) > Date.parse(request.attemptedAt)) {
        return { status: "not-due" };
      }

      const document = structuredClone(current.document);
      const phase = document.phases[phaseIndex]!;
      phase.reminder!.lastDelivery = {
        occurrenceKey: request.occurrenceKey,
        attemptedAt: request.attemptedAt,
        channel: request.channel,
        permission: request.permission,
      };
      const next = await this.commitDocument(paths, current, document, {
        validationMode: "validated",
        context: "Reminder delivery created invalid Notes",
      });
      return {
        status: "ok",
        snapshot: toSnapshot(next),
        phase: structuredClone(phase),
      };
    });
  }

  async resolveRoadmapBlocker(
    cwd: string,
    request: ProjectNotesRoadmapBlockerResolutionRequest,
  ): Promise<ProjectNotesRoadmapBlockerResolutionOutcome> {
    return this.withLockedCurrent(cwd, async (paths, current) => {
      const revision = current.revision;
      const phaseIndex = current.document.phases.findIndex((phase) => phase.id === request.phaseId);
      if (phaseIndex < 0) return { status: "phase-not-found" };
      const currentPhase = current.document.phases[phaseIndex]!;
      const priorById = currentPhase.roadmapEvents.find(
        (event) => event.id === request.resolutionId,
      );
      if (priorById) {
        if (
          priorById.type === "blocker-resolution" &&
          priorById.blockerUpdateId === request.blockerUpdateId &&
          priorById.resolver === request.resolver
        ) {
          return { status: "duplicate", revision, phaseId: request.phaseId };
        }
        return { status: "duplicate-id-conflict", revision };
      }
      if (
        currentPhase.roadmapEvents.some(
          (event) =>
            event.type === "blocker-resolution" &&
            event.blockerUpdateId === request.blockerUpdateId,
        )
      ) {
        return { status: "already-resolved", revision, phaseId: request.phaseId };
      }
      if (request.expectedRevision !== revision) {
        return { status: "stale-revision", revision };
      }
      if (currentPhase.archivedAt !== null) return { status: "phase-archived" };
      if (!notesSessionLinksEqual(currentPhase.session, request.expectedSession)) {
        return { status: "stale-session" };
      }
      const blocker = currentPhase.roadmapEvents.find(
        (event): event is NotesRoadmapStatusUpdate =>
          event.type === "status-update" &&
          event.id === request.blockerUpdateId &&
          event.transition === "blocked",
      );
      if (!blocker) return { status: "blocker-not-found" };

      const document = structuredClone(current.document);
      const phase = document.phases[phaseIndex]!;
      const timestamp = chronologicalRoadmapTimestamp(phase, request.timestamp);
      const resolution: NotesRoadmapBlockerResolution = {
        type: "blocker-resolution",
        id: request.resolutionId,
        blockerUpdateId: request.blockerUpdateId,
        resolver: request.resolver,
        timestamp,
      };
      phase.roadmapEvents.push(resolution);
      phase.updatedAt = timestamp;
      document.updatedAt = timestamp;
      const next = await this.commitDocument(paths, current, document, {
        validationMode: "validated",
        context: "Blocker resolution created invalid Notes",
      });
      return {
        status: "committed",
        snapshot: toSnapshot(next),
        phase: structuredClone(phase),
      };
    });
  }

  async approvePhaseExecutionPlan(
    cwd: string,
    request: ProjectNotesExecutionPlanRequest,
  ): Promise<ProjectNotesExecutionMutationOutcome> {
    return this.withLockedCurrent(cwd, async (paths, current) => {
      const revision = current.revision;
      const phaseIndex = current.document.phases.findIndex((phase) => phase.id === request.phaseId);
      if (phaseIndex < 0) return { status: "phase-not-found" };
      const currentPhase = current.document.phases[phaseIndex]!;
      if (currentPhase.execution) {
        return isDeepStrictEqual(currentPhase.execution.repository, request.repository) &&
          isDeepStrictEqual(currentPhase.execution.plan, request.plan)
          ? { status: "duplicate", revision }
          : { status: "operation-conflict", revision };
      }
      if (request.expectedRevision !== revision) return { status: "stale-revision", revision };
      if (currentPhase.archivedAt !== null) return { status: "phase-archived" };
      const document = structuredClone(current.document);
      const phase = document.phases[phaseIndex]!;
      phase.execution = {
        version: 1,
        state: "implementing",
        repository: structuredClone(request.repository),
        plan: structuredClone(request.plan),
        evidence: [],
        pendingCompletion: null,
        lastSession: request.lastSession ? { ...request.lastSession } : null,
        migration: { source: "native", reconciledAt: request.plan.approvedAt },
      };
      const timestamp = chronologicalRoadmapTimestamp(phase, request.plan.approvedAt);
      phase.updatedAt = timestamp;
      document.updatedAt = timestamp;
      const next = await this.commitDocument(paths, current, document, {
        validationMode: "validated",
        context: "Approved durable phase plan created invalid Notes",
      });
      return { status: "committed", snapshot: toSnapshot(next), phase: structuredClone(phase) };
    });
  }

  async importLegacyPhaseExecution(
    cwd: string,
    request: ProjectNotesExecutionImportRequest,
  ): Promise<ProjectNotesExecutionMutationOutcome> {
    return this.withLockedCurrent(cwd, async (paths, current) => {
      const revision = current.revision;
      const phaseIndex = current.document.phases.findIndex((phase) => phase.id === request.phaseId);
      if (phaseIndex < 0) return { status: "phase-not-found" };
      const currentPhase = current.document.phases[phaseIndex]!;
      if (currentPhase.execution) {
        return isDeepStrictEqual(currentPhase.execution, request.execution)
          ? { status: "duplicate", revision }
          : { status: "operation-conflict", revision };
      }
      if (request.expectedRevision !== revision) return { status: "stale-revision", revision };
      if (currentPhase.archivedAt !== null) return { status: "phase-archived" };
      const document = structuredClone(current.document);
      const phase = document.phases[phaseIndex]!;
      phase.execution = structuredClone(request.execution);
      const candidate =
        request.execution.migration.reconciledAt ??
        request.execution.plan?.approvedAt ??
        phase.updatedAt;
      const timestamp = chronologicalRoadmapTimestamp(phase, candidate);
      phase.updatedAt = timestamp;
      document.updatedAt = timestamp;
      const next = await this.commitDocument(paths, current, document, {
        validationMode: "validated",
        context: "Legacy durable phase import created invalid Notes",
      });
      return { status: "committed", snapshot: toSnapshot(next), phase: structuredClone(phase) };
    });
  }

  async markPhaseExecutionNeedsReconciliation(
    cwd: string,
    request: ProjectNotesExecutionReconciliationRequiredRequest,
  ): Promise<ProjectNotesExecutionMutationOutcome> {
    return this.withLockedCurrent(cwd, async (paths, current) => {
      const revision = current.revision;
      const phaseIndex = current.document.phases.findIndex((phase) => phase.id === request.phaseId);
      if (phaseIndex < 0) return { status: "phase-not-found" };
      const currentPhase = current.document.phases[phaseIndex]!;
      const execution = currentPhase.execution;
      if (!execution?.plan) return { status: "execution-missing" };
      if (execution.plan.contentHash !== request.planHash) return { status: "plan-mismatch" };
      if (execution.state === "needs-reconciliation") return { status: "duplicate", revision };
      if (request.expectedRevision !== revision) return { status: "stale-revision", revision };
      if (currentPhase.archivedAt !== null) return { status: "phase-archived" };
      const document = structuredClone(current.document);
      const phase = document.phases[phaseIndex]!;
      phase.execution!.state = "needs-reconciliation";
      phase.execution!.pendingCompletion = null;
      const timestamp = chronologicalRoadmapTimestamp(phase, request.timestamp);
      phase.updatedAt = timestamp;
      document.updatedAt = timestamp;
      const next = await this.commitDocument(paths, current, document, {
        validationMode: "validated",
        context: "Plan snapshot reconciliation state created invalid Notes",
      });
      return { status: "committed", snapshot: toSnapshot(next), phase: structuredClone(phase) };
    });
  }

  async reconcilePhaseExecution(
    cwd: string,
    request: ProjectNotesExecutionReconciliationRequest,
  ): Promise<ProjectNotesExecutionReconciliationOutcome> {
    return this.withLockedCurrent(cwd, async (paths, current) => {
      const revision = current.revision;
      if (request.expectedProjectKey !== current.projectKey) {
        return { status: "project-mismatch", revision, currentProjectKey: current.projectKey };
      }
      const phaseIndex = current.document.phases.findIndex((phase) => phase.id === request.phaseId);
      if (phaseIndex < 0) return { status: "phase-not-found" };
      const currentPhase = current.document.phases[phaseIndex]!;
      const execution = currentPhase.execution;
      if (!execution?.plan) return { status: "execution-missing" };

      const requestHash = createHash("sha256")
        .update(
          JSON.stringify({
            phaseId: request.phaseId,
            expectedProjectKey: request.expectedProjectKey,
            expectedRevision: request.expectedRevision,
            repository: request.repository,
            plan: request.plan,
            workspace: request.workspace,
            currentSafeToolEnvironmentDigest: request.currentSafeToolEnvironmentDigest,
          }),
        )
        .digest("hex");
      if (execution.migration.reconciliation?.operationId === request.operationId) {
        if (execution.migration.reconciliation.requestHash !== requestHash) {
          return { status: "operation-conflict", revision };
        }
        return reconciliationDuplicateOutcome(currentPhase, revision);
      }

      if (!isDeepStrictEqual(execution.repository, request.repository)) {
        return { status: "repository-mismatch" };
      }
      if (execution.plan.planId !== request.plan.planId) return { status: "plan-mismatch" };
      if (execution.plan.contentHash !== request.plan.contentHash) {
        return { status: "plan-hash-mismatch" };
      }
      if (
        execution.plan.snapshotPath !== request.plan.snapshotPath ||
        execution.plan.approvedAt !== request.plan.approvedAt ||
        execution.plan.approvedRevision !== request.plan.approvedRevision ||
        execution.plan.baseCommit !== request.plan.baseCommit
      ) {
        return { status: "plan-mismatch" };
      }
      if (!isDeepStrictEqual(request.workspace, request.currentWorkspace)) {
        return { status: "workspace-mismatch" };
      }
      if (!isDeepStrictEqual(execution.repository, request.currentWorkspace.repository)) {
        return { status: "repository-mismatch" };
      }
      if (request.expectedRevision !== revision) return { status: "stale-revision", revision };
      if (currentPhase.archivedAt !== null) return { status: "phase-archived" };
      if (currentPhase.status === "done" || currentPhase.status === "cancelled") {
        return { status: "phase-terminal" };
      }
      if (execution.state !== "needs-reconciliation") {
        return { status: "reconciliation-not-required" };
      }

      const ancestorPairs = new Set(
        execution.plan.steps.flatMap((step) => {
          if (!request.cleanAncestorStepIds.includes(step.id) || !step.workspace?.clean) return [];
          return [`${step.workspace.headCommit}\0${request.currentWorkspace.headCommit}`];
        }),
      );
      const reconciledSteps = reconcilePlanSteps(
        execution.plan.steps,
        request.currentWorkspace,
        (ancestor, descendant) => ancestorPairs.has(`${ancestor}\0${descendant}`),
      );
      const document = structuredClone(current.document);
      const phase = document.phases[phaseIndex]!;
      const nextExecution = phase.execution!;
      nextExecution.plan!.steps = reconciledSteps.steps;
      nextExecution.evidence = nextExecution.evidence.map((evidence) =>
        isEvidenceCurrent(
          evidence,
          request.currentWorkspace,
          ROADMAP_VERIFICATION_CLASSIFIER_VERSION,
          request.currentSafeToolEnvironmentDigest,
        )
          ? evidence
          : { ...evidence, state: "needs-revalidation" as const },
      );
      nextExecution.state = "implementing";
      nextExecution.pendingCompletion = null;
      nextExecution.migration.reconciledAt = request.reconciledAt;
      nextExecution.migration.reconciliation = { operationId: request.operationId, requestHash };
      const timestamp = chronologicalRoadmapTimestamp(phase, request.reconciledAt);
      phase.updatedAt = timestamp;
      document.updatedAt = timestamp;
      const next = await this.commitDocument(paths, current, document, {
        validationMode: "validated",
        context: "Phase execution reconciliation created invalid Notes",
      });
      return {
        status: "reconciled",
        revision: next.revision,
        phaseId: phase.id,
        ...reconciliationSummary(phase),
        snapshot: toSnapshot(next),
        phase: structuredClone(phase),
      };
    });
  }
  async checkpointPhaseExecutionStep(
    cwd: string,
    request: ProjectNotesExecutionStepRequest,
  ): Promise<ProjectNotesExecutionMutationOutcome> {
    return this.withLockedCurrent(cwd, async (paths, current) => {
      const revision = current.revision;
      const phaseIndex = current.document.phases.findIndex((phase) => phase.id === request.phaseId);
      if (phaseIndex < 0) return { status: "phase-not-found" };
      const currentPhase = current.document.phases[phaseIndex]!;
      const execution = currentPhase.execution;
      if (!execution?.plan) return { status: "execution-missing" };
      if (executionRequiresReconciliation(currentPhase)) {
        return { status: "operation-conflict", revision };
      }
      if (execution.plan.contentHash !== request.planHash) return { status: "plan-mismatch" };
      if (!isDeepStrictEqual(execution.repository, request.workspace.repository)) {
        return { status: "workspace-mismatch" };
      }
      const stepIndex = execution.plan.steps.findIndex((step) => step.id === request.stepId);
      if (stepIndex < 0) return { status: "step-not-found" };
      const currentStep = execution.plan.steps[stepIndex]!;
      if (currentStep.state === "completed") return { status: "duplicate", revision };
      if (request.expectedRevision !== revision) return { status: "stale-revision", revision };
      if (currentPhase.archivedAt !== null) return { status: "phase-archived" };
      if (execution.plan.steps.slice(0, stepIndex).some((step) => step.state !== "completed")) {
        return { status: "step-order-invalid" };
      }
      const document = structuredClone(current.document);
      const phase = document.phases[phaseIndex]!;
      const step = phase.execution!.plan!.steps[stepIndex]!;
      step.state = "completed";
      step.completedAt = request.completedAt;
      step.workspace = structuredClone(request.workspace);
      phase.execution!.state = "implementing";
      phase.execution!.pendingCompletion = null;
      const timestamp = chronologicalRoadmapTimestamp(phase, request.completedAt);
      phase.updatedAt = timestamp;
      document.updatedAt = timestamp;
      const next = await this.commitDocument(paths, current, document, {
        validationMode: "validated",
        context: "Durable phase checkpoint created invalid Notes",
      });
      return { status: "committed", snapshot: toSnapshot(next), phase: structuredClone(phase) };
    });
  }

  async recordPhaseExecutionEvidence(
    cwd: string,
    request: ProjectNotesExecutionEvidenceRequest,
  ): Promise<ProjectNotesExecutionMutationOutcome> {
    return this.withLockedCurrent(cwd, async (paths, current) => {
      const revision = current.revision;
      const phaseIndex = current.document.phases.findIndex((phase) => phase.id === request.phaseId);
      if (phaseIndex < 0) return { status: "phase-not-found" };
      const currentPhase = current.document.phases[phaseIndex]!;
      const execution = currentPhase.execution;
      if (!execution?.plan) return { status: "execution-missing" };
      if (executionRequiresReconciliation(currentPhase)) {
        return { status: "operation-conflict", revision };
      }
      if (execution.plan.contentHash !== request.planHash) return { status: "plan-mismatch" };
      const prior = execution.evidence.find((item) => {
        if ("version" in request.evidence && request.evidence.version === 2) {
          return (
            "version" in item &&
            item.version === 2 &&
            item.executionId === request.evidence.executionId
          );
        }
        return (
          item.commandHash === request.evidence.commandHash &&
          item.criterionId === request.evidence.criterionId
        );
      });
      if (prior) {
        return isDeepStrictEqual(prior, request.evidence)
          ? { status: "duplicate", revision }
          : { status: "operation-conflict", revision };
      }
      if (request.expectedRevision !== revision) return { status: "stale-revision", revision };
      if (currentPhase.archivedAt !== null) return { status: "phase-archived" };
      const document = structuredClone(current.document);
      const phase = document.phases[phaseIndex]!;
      phase.execution!.evidence.push(structuredClone(request.evidence));
      const timestamp = chronologicalRoadmapTimestamp(phase, request.evidence.observedAt);
      phase.updatedAt = timestamp;
      document.updatedAt = timestamp;
      const next = await this.commitDocument(paths, current, document, {
        validationMode: "validated",
        context: "Durable phase evidence created invalid Notes",
      });
      return { status: "committed", snapshot: toSnapshot(next), phase: structuredClone(phase) };
    });
  }

  async beginDurablePhaseCompletion(
    cwd: string,
    request: ProjectNotesPendingCompletionRequest,
  ): Promise<ProjectNotesExecutionMutationOutcome> {
    return this.withLockedCurrent(cwd, async (paths, current) => {
      const revision = current.revision;
      const phaseIndex = current.document.phases.findIndex((phase) => phase.id === request.phaseId);
      if (phaseIndex < 0) return { status: "phase-not-found" };
      const currentPhase = current.document.phases[phaseIndex]!;
      const execution = currentPhase.execution;
      if (!execution?.plan) return { status: "execution-missing" };
      if (executionRequiresReconciliation(currentPhase)) {
        return { status: "operation-conflict", revision };
      }
      if (execution.pendingCompletion) {
        return isDeepStrictEqual(execution.pendingCompletion, request.pendingCompletion)
          ? { status: "duplicate", revision }
          : { status: "operation-conflict", revision };
      }
      if (execution.plan.contentHash !== request.pendingCompletion.planHash) {
        return { status: "plan-mismatch" };
      }
      if (request.expectedRevision !== revision) return { status: "stale-revision", revision };
      if (execution.plan.steps.some((step) => step.state !== "completed")) {
        return { status: "step-order-invalid" };
      }
      const document = structuredClone(current.document);
      const phase = document.phases[phaseIndex]!;
      phase.execution!.state = "completion-pending";
      phase.execution!.pendingCompletion = structuredClone(request.pendingCompletion);
      const timestamp = chronologicalRoadmapTimestamp(phase, phase.updatedAt);
      phase.updatedAt = timestamp;
      document.updatedAt = timestamp;
      const next = await this.commitDocument(paths, current, document, {
        validationMode: "validated",
        context: "Durable completion intent created invalid Notes",
      });
      return { status: "committed", snapshot: toSnapshot(next), phase: structuredClone(phase) };
    });
  }

  async clearDurablePhaseCompletion(
    cwd: string,
    request: ProjectNotesClearPendingCompletionRequest,
  ): Promise<ProjectNotesExecutionMutationOutcome> {
    return this.withLockedCurrent(cwd, async (paths, current) => {
      const revision = current.revision;
      const phaseIndex = current.document.phases.findIndex((phase) => phase.id === request.phaseId);
      if (phaseIndex < 0) return { status: "phase-not-found" };
      const currentPhase = current.document.phases[phaseIndex]!;
      const pending = currentPhase.execution?.pendingCompletion;
      if (!currentPhase.execution) return { status: "execution-missing" };
      if (executionRequiresReconciliation(currentPhase)) {
        return { status: "operation-conflict", revision };
      }
      if (!pending) return { status: "duplicate", revision };
      if (pending.completionId !== request.completionId)
        return { status: "operation-conflict", revision };
      if (request.expectedRevision !== revision) return { status: "stale-revision", revision };
      const document = structuredClone(current.document);
      const phase = document.phases[phaseIndex]!;
      phase.execution!.state = "implementing";
      phase.execution!.pendingCompletion = null;
      phase.execution!.evidence = phase.execution!.evidence.filter((item) =>
        isDeepStrictEqual(item.workspace, request.currentWorkspace),
      );
      const next = await this.commitDocument(paths, current, document, {
        validationMode: "validated",
        context: "Durable completion rollback created invalid Notes",
      });
      return { status: "committed", snapshot: toSnapshot(next), phase: structuredClone(phase) };
    });
  }

  async settleDurablePhaseCompletion(
    cwd: string,
    request: ProjectNotesDurableSettlementRequest,
  ): Promise<ProjectNotesDurableSettlementOutcome> {
    return this.withLockedCurrent(cwd, async (paths, current) => {
      const revision = current.revision;
      const phaseIndex = current.document.phases.findIndex((phase) => phase.id === request.phaseId);
      if (phaseIndex < 0) return { status: "phase-not-found" };
      const currentPhase = current.document.phases[phaseIndex]!;
      const execution = currentPhase.execution;
      if (!execution?.plan) return { status: "execution-missing" };
      if (executionRequiresReconciliation(currentPhase)) {
        return { status: "operation-conflict", revision };
      }
      const pending = execution.pendingCompletion;
      if (!pending || pending.completionId !== request.completionId) {
        return { status: "completion-intent-missing" };
      }
      if (
        pending.planHash !== request.planHash ||
        execution.plan.contentHash !== request.planHash
      ) {
        return { status: "operation-conflict", revision };
      }
      if (!isDeepStrictEqual(pending.workspace, request.workspace)) {
        return { status: "operation-conflict", revision };
      }

      const priorImplementation = currentPhase.roadmapEvents.find(
        (event): event is NotesRoadmapImplementationCheckpoint =>
          event.type === "implementation-checkpoint" &&
          event.verificationStatusUpdateId === request.completionId,
      );
      if (priorImplementation) {
        const advancementCheckpoint =
          currentPhase.roadmapEvents.find(
            (event): event is NotesRoadmapPhaseAdvancementCheckpoint =>
              event.type === "phase-advancement-checkpoint" &&
              "verificationStatusUpdateId" in event &&
              event.verificationStatusUpdateId === request.completionId &&
              event.implementationCheckpointId === priorImplementation.id,
          ) ?? null;
        return {
          status: "duplicate",
          revision,
          phase: structuredClone(currentPhase),
          evaluation: evaluateDirectPhaseCompletion({
            phase: currentPhase,
            expectedSession: priorImplementation.session,
            implementationCheckpointId: priorImplementation.id,
            verificationStatusUpdateId: request.completionId,
          }),
          advancementCheckpoint: advancementCheckpoint
            ? structuredClone(advancementCheckpoint)
            : null,
        };
      }

      if (request.expectedRevision !== revision) return { status: "stale-revision", revision };
      const verification = currentPhase.roadmapEvents.find(
        (event): event is NotesRoadmapStatusUpdate =>
          event.type === "status-update" && event.id === request.completionId,
      );
      if (!verification?.verificationSession) {
        return {
          status: "completion-intent-missing",
          message: "The durable completion verification event is unavailable.",
        };
      }

      const document = structuredClone(current.document);
      const phase = document.phases[phaseIndex]!;
      const checkpoint: NotesRoadmapImplementationCheckpoint = {
        type: "implementation-checkpoint",
        id: this.createId(),
        session: verification.verificationSession,
        planStepTotal: execution.plan.steps.length,
        completedPlanSteps: execution.plan.steps.map((step) => step.index),
        runOutcome: "succeeded",
        verificationStatusUpdateId: request.completionId,
        timestamp: verification.timestamp,
      };
      phase.roadmapEvents.push(checkpoint);
      const evaluation = evaluateDirectPhaseCompletion({
        phase,
        expectedSession: verification.verificationSession,
        implementationCheckpointId: checkpoint.id,
        verificationStatusUpdateId: request.completionId,
      });
      phase.execution!.state = "completed";

      let advancementCheckpoint: NotesRoadmapPhaseAdvancementCheckpoint | null = null;
      const targetStatus = evaluation.targetStatus;
      applyCompletionEvaluation(phase, evaluation, verification.timestamp, () => this.createId());
      if (evaluation.gateOutcome === "done") {
        const eligibility = classifyRoadmapAutoStartEligibility(document.phases, phase.id);
        if (eligibility.kind === "unique") {
          advancementCheckpoint = {
            type: "phase-advancement-checkpoint",
            id: this.createId(),
            implementationCheckpointId: checkpoint.id,
            verificationStatusUpdateId: request.completionId,
            completedPhaseId: phase.id,
            nextPhaseId: eligibility.phase.id,
            timestamp: verification.timestamp,
          };
          phase.roadmapEvents.push(advancementCheckpoint);
        }
      }

      const next = await this.commitDocument(paths, current, document, {
        validationMode: "validated",
        context: "Durable completion settlement created invalid Notes",
      });
      return {
        status: targetStatus === null ? "open" : "committed",
        snapshot: toSnapshot(next),
        phase: structuredClone(phase),
        evaluation,
        advancementCheckpoint: advancementCheckpoint
          ? structuredClone(advancementCheckpoint)
          : null,
      };
    });
  }

  async recordRoadmapStatusUpdate(
    cwd: string,
    request: ProjectNotesRoadmapStatusRequest,
  ): Promise<ProjectNotesRoadmapStatusOutcome> {
    return this.withLockedCurrent(cwd, async (paths, current) => {
      const revision = current.revision;
      const phaseIndex = current.document.phases.findIndex((phase) => phase.id === request.phaseId);
      if (phaseIndex < 0) return { status: "phase-not-found" };
      const currentPhase = current.document.phases[phaseIndex]!;
      if (request.transition === "done" && executionRequiresReconciliation(currentPhase)) {
        return { status: "operation-conflict", revision };
      }
      const normalizedReferences = request.proposedReferences.map(
        normalizeRoadmapProposedReference,
      );
      const normalizedRequest = { ...request, proposedReferences: normalizedReferences };
      const prior = currentPhase.roadmapEvents.find(
        (event): event is NotesRoadmapStatusUpdate =>
          event.type === "status-update" && event.id === request.updateId,
      );
      if (prior) {
        if (
          !sameRoadmapStatusPayload(prior, normalizedRequest) ||
          !sameDurableCompletionPayload(
            currentPhase.execution?.pendingCompletion,
            currentPhase,
            normalizedRequest,
          )
        ) {
          return {
            status: request.durableCompletion ? "operation-conflict" : "duplicate-id-conflict",
            revision,
          };
        }
        return {
          status: "duplicate",
          revision,
          phaseId: request.phaseId,
          phase: structuredClone(currentPhase),
          statusOutcome: prior.statusOutcome,
          proposals: prior.proposedReferences.map(roadmapProposalOutcome),
        };
      }

      if (request.expectedRevision !== undefined && request.expectedRevision !== revision) {
        return { status: "stale-revision", revision };
      }
      if (currentPhase.archivedAt !== null) return { status: "phase-archived" };
      if (
        currentPhase.execution === undefined &&
        (request.requireBoundPhase || request.verification !== null) &&
        currentPhase.session === null
      ) {
        return { status: "phase-not-bound" };
      }
      if (
        currentPhase.execution === undefined &&
        request.expectedSession !== undefined &&
        !notesSessionLinksEqual(currentPhase.session, request.expectedSession)
      ) {
        return { status: "stale-session" };
      }
      if (request.actor === "gg-coder" && request.transition === "done") {
        if (request.verification !== "passed") {
          return {
            status: "verification-incomplete",
            revision,
            message: "Done requires a passed verification result.",
          };
        }
        const legacyRunFinalizerCompletion =
          request.completionMode === "legacy-run-finalizer" &&
          currentPhase.execution === undefined &&
          request.expectedRevision !== undefined &&
          request.expectedSession !== undefined &&
          request.expectedSession !== null &&
          currentPhase.session !== null &&
          notesSessionLinksEqual(currentPhase.session, request.expectedSession);
        const durableCompletion =
          request.completionMode !== "legacy-run-finalizer" &&
          currentPhase.execution !== undefined &&
          request.durableCompletion !== undefined &&
          request.expectedRevision !== undefined;
        if (!legacyRunFinalizerCompletion && !durableCompletion) {
          return {
            status: "verification-incomplete",
            revision,
            message: "Durable completion requires a revision-bound GG Coder Done report.",
          };
        }
      }
      if (request.durableCompletion) {
        const execution = currentPhase.execution;
        if (
          request.actor !== "gg-coder" ||
          request.transition !== "done" ||
          request.expectedRevision === undefined
        ) {
          return {
            status: "verification-incomplete",
            revision,
            message: "Durable completion requires a revision-bound GG Coder Done report.",
          };
        }
        if (!execution?.plan) {
          return {
            status: "verification-incomplete",
            revision,
            message: "Durable completion requires an approved execution plan.",
          };
        }
        if (execution.plan.contentHash !== request.durableCompletion.planHash) {
          return {
            status: "verification-incomplete",
            revision,
            message: "Durable completion does not match the approved execution plan.",
          };
        }
        if (execution.plan.steps.some((step) => step.state !== "completed")) {
          return {
            status: "verification-incomplete",
            revision,
            message: "Durable completion requires every execution step to be completed.",
          };
        }
        if (execution.pendingCompletion !== null) {
          return { status: "operation-conflict", revision };
        }
        const evidenceError = validateAtomicCompletionEvidence(
          currentPhase,
          request.durableCompletion,
        );
        if (evidenceError) {
          return evidenceError === "operation-conflict"
            ? { status: "operation-conflict", revision }
            : { status: "verification-incomplete", revision, message: evidenceError };
        }
      }
      if (!isNotesVerificationEvidenceSatisfied(request.verification, request.evidence)) {
        return {
          status: "verification-incomplete",
          revision,
          message: "Passed verification requires nonempty evidence.",
        };
      }
      const timestamp = chronologicalRoadmapTimestamp(currentPhase, request.timestamp);
      const referenceError = validateRoadmapProposedReferences(normalizedReferences, timestamp);
      if (referenceError) return { status: "invalid-reference", ...referenceError };

      const document = structuredClone(current.document);
      const phase = document.phases[phaseIndex]!;
      let statusOutcome: NotesRoadmapStatusOutcome;
      if (request.transition === "done") {
        statusOutcome = "completion-pending";
      } else {
        const targetStatus = notesPhaseStatusForRoadmapTransition(request.transition);
        if (targetStatus === "done") throw new Error("Done must settle after the owning run.");
        const lifecycleOutcome = applyPhaseLifecycleTransition(
          phase,
          {
            status: targetStatus,
            source: "agent",
            reason:
              request.transition === "blocked"
                ? request.blocker!
                : `Roadmap report: ${request.progress}`,
            timestamp,
            kind: request.transition === "blocked" ? "attention-question-opened" : "other",
          },
          this.createId,
        );
        statusOutcome = roadmapStatusOutcome(lifecycleOutcome);
      }
      const proposals = appendRoadmapStatusEvent(
        document,
        phaseIndex,
        request,
        normalizedReferences,
        timestamp,
        statusOutcome,
        this.createId,
      );
      if (request.durableCompletion) {
        const { verificationEvidence, ...pendingCompletion } = request.durableCompletion;
        phase.execution!.evidence.push(
          ...structuredClone(
            verificationEvidence.filter(
              (record) =>
                !phase.execution!.evidence.some(
                  (candidate) =>
                    "version" in candidate &&
                    candidate.version === 2 &&
                    candidate.executionId === record.executionId,
                ),
            ),
          ),
        );
        phase.execution!.state = "completion-pending";
        phase.execution!.pendingCompletion = {
          ...structuredClone(pendingCompletion),
          completionId: request.updateId,
          statusRevision: revision + 1,
        };
      }
      const validation = validateNotesDocumentV3(document);
      if (!validation.ok) {
        if (validation.error.path.includes("proposedReferences")) {
          return {
            status: "invalid-reference",
            path: validation.error.path,
            message: validation.error.message,
          };
        }
        throw new Error(`Roadmap reconciliation created invalid Notes: ${validation.error.path}`);
      }
      const next = await this.commitDocument(paths, current, validation.document, {
        validationMode: "validated",
        context: "Roadmap reconciliation created invalid Notes",
      });
      return {
        status: "committed",
        snapshot: toSnapshot(next),
        phase: structuredClone(phase),
        statusOutcome,
        proposals: proposals.map(roadmapProposalOutcome),
      };
    });
  }

  async settlePhaseCompletion(
    cwd: string,
    request: ProjectNotesPhaseCompletionSettlementRequest,
  ): Promise<ProjectNotesPhaseCompletionSettlementOutcome> {
    const invalid = validateImplementationCheckpointRequest(request);
    if (invalid || !isNonEmptyString(request.completionIntentId)) {
      return {
        status: "invalid-checkpoint",
        message: invalid ?? "Completion intent ID is required.",
      };
    }
    return this.withLockedCurrent(cwd, async (paths, current) => {
      const revision = current.revision;
      const phaseIndex = current.document.phases.findIndex((phase) => phase.id === request.phaseId);
      if (phaseIndex < 0) return { status: "phase-not-found" };
      const currentPhase = current.document.phases[phaseIndex]!;
      if (currentPhase.execution !== undefined) return { status: "operation-conflict", revision };
      const prior = currentPhase.roadmapEvents.find(
        (event): event is NotesRoadmapImplementationCheckpoint =>
          event.type === "implementation-checkpoint" && event.id === request.checkpointId,
      );
      if (prior) {
        if (!sameCompletionSettlementPayload(prior, request)) {
          return { status: "duplicate-id-conflict", revision };
        }
        const evaluation = evaluateDirectPhaseCompletion({
          phase: currentPhase,
          expectedSession: request.expectedSession,
          implementationCheckpointId: prior.id,
          verificationStatusUpdateId: request.completionIntentId,
        });
        const advancementCheckpoint =
          currentPhase.roadmapEvents.find(
            (event): event is NotesRoadmapPhaseAdvancementCheckpoint =>
              event.type === "phase-advancement-checkpoint" &&
              "implementationCheckpointId" in event &&
              event.implementationCheckpointId === prior.id,
          ) ?? null;
        return {
          status: "duplicate",
          revision,
          phase: structuredClone(currentPhase),
          evaluation,
          advancementCheckpoint: advancementCheckpoint
            ? structuredClone(advancementCheckpoint)
            : null,
        };
      }
      if (currentPhase.roadmapEvents.some((event) => event.id === request.checkpointId)) {
        return { status: "duplicate-id-conflict", revision };
      }
      if (request.expectedRevision !== undefined && request.expectedRevision !== revision) {
        return { status: "stale-revision", revision };
      }
      if (currentPhase.archivedAt !== null) return { status: "phase-archived" };
      if (
        currentPhase.execution === undefined &&
        !notesSessionLinksEqual(currentPhase.session, request.expectedSession)
      ) {
        return { status: "stale-session" };
      }
      const completionIntent = currentPhase.roadmapEvents.find(
        (event): event is NotesRoadmapStatusUpdate =>
          event.type === "status-update" && event.id === request.completionIntentId,
      );
      if (!completionIntent || completionIntent.verification === null) {
        return {
          status: "completion-intent-missing",
          message: "The current run's typed completion intent was not found.",
        };
      }

      const document = structuredClone(current.document);
      const phase = document.phases[phaseIndex]!;
      const timestamp = chronologicalRoadmapTimestamp(phase, request.timestamp);
      phase.roadmapEvents.push({
        type: "implementation-checkpoint",
        id: request.checkpointId,
        session: { ...request.expectedSession },
        planStepTotal: request.planStepTotal,
        completedPlanSteps: [...request.completedPlanSteps],
        runOutcome: request.runOutcome,
        verificationStatusUpdateId: request.completionIntentId,
        timestamp,
      });
      const evaluation = evaluateDirectPhaseCompletion({
        phase,
        expectedSession: request.expectedSession,
        implementationCheckpointId: request.checkpointId,
        verificationStatusUpdateId: request.completionIntentId,
      });
      let advancementCheckpoint: NotesRoadmapPhaseAdvancementCheckpoint | null = null;
      if (evaluation.targetStatus === "done") {
        if (phase.execution?.pendingCompletion?.completionId === request.completionIntentId) {
          phase.execution.state = "completed";
        }
        applyCompletionEvaluation(phase, evaluation, timestamp, this.createId);
        const eligibility = classifyRoadmapAutoStartEligibility(document.phases, phase.id);
        if (eligibility.kind === "unique") {
          advancementCheckpoint = {
            type: "phase-advancement-checkpoint",
            id: this.createId(),
            implementationCheckpointId: request.checkpointId,
            verificationStatusUpdateId: request.completionIntentId,
            completedPhaseId: phase.id,
            nextPhaseId: eligibility.phase.id,
            timestamp,
          };
          phase.roadmapEvents.push(advancementCheckpoint);
        }
      }
      phase.updatedAt = timestamp;
      document.updatedAt = timestamp;
      const next = await this.commitDocument(paths, current, document, {
        validationMode: "validated",
        context: "Direct phase completion settlement created invalid Notes",
      });
      return {
        status: evaluation.targetStatus === "done" ? "committed" : "open",
        snapshot: toSnapshot(next),
        phase: structuredClone(phase),
        evaluation,
        advancementCheckpoint: advancementCheckpoint
          ? structuredClone(advancementCheckpoint)
          : null,
      };
    });
  }

  async recordImplementationCheckpoint(
    cwd: string,
    request: ProjectNotesImplementationCheckpointRequest,
  ): Promise<ProjectNotesImplementationCheckpointOutcome> {
    const invalid = validateImplementationCheckpointRequest(request);
    if (invalid) return { status: "invalid-checkpoint", message: invalid };
    return this.withLockedCurrent(cwd, async (paths, current) => {
      const revision = current.revision;
      const phaseIndex = current.document.phases.findIndex((phase) => phase.id === request.phaseId);
      if (phaseIndex < 0) return { status: "phase-not-found" };
      const currentPhase = current.document.phases[phaseIndex]!;
      if (executionRequiresReconciliation(currentPhase)) {
        return { status: "operation-conflict", revision };
      }
      const prior = currentPhase.roadmapEvents.find(
        (event): event is NotesRoadmapImplementationCheckpoint =>
          event.type === "implementation-checkpoint" && event.id === request.checkpointId,
      );
      if (prior) {
        return sameImplementationCheckpointPayload(prior, request)
          ? { status: "duplicate", revision, phaseId: request.phaseId }
          : { status: "duplicate-id-conflict", revision };
      }
      if (currentPhase.roadmapEvents.some((event) => event.id === request.checkpointId)) {
        return { status: "duplicate-id-conflict", revision };
      }
      if (currentPhase.archivedAt !== null) return { status: "phase-archived" };
      if (!notesSessionLinksEqual(currentPhase.session, request.expectedSession)) {
        return { status: "stale-session" };
      }

      const document = structuredClone(current.document);
      const phase = document.phases[phaseIndex]!;
      const timestamp = chronologicalRoadmapTimestamp(phase, request.timestamp);
      phase.roadmapEvents.push({
        type: "implementation-checkpoint",
        id: request.checkpointId,
        session: { ...request.expectedSession },
        planStepTotal: request.planStepTotal,
        completedPlanSteps: [...request.completedPlanSteps],
        runOutcome: request.runOutcome,
        timestamp,
      });
      phase.updatedAt = timestamp;
      document.updatedAt = timestamp;
      const next = await this.commitDocument(paths, current, document, {
        validationMode: "validated",
        context: "Implementation checkpoint created invalid Notes",
      });
      return {
        status: "committed",
        snapshot: toSnapshot(next),
        phase: structuredClone(phase),
      };
    });
  }

  async confirmAutomaticPhaseAdvancement(
    cwd: string,
    request: ProjectNotesAutomaticPhaseAdvancementRequest,
  ): Promise<ProjectNotesAutomaticPhaseAdvancementOutcome> {
    if (
      !request.checkpointId.trim() ||
      !Number.isSafeInteger(request.expectedRevision) ||
      request.expectedRevision < 0 ||
      !request.destinationSession.sessionId.trim() ||
      request.destinationSession.sessionPath === null ||
      !request.destinationSession.sessionPath.trim() ||
      !Number.isFinite(Date.parse(request.timestamp))
    ) {
      return { status: "invalid-confirmation" };
    }
    return this.withLockedCurrent(cwd, (paths, current) =>
      this.confirmAutomaticPhaseAdvancementLocked(paths, current, request),
    );
  }

  async confirmPhaseAdvancement(
    cwd: string,
    request: ProjectNotesPhaseAdvancementStartRequest,
    createBinding: (context: FrozenPhaseLaunchContext) => Promise<NotesSessionLink>,
  ): Promise<ProjectNotesPhaseAdvancementStartOutcome> {
    if (
      request.action !== "start-next-phase" ||
      !request.checkpointId.trim() ||
      !request.nextPhaseId.trim() ||
      !request.operationId.trim()
    ) {
      return { status: "invalid-confirmation" };
    }
    return this.withLockedCurrent(cwd, async (paths, current) => {
      let sourcePhaseIndex = -1;
      let checkpoint: NotesRoadmapPhaseAdvancementCheckpoint | undefined;
      for (let index = 0; index < current.document.phases.length; index += 1) {
        const candidate = current.document.phases[index]!.roadmapEvents.find(
          (event): event is NotesRoadmapPhaseAdvancementCheckpoint =>
            event.type === "phase-advancement-checkpoint" && event.id === request.checkpointId,
        );
        if (candidate) {
          sourcePhaseIndex = index;
          checkpoint = candidate;
          break;
        }
      }
      if (!checkpoint || sourcePhaseIndex < 0) {
        return { status: "stale", reason: "checkpoint-not-found" };
      }
      if (checkpoint.nextPhaseId !== request.nextPhaseId) {
        return { status: "stale", reason: "target-mismatch" };
      }
      const sourcePhase = current.document.phases[sourcePhaseIndex]!;
      const existingConfirmation = sourcePhase.roadmapEvents.find(
        (event): event is NotesRoadmapPhaseAdvancementConfirmation =>
          event.type === "phase-advancement-confirmation" && event.checkpointId === checkpoint.id,
      );
      const targetPhase = current.document.phases.find(
        (phase) => phase.id === checkpoint.nextPhaseId,
      );
      if (existingConfirmation) {
        if (targetPhase && targetPhase.session && targetPhase.session.sessionPath !== null) {
          const { references } = phaseLaunchContext(current.document, targetPhase);
          return {
            status: "already-bound",
            snapshot: toSnapshot(current),
            phase: structuredClone(targetPhase),
            references: structuredClone(references),
            session: { ...targetPhase.session },
          };
        }
        return { status: "stale", reason: "checkpoint-confirmed" };
      }
      const nextPhaseIndex = selectNextEligibleRoadmapPhaseIndexForCheckpoint(
        current.document,
        checkpoint,
      );
      if (nextPhaseIndex === null) {
        return {
          status: "stale",
          reason: isCompletionCheckpointAuthoritative(sourcePhase, checkpoint)
            ? "target-ineligible"
            : "completion-not-authoritative",
        };
      }
      const currentTarget = current.document.phases[nextPhaseIndex]!;
      if (currentTarget.id !== checkpoint.nextPhaseId) {
        return { status: "stale", reason: "target-mismatch" };
      }
      const { references } = phaseLaunchContext(current.document, currentTarget);
      const frozen: FrozenPhaseLaunchContext = {
        projectKey: current.projectKey,
        phase: structuredClone(currentTarget),
        references: structuredClone(references),
      };
      const session = await createBinding(frozen);
      if (
        !session.sessionId.trim() ||
        (session.sessionPath !== null && !session.sessionPath.trim())
      ) {
        throw new Error("Phase binding callback returned an invalid session link.");
      }

      const document = structuredClone(current.document);
      const source = document.phases[sourcePhaseIndex]!;
      const boundPhase = document.phases[nextPhaseIndex]!;
      const requestedTimestamp = new Date().toISOString();
      const confirmationTimestamp = chronologicalRoadmapTimestamp(source, requestedTimestamp);
      source.roadmapEvents.push({
        type: "phase-advancement-confirmation",
        id: this.createId(),
        checkpointId: checkpoint.id,
        nextPhaseId: checkpoint.nextPhaseId,
        actor: "user",
        operationId: request.operationId,
        timestamp: confirmationTimestamp,
      });
      source.updatedAt = confirmationTimestamp;
      boundPhase.session = { ...session };
      const lifecycleTimestamp = chronologicalLifecycleTimestamp(boundPhase, requestedTimestamp);
      const transition = applyPhaseLifecycleTransition(
        boundPhase,
        {
          status: "planning",
          source: "user",
          reason: "Next phase started after explicit human confirmation",
          timestamp: lifecycleTimestamp,
          kind: "other",
        },
        this.createId,
      );
      if (transition !== "updated") boundPhase.updatedAt = lifecycleTimestamp;
      document.updatedAt =
        Date.parse(confirmationTimestamp) >= Date.parse(lifecycleTimestamp)
          ? confirmationTimestamp
          : lifecycleTimestamp;
      const next = await this.commitDocument(paths, current, document, {
        validationMode: "validated",
        context: "Phase advancement confirmation created invalid Notes",
      });
      return {
        status: "accepted",
        snapshot: toSnapshot(next),
        phase: structuredClone(boundPhase),
        references: structuredClone(references),
        session: { ...session },
      };
    });
  }

  async launchPhase(
    cwd: string,
    phaseId: string,
    createBinding: (context: FrozenPhaseLaunchContext) => Promise<NotesSessionLink>,
  ): Promise<ProjectNotesPhaseLaunchOutcome> {
    return this.withLockedCurrent(cwd, async (paths, current) => {
      const phaseIndex = current.document.phases.findIndex((phase) => phase.id === phaseId);
      if (phaseIndex < 0) return { status: "phase-not-found" };
      const currentPhase = current.document.phases[phaseIndex]!;
      const pendingAdvancement = pendingAdvancementCheckpointForSuccessor(
        current.document,
        phaseId,
      );
      if (pendingAdvancement) {
        return {
          status: "advancement-confirmation-required",
          checkpointId: pendingAdvancement.id,
        };
      }
      if (currentPhase.archivedAt !== null) return { status: "phase-archived" };
      if (currentPhase.status === "done") return { status: "done-terminal" };
      const { references } = phaseLaunchContext(current.document, currentPhase);
      if (currentPhase.session && currentPhase.session.sessionPath !== null) {
        return {
          status: "already-bound",
          snapshot: toSnapshot(current),
          phase: structuredClone(currentPhase),
          references: structuredClone(references),
          session: { ...currentPhase.session },
        };
      }

      const frozen: FrozenPhaseLaunchContext = {
        projectKey: current.projectKey,
        phase: structuredClone(currentPhase),
        references: structuredClone(references),
      };
      const session = await createBinding(frozen);
      if (
        !session.sessionId.trim() ||
        (session.sessionPath !== null && !session.sessionPath.trim())
      ) {
        throw new Error("Phase binding callback returned an invalid session link.");
      }
      const document = structuredClone(current.document);
      const boundPhase = document.phases[phaseIndex]!;
      boundPhase.session = { ...session };
      const timestamp = chronologicalLifecycleTimestamp(boundPhase, new Date().toISOString());
      const transition = applyPhaseLifecycleTransition(
        boundPhase,
        {
          status: "planning",
          source: "user",
          reason: "Phase started by user",
          timestamp,
          kind: "other",
        },
        this.createId,
      );
      if (transition !== "updated") boundPhase.updatedAt = timestamp;
      document.updatedAt = timestamp;
      const next = await this.commitDocument(paths, current, document, {
        validationMode: "trusted",
        context: "Phase launch commit",
      });
      return {
        status: "accepted",
        snapshot: toSnapshot(next),
        phase: structuredClone(boundPhase),
        references: structuredClone(references),
        session: { ...session },
      };
    });
  }

  async previewManualCompletionApproval(
    cwd: string,
    phaseId: string,
    expectedRevision: number,
    expectedSession: NotesSessionLink,
  ): Promise<ProjectNotesManualApprovalPreviewOutcome> {
    return this.withLockedCurrent(cwd, async (_paths, current) => {
      if (current.revision !== expectedRevision) {
        return { status: "stale-revision", revision: current.revision };
      }
      return manualApprovalFacts(current, phaseId, expectedSession);
    });
  }

  async commitManualCompletionApproval(
    cwd: string,
    request: ProjectNotesManualApprovalCommitRequest,
  ): Promise<ManualCompletionApprovalCommitOutcome> {
    return this.withLockedCurrent(cwd, async (paths, current) => {
      const phase = current.document.phases.find((candidate) => candidate.id === request.phaseId);
      const prior = phase?.roadmapEvents.find((event) => event.id === request.approvalId);
      if (prior) {
        if (
          prior.type === "manual-completion-approval" &&
          prior.implementationCheckpointId === request.implementationCheckpointId &&
          prior.verificationStatusUpdateId === request.verificationStatusUpdateId &&
          notesSessionLinksEqual(prior.session, request.expectedSession)
        ) {
          return {
            status: "duplicate",
            revision: current.revision,
            phaseId: request.phaseId,
            approvalId: request.approvalId,
          };
        }
        return { status: "unmet-gate", revision: current.revision, code: "evidence-mismatch" };
      }
      if (current.revision !== request.expectedRevision) {
        return { status: "stale-revision", revision: current.revision };
      }
      const facts = manualApprovalFacts(current, request.phaseId, request.expectedSession);
      if (facts.status !== "ready") return facts;
      if (
        facts.implementationCheckpointId !== request.implementationCheckpointId ||
        facts.verificationStatusUpdateId !== request.verificationStatusUpdateId
      ) {
        return { status: "unmet-gate", revision: current.revision, code: "evidence-mismatch" };
      }
      const document = structuredClone(current.document);
      const target = document.phases.find((candidate) => candidate.id === request.phaseId)!;
      const timestamp = chronologicalRoadmapTimestamp(target, request.timestamp);
      const approval: NotesRoadmapManualCompletionApproval = {
        type: "manual-completion-approval",
        id: request.approvalId,
        authority: "native-user",
        session: structuredClone(request.expectedSession),
        implementationCheckpointId: request.implementationCheckpointId,
        verificationStatusUpdateId: request.verificationStatusUpdateId,
        timestamp,
      };
      target.roadmapEvents.push(approval);
      target.lifecycleEvents.push({
        id: `${request.approvalId}:done`,
        fromStatus: target.status,
        toStatus: "done",
        source: "user",
        timestamp,
        reason: "Completion approved through native authority",
        kind: "other",
      });
      target.status = "done";
      target.completedAt = timestamp;
      target.updatedAt = timestamp;
      document.updatedAt = timestamp;
      const next = await this.commitDocument(paths, current, document, {
        validationMode: "validated",
        context: "Manual completion approval created invalid Notes",
      });
      return {
        status: "committed",
        revision: next.revision,
        phaseId: request.phaseId,
        approvalId: request.approvalId,
      };
    });
  }

  async bindPhaseToCurrentSession(
    cwd: string,
    request: ProjectNotesPhaseBindingRequest,
  ): Promise<PhaseBindingOutcome> {
    if (
      !request.operationId.trim() ||
      !request.phaseId.trim() ||
      !request.expectedProjectKey.trim() ||
      !request.destinationSession.sessionId.trim() ||
      !Number.isSafeInteger(request.expectedRevision) ||
      request.expectedRevision < 0 ||
      !Number.isFinite(Date.parse(request.timestamp))
    ) {
      throw new Error("Cannot bind a phase with an invalid compare-and-swap request.");
    }
    if (request.destinationSession.sessionPath === null) return { status: "missing-session-path" };
    if (
      (request.action === "bind-current" && request.expectedPreviousSession !== null) ||
      (request.action === "rebind-current" && request.expectedPreviousSession === null)
    ) {
      throw new Error("Phase binding action does not match its expected previous session.");
    }

    return this.withLockedCurrent(cwd, async (paths, current) => {
      const revision = current.revision;
      if (current.projectKey !== request.expectedProjectKey) {
        return { status: "project-mismatch", revision, currentProjectKey: current.projectKey };
      }
      const phaseIndex = current.document.phases.findIndex((phase) => phase.id === request.phaseId);
      if (phaseIndex < 0) return { status: "phase-not-found" };
      const currentPhase = current.document.phases[phaseIndex]!;
      const executionSession = currentPhase.execution?.lastSession ?? null;
      const alreadyBound =
        notesSessionLinksEqual(currentPhase.session, request.destinationSession) &&
        (!currentPhase.execution ||
          notesSessionLinksEqual(executionSession, request.destinationSession));
      for (const candidate of current.document.phases) {
        const prior = candidate.roadmapEvents.find((event) => event.id === request.operationId);
        if (!prior) continue;
        if (
          prior.type === "phase-binding" &&
          candidate.id === request.phaseId &&
          prior.action === request.action &&
          notesSessionLinksEqual(prior.previousSession, request.expectedPreviousSession) &&
          notesSessionLinksEqual(prior.session, request.destinationSession)
        ) {
          return {
            status: "duplicate",
            revision,
            phaseId: request.phaseId,
            previousSession: structuredClone(prior.previousSession),
            session: structuredClone(prior.session),
          };
        }
        if (alreadyBound) {
          return {
            status: "already-bound",
            revision,
            phaseId: request.phaseId,
            session: structuredClone(request.destinationSession),
          };
        }
        return { status: "duplicate-id-conflict", revision };
      }
      if (alreadyBound) {
        return {
          status: "already-bound",
          revision,
          phaseId: request.phaseId,
          session: structuredClone(request.destinationSession),
        };
      }
      if (currentPhase.archivedAt !== null) return { status: "phase-archived" };
      if (currentPhase.status === "done") return { status: "phase-terminal" };
      if (revision !== request.expectedRevision) return { status: "stale-revision", revision };
      const compatibilityCanMove =
        notesSessionLinksEqual(currentPhase.session, request.expectedPreviousSession) ||
        notesSessionLinksEqual(currentPhase.session, request.destinationSession);
      const executionCanMove =
        !currentPhase.execution ||
        notesSessionLinksEqual(executionSession, request.expectedPreviousSession) ||
        notesSessionLinksEqual(executionSession, request.destinationSession);
      if (!compatibilityCanMove || !executionCanMove) {
        return {
          status: "stale-previous-session",
          revision,
          currentSession: structuredClone(executionSession ?? currentPhase.session),
        };
      }

      const document = structuredClone(current.document);
      const phase = document.phases[phaseIndex]!;
      const timestamp = chronologicalRoadmapTimestamp(phase, request.timestamp);
      const binding: NotesRoadmapPhaseBinding = {
        type: "phase-binding",
        id: request.operationId,
        action: request.action,
        actor: "coding-session",
        previousSession: structuredClone(request.expectedPreviousSession),
        session: structuredClone(request.destinationSession),
        timestamp,
      };
      phase.session = structuredClone(request.destinationSession);
      if (phase.execution) {
        phase.execution.lastSession = structuredClone(request.destinationSession);
      }
      phase.roadmapEvents.push(binding);
      phase.updatedAt = timestamp;
      document.updatedAt = timestamp;
      const next = await this.commitDocument(paths, current, document, {
        validationMode: "validated",
        context: "Phase binding created invalid Notes",
      });
      return {
        status: "committed",
        revision: next.revision,
        phaseId: request.phaseId,
        previousSession: structuredClone(request.expectedPreviousSession),
        session: structuredClone(request.destinationSession),
      };
    });
  }

  async updatePhaseSessionLink(
    cwd: string,
    phaseId: string,
    session: NotesSessionLink,
    expectedPreviousSession?: NotesSessionLink,
  ): Promise<ProjectNotesPhaseLinkOutcome> {
    if (
      !session.sessionId.trim() ||
      (session.sessionPath !== null && !session.sessionPath.trim())
    ) {
      throw new Error("Cannot store an invalid phase session link.");
    }
    return this.mutatePhaseLinkFields(
      cwd,
      phaseId,
      (phase) => {
        phase.session = { ...session };
      },
      expectedPreviousSession,
    );
  }

  async recordUserPhaseCancellation(
    cwd: string,
    phaseId: string,
    expectedSession: NotesSessionLink,
    requestedTimestamp: string,
  ): Promise<ProjectNotesPhaseLifecycleOutcome> {
    if (
      !expectedSession.sessionId.trim() ||
      (expectedSession.sessionPath !== null && !expectedSession.sessionPath.trim())
    ) {
      throw new Error("Cannot cancel a phase with an invalid session link.");
    }
    if (!Number.isFinite(Date.parse(requestedTimestamp))) {
      throw new Error("Cannot cancel a phase with an invalid timestamp.");
    }

    return this.withLockedCurrent(cwd, async (paths, current) => {
      const phaseIndex = current.document.phases.findIndex((phase) => phase.id === phaseId);
      if (phaseIndex < 0) return { status: "phase-not-found" };
      const currentPhase = current.document.phases[phaseIndex]!;
      if (currentPhase.archivedAt !== null) return { status: "phase-archived" };
      if (!notesSessionLinksEqual(currentPhase.session, expectedSession)) {
        return { status: "stale-session" };
      }
      if (currentPhase.status === "done") return { status: "done-terminal" };
      if (currentPhase.status === "cancelled") {
        return {
          status: "ok",
          snapshot: toSnapshot(current),
          phase: structuredClone(currentPhase),
        };
      }

      const document = structuredClone(current.document);
      const phase = document.phases[phaseIndex]!;
      const timestamp = chronologicalLifecycleTimestamp(phase, requestedTimestamp);
      const fromStatus = phase.status;
      phase.status = "cancelled";
      phase.attentionReason = null;
      phase.completedAt = timestamp;
      phase.updatedAt = timestamp;
      phase.pendingAutomaticLifecycleTransition = null;
      phase.overrides.status = { value: "cancelled", source: "user", updatedAt: timestamp };
      phase.lifecycleEvents.push({
        id: this.createId(),
        fromStatus,
        toStatus: "cancelled",
        source: "user",
        timestamp,
        reason: "Phase run cancelled by user",
        kind: "other",
      });
      document.updatedAt = timestamp;
      const next = await this.commitDocument(paths, current, document, {
        validationMode: "trusted",
        context: "User phase cancellation commit",
      });
      return {
        status: "ok",
        snapshot: toSnapshot(next),
        phase: structuredClone(phase),
      };
    });
  }

  async recordPhaseLifecycleTransition(
    cwd: string,
    phaseId: string,
    transition: ProjectNotesPhaseLifecycleTransition,
  ): Promise<ProjectNotesPhaseLifecycleOutcome> {
    if (!isNotesPhaseStatus(transition.status) || !isNotesLifecycleEventSource(transition.source)) {
      throw new Error("Cannot record an invalid automatic phase lifecycle transition.");
    }
    if (!Number.isFinite(Date.parse(transition.timestamp))) {
      throw new Error("Cannot record a phase lifecycle transition with an invalid timestamp.");
    }
    return this.withLockedCurrent(cwd, async (paths, current) => {
      const phaseIndex = current.document.phases.findIndex((phase) => phase.id === phaseId);
      if (phaseIndex < 0) return { status: "phase-not-found" };
      const currentPhase = current.document.phases[phaseIndex]!;
      if (currentPhase.archivedAt !== null) return { status: "phase-archived" };
      if (
        transition.expectedSession !== undefined &&
        !notesSessionLinksEqual(currentPhase.session, transition.expectedSession)
      ) {
        return { status: "stale-session" };
      }
      if (currentPhase.overrides.status !== null) {
        const existingPending = currentPhase.pendingAutomaticLifecycleTransition;
        if (
          existingPending !== null &&
          existingPending.status === transition.status &&
          existingPending.source === transition.source &&
          existingPending.reason === transition.reason &&
          existingPending.kind === transition.kind &&
          notesSessionLinksEqual(
            existingPending.expectedSession,
            transition.expectedSession ?? null,
          )
        ) {
          return {
            status: "manual-override",
            snapshot: toSnapshot(current),
            phase: structuredClone(currentPhase),
          };
        }
        const document = structuredClone(current.document);
        const phase = document.phases[phaseIndex]!;
        const timestamp = chronologicalLifecycleTimestamp(phase, transition.timestamp);
        const pending = pendingAutomaticLifecycleTransition(phase, transition, timestamp);
        if (isDeepStrictEqual(phase.pendingAutomaticLifecycleTransition, pending)) {
          return {
            status: "manual-override",
            snapshot: toSnapshot(current),
            phase: structuredClone(currentPhase),
          };
        }
        phase.pendingAutomaticLifecycleTransition = pending;
        phase.updatedAt = timestamp;
        document.updatedAt = timestamp;
        const next = await this.commitDocument(paths, current, document, {
          validationMode: "trusted",
          context: "Suppressed phase lifecycle commit",
        });
        return {
          status: "manual-override",
          snapshot: toSnapshot(next),
          phase: structuredClone(phase),
        };
      }
      if (currentPhase.status === "done") return { status: "done-terminal" };
      if (currentPhase.status === transition.status) return { status: "same-status" };

      const document = structuredClone(current.document);
      const phase = document.phases[phaseIndex]!;
      const timestamp = chronologicalLifecycleTimestamp(phase, transition.timestamp);
      applyPhaseLifecycleTransition(phase, { ...transition, timestamp }, this.createId);
      document.updatedAt = timestamp;
      const next = await this.commitDocument(paths, current, document, {
        validationMode: "trusted",
        context: "Phase lifecycle commit",
      });
      return {
        status: "ok",
        snapshot: toSnapshot(next),
        phase: structuredClone(phase),
      };
    });
  }

  async recordPhaseLaunchAttention(
    cwd: string,
    phaseId: string,
    reason: string,
    expectedSession?: NotesSessionLink | null,
  ): Promise<ProjectNotesPhaseLifecycleOutcome> {
    return this.recordPhaseLifecycleTransition(cwd, phaseId, {
      status: "needs-attention",
      source: "system",
      reason,
      timestamp: new Date().toISOString(),
      kind: "attention-generic-opened",
      expectedSession,
    });
  }

  private async mutatePhaseLinkFields(
    cwd: string,
    phaseId: string,
    mutate: (phase: NotesPhase) => void,
    expectedSession?: NotesSessionLink,
  ): Promise<ProjectNotesPhaseLinkOutcome> {
    return this.withLockedCurrent(cwd, async (paths, current) => {
      const phaseIndex = current.document.phases.findIndex((phase) => phase.id === phaseId);
      if (phaseIndex < 0) return { status: "phase-not-found" };
      const currentPhase = current.document.phases[phaseIndex]!;
      if (currentPhase.archivedAt !== null) return { status: "phase-archived" };
      if (
        expectedSession !== undefined &&
        !notesSessionLinksEqual(currentPhase.session, expectedSession)
      ) {
        return { status: "stale-session" };
      }
      const document = structuredClone(current.document);
      const phase = document.phases[phaseIndex]!;
      mutate(phase);
      document.updatedAt = new Date().toISOString();
      const next = await this.commitDocument(paths, current, document, {
        validationMode: "trusted",
        context: "Phase session link commit",
      });
      return { status: "ok", snapshot: toSnapshot(next), phase: structuredClone(phase) };
    });
  }

  private async confirmAutomaticPhaseAdvancementLocked(
    paths: ProjectNotesPaths,
    current: StoredProjectNotesV1,
    request: ProjectNotesAutomaticPhaseAdvancementRequest,
  ): Promise<ProjectNotesAutomaticPhaseAdvancementOutcome> {
    const operationId = `automatic-phase-advancement:${request.checkpointId}`;
    const sourcePhaseIndex = current.document.phases.findIndex((phase) =>
      phase.roadmapEvents.some(
        (event) =>
          event.type === "phase-advancement-checkpoint" && event.id === request.checkpointId,
      ),
    );
    if (sourcePhaseIndex < 0) return { status: "stale", reason: "checkpoint-not-found" };
    const sourcePhase = current.document.phases[sourcePhaseIndex]!;
    const checkpoint = sourcePhase.roadmapEvents.find(
      (event): event is NotesRoadmapPhaseAdvancementCheckpoint =>
        event.type === "phase-advancement-checkpoint" && event.id === request.checkpointId,
    )!;
    if ("completionReviewId" in checkpoint && checkpoint.reviewer !== "ken-autopilot") {
      return { status: "stale", reason: "manual-confirmation-required" };
    }
    if (!isCompletionCheckpointAuthoritative(sourcePhase, checkpoint)) {
      return { status: "stale", reason: "completion-not-authoritative" };
    }
    if (!notesSessionLinksEqual(sourcePhase.session, request.destinationSession)) {
      return { status: "stale", reason: "session-mismatch" };
    }

    const sameSessionId = current.document.phases.filter(
      (phase) => phase.session?.sessionId === request.destinationSession.sessionId,
    );
    if (
      sameSessionId.some(
        (phase) => phase.session?.sessionPath !== request.destinationSession.sessionPath,
      )
    ) {
      return { status: "stale", reason: "session-mismatch" };
    }
    const existingConfirmation = sourcePhase.roadmapEvents.find(
      (event): event is NotesRoadmapPhaseAdvancementConfirmation =>
        event.type === "phase-advancement-confirmation" && event.checkpointId === checkpoint.id,
    );
    const targetPhase = current.document.phases.find(
      (phase) => phase.id === checkpoint.nextPhaseId,
    );
    if (existingConfirmation) {
      const eligible = current.document.phases.filter(
        (phase) =>
          phase.id !== sourcePhase.id &&
          phase.archivedAt === null &&
          (phase.status === "not-started" || phase.status === "planning") &&
          phase.overrides.status === null &&
          (phase.session === null ||
            (phase.id === checkpoint.nextPhaseId &&
              notesSessionLinksEqual(phase.session, request.destinationSession))),
      );
      const activeLinks = sameSessionId.filter(
        (phase) =>
          phase.archivedAt === null && phase.status !== "done" && phase.status !== "cancelled",
      );
      if (
        existingConfirmation.actor !== "system" ||
        existingConfirmation.operationId !== operationId ||
        !targetPhase ||
        !notesSessionLinksEqual(targetPhase.session, request.destinationSession) ||
        eligible.length !== 1 ||
        eligible[0]!.id !== targetPhase.id ||
        activeLinks.length !== 1 ||
        activeLinks[0]!.id !== targetPhase.id
      ) {
        return { status: "stale", reason: "checkpoint-confirmed" };
      }
      const { references } = phaseLaunchContext(current.document, targetPhase);
      return {
        status: "already-bound",
        operationId,
        snapshot: toSnapshot(current),
        phase: structuredClone(targetPhase),
        references: structuredClone(references),
        session: { ...request.destinationSession },
      };
    }
    if (current.revision !== request.expectedRevision) {
      return { status: "stale", reason: "stale-revision" };
    }
    const targetIndex = selectNextEligibleRoadmapPhaseIndexForCheckpoint(
      current.document,
      checkpoint,
    );
    if (targetIndex === null) return { status: "stale", reason: "target-ineligible" };
    const currentTarget = current.document.phases[targetIndex]!;
    if (currentTarget.id !== checkpoint.nextPhaseId) {
      return { status: "stale", reason: "target-mismatch" };
    }
    if (
      sameSessionId.some(
        (phase) =>
          phase.id !== sourcePhase.id &&
          phase.archivedAt === null &&
          phase.status !== "done" &&
          phase.status !== "cancelled",
      )
    ) {
      return { status: "stale", reason: "session-in-use" };
    }

    const document = structuredClone(current.document);
    const source = document.phases[sourcePhaseIndex]!;
    const boundPhase = document.phases[targetIndex]!;
    const timestamp = chronologicalRoadmapTimestamp(source, request.timestamp);
    source.roadmapEvents.push({
      type: "phase-advancement-confirmation",
      id: this.createId(),
      checkpointId: checkpoint.id,
      nextPhaseId: checkpoint.nextPhaseId,
      actor: "system",
      operationId,
      timestamp,
    });
    source.updatedAt = timestamp;
    boundPhase.session = { ...request.destinationSession };
    boundPhase.updatedAt = timestamp;
    document.updatedAt = timestamp;
    const next = await this.commitDocument(paths, current, document, {
      validationMode: "validated",
      context: "Automatic phase advancement created invalid Notes",
    });
    const { references } = phaseLaunchContext(document, boundPhase);
    return {
      status: "accepted",
      operationId,
      snapshot: toSnapshot(next),
      phase: structuredClone(boundPhase),
      references: structuredClone(references),
      session: { ...request.destinationSession },
    };
  }

  private async withLockedCurrent<T>(
    cwd: string,
    operation: (paths: ProjectNotesPaths, current: StoredProjectNotesV1) => Promise<T>,
  ): Promise<T | UnavailableCurrentState> {
    const projectKey = canonicalProjectKey(cwd);
    const paths = this.paths(cwd);
    await this.ensureDirectory(paths.directory);
    return this.lock(paths.primary, async () => {
      const current = await this.readCurrent(paths, projectKey);
      if (current.status === "missing" || current.status === "corrupt") return current;
      return operation(paths, current.envelope);
    });
  }

  private async commitDocument(
    paths: ProjectNotesPaths,
    current: StoredProjectNotesV1,
    document: NotesDocumentV3,
    options: CommitDocumentOptions,
  ): Promise<StoredProjectNotesV1> {
    let committedDocument = document;
    if (options.validationMode === "validated") {
      const validation = validateNotesDocumentV3(document);
      if (!validation.ok) {
        throw new Error(`${options.context}: ${validation.error.path}`);
      }
      committedDocument = validation.document;
    }
    const next: StoredProjectNotesV1 = {
      storeVersion: 1,
      projectKey: current.projectKey,
      revision: current.revision + 1,
      document: committedDocument,
    };
    await this.atomicWrite(paths.backup, serializeEnvelope(current));
    await this.atomicWrite(paths.primary, serializeEnvelope(next));
    return next;
  }

  private async ensureDirectory(directory: string): Promise<void> {
    await this.fileSystem.mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
    await this.secureMode(directory, DIRECTORY_MODE);
  }

  private async atomicWrite(destination: string, contents: string): Promise<void> {
    const temporary = `${destination}.${process.pid}.${this.createId()}.tmp`;
    try {
      await this.fileSystem.writeFile(temporary, contents, {
        encoding: "utf8",
        mode: FILE_MODE,
        flag: "wx",
      });
      await this.secureMode(temporary, FILE_MODE);
      await this.syncPath(temporary, "r+");
      await this.fileSystem.rename(temporary, destination);
      await this.secureMode(destination, FILE_MODE);
      await this.syncDirectory(path.dirname(destination));
    } finally {
      await this.fileSystem.unlink(temporary).catch(() => undefined);
    }
  }

  private async syncPath(filePath: string, flags: "r" | "r+"): Promise<void> {
    const handle = await this.fileSystem.open(filePath, flags);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async syncDirectory(directory: string): Promise<void> {
    try {
      await this.syncPath(directory, "r");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !UNSUPPORTED_DIRECTORY_SYNC_CODES.has(code)) throw error;
    }
  }

  private async secureMode(filePath: string, mode: number): Promise<void> {
    try {
      await this.fileSystem.chmod(filePath, mode);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOSYS" && code !== "ENOTSUP" && code !== "EINVAL") throw error;
    }
  }

  private async readCurrent(paths: ProjectNotesPaths, projectKey: string): Promise<CurrentState> {
    const [primary, backup] = await Promise.all([
      this.readCandidate(paths.primary, projectKey),
      this.readCandidate(paths.backup, projectKey),
    ]);
    if (primary.status === "valid") {
      return {
        status: "ok",
        envelope: primary.envelope,
        source: "primary",
        migratedFromV2: primary.migratedFromV2,
      };
    }
    if (backup.status === "valid") {
      return {
        status: "ok",
        envelope: backup.envelope,
        source: "backup",
        migratedFromV2: backup.migratedFromV2,
      };
    }
    if (primary.status === "missing" && backup.status === "missing") return { status: "missing" };
    return {
      status: "corrupt",
      primary: primary.status === "invalid" ? primary.reason : null,
      backup: backup.status === "invalid" ? backup.reason : null,
    };
  }

  private async readCandidate(filePath: string, projectKey: string): Promise<Candidate> {
    let raw: string;
    try {
      raw = await this.fileSystem.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return { status: "invalid", reason: "malformed-json" };
    }
    const parsed = parseStoredEnvelope(value);
    if (!parsed) return { status: "invalid", reason: "invalid-envelope" };
    if (parsed.envelope.projectKey !== projectKey) {
      return { status: "invalid", reason: "project-key-mismatch" };
    }
    return {
      status: "valid",
      envelope: parsed.envelope,
      migratedFromV2: parsed.migratedFromV2,
    };
  }
}

function parseStoredEnvelope(
  value: unknown,
): { envelope: StoredProjectNotesV1; migratedFromV2: boolean } | null {
  if (
    !isRecordWithKeys(value, ENVELOPE_KEYS) ||
    value.storeVersion !== 1 ||
    typeof value.projectKey !== "string" ||
    !Number.isInteger(value.revision) ||
    (value.revision as number) < 0
  ) {
    return null;
  }
  const document = coerceNotesDocumentV3(value.document);
  if (!document.ok) return null;
  return {
    envelope: {
      storeVersion: 1,
      projectKey: value.projectKey,
      revision: value.revision as number,
      document: document.document,
    },
    migratedFromV2: document.migratedLegacyShape === true,
  };
}

function isRecordWithKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length && expectedKeys.every((key) => keys.includes(key));
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function serializeEnvelope(envelope: StoredProjectNotesV1): string {
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

function executionRequiresReconciliation(phase: NotesPhase): boolean {
  return phase.execution?.state === "needs-reconciliation";
}

function manualApprovalFacts(
  current: StoredProjectNotesV1,
  phaseId: string,
  expectedSession: NotesSessionLink,
): Extract<ProjectNotesManualApprovalPreviewOutcome, { status: "ready" | "unmet-gate" }> {
  const phase = current.document.phases.find((candidate) => candidate.id === phaseId);
  if (!phase) {
    return { status: "unmet-gate", revision: current.revision, code: "phase-not-found" };
  }
  if (executionRequiresReconciliation(phase)) {
    return { status: "unmet-gate", revision: current.revision, code: "inactive-phase" };
  }
  const evaluation = evaluateManualCompletionApproval(phase, expectedSession);
  if (evaluation.status !== "eligible") {
    return { status: "unmet-gate", revision: current.revision, code: evaluation.code };
  }
  return {
    status: "ready",
    revision: current.revision,
    projectKey: current.projectKey,
    phaseId,
    session: structuredClone(expectedSession),
    implementationCheckpointId: evaluation.implementationCheckpointId,
    verificationStatusUpdateId: evaluation.verificationStatusUpdateId,
  };
}

function toSnapshot(envelope: StoredProjectNotesV1): ProjectNotesSnapshot {
  return {
    projectKey: envelope.projectKey,
    revision: envelope.revision,
    document: envelope.document,
  };
}
