import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { withFileLock } from "@kenkaiiii/gg-core";
import {
  evaluatePhaseCompletion,
  type PhaseCompletionEvaluation,
} from "./app-sidecar-phase-completion.js";

export type NotesTaskStatus = "todo" | "done";

export interface NotesTask {
  id: string;
  text: string;
  status: NotesTaskStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  archivedAt: string | null;
}

export interface NotesHandoff {
  text: string;
  updatedAt: string | null;
  readAt: string | null;
}

/** Legacy shape accepted only as a v2-to-v3 migration input. */
export interface NotesDocumentV2 {
  version: 2;
  reference: string;
  currentFocus: string;
  tasks: NotesTask[];
  handoff: NotesHandoff;
  updatedAt: string;
  legacyImportedAt: string | null;
}

export type NotesPhaseStatus =
  | "not-started"
  | "planning"
  | "waiting-for-approval"
  | "in-progress"
  | "review"
  | "done"
  | "needs-attention"
  | "cancelled";

export type NotesLifecycleEventSource = "user" | "session" | "agent" | "system";

export interface NotesReferenceRange {
  startLine: number;
  endLine: number;
}

export interface NotesReference {
  id: string;
  provider: string;
  tool: string | null;
  canonicalUrl: string;
  owner: string;
  repo: string;
  revision: string | null;
  path: string | null;
  range: NotesReferenceRange | null;
  issue: number | null;
  pullRequest: number | null;
  query: string | null;
  anchor: string | null;
  relevance: string;
  capturedAt: string;
}

export interface NotesSessionLink {
  sessionId: string;
  sessionPath: string | null;
}

export interface NotesReminder {
  id: string;
  dueAt: string;
  note: string;
  createdAt: string;
}

export interface NotesStatusOverride {
  value: NotesPhaseStatus;
  source: "user";
  updatedAt: string;
}

export interface NotesReferenceIdsOverride {
  value: string[];
  source: "user";
  updatedAt: string;
}

export interface NotesPhaseOverrides {
  status: NotesStatusOverride | null;
  referenceIds: NotesReferenceIdsOverride | null;
}

export interface NotesLifecycleEvent {
  id: string;
  fromStatus: NotesPhaseStatus | null;
  toStatus: NotesPhaseStatus;
  source: NotesLifecycleEventSource;
  timestamp: string;
  reason: string | null;
}

export type NotesRoadmapActor = "gg-coder" | "ken" | "ken-autopilot";
export type NotesRoadmapReviewer = Exclude<NotesRoadmapActor, "gg-coder">;
export type NotesRoadmapTransition = "pending" | "in-progress" | "blocked" | "review";
export type NotesVerificationStatus = "passed" | "failed" | "exception-requested";
export type NotesImplementationRunOutcome = "succeeded" | "failed" | "cancelled" | "interrupted";
export type NotesCompletionGateOutcome =
  | "done"
  | "review"
  | "needs-attention"
  | "waiting-for-approval"
  | "manual-override"
  | "done-terminal";
export type NotesCompletionUnmetGateCode =
  | "missing-implementation"
  | "stale-session"
  | "run-not-successful"
  | "incomplete-plan"
  | "missing-verification"
  | "failed-verification"
  | "verification-exception-not-accepted"
  | "unresolved-approval"
  | "unresolved-attention"
  | "inactive-phase";
export type NotesRoadmapStatusOutcome =
  | "applied"
  | "same-status"
  | "evidence-only"
  | "manual-override"
  | "done-terminal";
export type NotesRoadmapReferencePolicyOutcome =
  | "manual-review"
  | "reference-override-protected"
  | "accepted"
  | "reused";

export interface NotesRoadmapReferenceProposal extends Omit<NotesReference, "id" | "capturedAt"> {
  id: string;
  disposition: "pending" | "accepted" | "reused";
  policyOutcome: NotesRoadmapReferencePolicyOutcome;
  referenceId: string | null;
}

export interface NotesRoadmapStatusUpdate {
  type: "status-update";
  id: string;
  actor: NotesRoadmapActor;
  transition: NotesRoadmapTransition;
  progress: string;
  blocker: string | null;
  evidence: string[];
  verification: NotesVerificationStatus | null;
  verificationReason: string | null;
  verificationSession: NotesSessionLink | null;
  statusOutcome: NotesRoadmapStatusOutcome;
  proposedReferences: NotesRoadmapReferenceProposal[];
  timestamp: string;
}

export interface NotesRoadmapReferenceDecision {
  type: "reference-decision";
  id: string;
  proposalId: string;
  decision: "accepted" | "rejected";
  referenceId: string | null;
  timestamp: string;
}

export interface NotesRoadmapOverrideReset {
  type: "override-reset";
  id: string;
  field: "status" | "references";
  timestamp: string;
}

export interface NotesRoadmapImplementationCheckpoint {
  type: "implementation-checkpoint";
  id: string;
  session: NotesSessionLink;
  planStepTotal: number;
  completedPlanSteps: number[];
  runOutcome: NotesImplementationRunOutcome;
  timestamp: string;
}

export interface NotesRoadmapCompletionReview {
  type: "completion-review";
  id: string;
  reviewer: NotesRoadmapReviewer;
  decision: "accepted" | "rejected";
  evidence: string[];
  reason: string | null;
  implementationCheckpointId: string | null;
  verificationStatusUpdateId: string | null;
  acceptsVerificationException: boolean;
  gateOutcome: NotesCompletionGateOutcome;
  unmetGateCodes: NotesCompletionUnmetGateCode[];
  timestamp: string;
}

export type NotesRoadmapEvent =
  | NotesRoadmapStatusUpdate
  | NotesRoadmapReferenceDecision
  | NotesRoadmapOverrideReset
  | NotesRoadmapImplementationCheckpoint
  | NotesRoadmapCompletionReview;

export interface NotesPhase {
  id: string;
  title: string;
  goal: string;
  doneWhen: string[];
  order: number;
  status: NotesPhaseStatus;
  sourcePrompt: string;
  referenceIds: string[];
  session: NotesSessionLink | null;
  reminder: NotesReminder | null;
  attentionReason: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  archivedAt: string | null;
  overrides: NotesPhaseOverrides;
  lifecycleEvents: NotesLifecycleEvent[];
  roadmapEvents: NotesRoadmapEvent[];
}

export interface NotesDocumentV3 {
  version: 3;
  reference: string;
  currentFocus: string;
  tasks: NotesTask[];
  handoff: NotesHandoff;
  updatedAt: string;
  legacyImportedAt: string | null;
  phases: NotesPhase[];
  references: NotesReference[];
}

export interface NotesValidationError {
  path: string;
  message: string;
}

export type NotesValidationResult =
  | { ok: true; document: NotesDocumentV3 }
  | { ok: false; error: NotesValidationError };

export interface StoredProjectNotesV1 {
  storeVersion: 1;
  projectKey: string;
  revision: number;
  document: NotesDocumentV3;
}

export interface ProjectNotesSnapshot {
  projectKey: string;
  revision: number;
  document: NotesDocumentV3;
}
export type ProjectNotesCorruptReason =
  | "malformed-json"
  | "invalid-envelope"
  | "project-key-mismatch";

export interface ProjectNotesCorruption {
  primary: ProjectNotesCorruptReason | null;
  backup: ProjectNotesCorruptReason | null;
}

export type ProjectNotesLoadOutcome =
  | { status: "ok"; snapshot: ProjectNotesSnapshot; recoveredFromBackup: boolean }
  | { status: "missing" }
  | ({ status: "corrupt" } & ProjectNotesCorruption);

export type ProjectNotesMigrationOutcome =
  | { status: "ok"; snapshot: ProjectNotesSnapshot; migrated: boolean }
  | ({ status: "corrupt" } & ProjectNotesCorruption)
  | { status: "invalid"; error: NotesValidationError };

export type ProjectNotesSaveOutcome =
  | { status: "ok"; snapshot: ProjectNotesSnapshot }
  | { status: "conflict"; snapshot: ProjectNotesSnapshot }
  | { status: "missing" }
  | ({ status: "corrupt" } & ProjectNotesCorruption)
  | { status: "invalid"; error: NotesValidationError };
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
  | { status: "missing" }
  | ({ status: "corrupt" } & ProjectNotesCorruption);

export type ProjectNotesPhaseLinkOutcome =
  | { status: "ok"; snapshot: ProjectNotesSnapshot; phase: NotesPhase }
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
  expectedSession?: NotesSessionLink | null;
}

export type ProjectNotesPhaseLifecycleOutcome =
  | { status: "ok"; snapshot: ProjectNotesSnapshot; phase: NotesPhase }
  | {
      status:
        | "same-status"
        | "manual-override"
        | "phase-not-found"
        | "phase-archived"
        | "stale-session"
        | "done-terminal";
    }
  | { status: "missing" }
  | ({ status: "corrupt" } & ProjectNotesCorruption);

export interface ProjectNotesRoadmapStatusRequest {
  updateId: string;
  phaseId: string;
  expectedRevision?: number;
  actor: NotesRoadmapActor;
  transition: NotesRoadmapTransition;
  progress: string;
  blocker: string | null;
  evidence: string[];
  verification: NotesVerificationStatus | null;
  verificationReason: string | null;
  proposedReferences: Array<Omit<NotesReference, "id" | "capturedAt">>;
  timestamp: string;
  expectedSession?: NotesSessionLink | null;
  requireBoundPhase?: boolean;
  autopilotEnabled: boolean;
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
  | { status: "duplicate-id-conflict"; revision: number }
  | { status: "invalid-checkpoint"; message: string }
  | { status: "phase-not-found" | "phase-archived" | "stale-session" }
  | { status: "missing" }
  | ({ status: "corrupt" } & ProjectNotesCorruption);

export interface ProjectNotesCompletionReviewRequest {
  reviewId: string;
  phaseId: string;
  expectedSession: NotesSessionLink;
  reviewer: NotesRoadmapReviewer;
  decision: "accepted" | "rejected";
  evidence: string[];
  reason: string | null;
  acceptsVerificationException: boolean;
  timestamp: string;
}

export type ProjectNotesCompletionReviewOutcome =
  | {
      status: "committed";
      snapshot: ProjectNotesSnapshot;
      phase: NotesPhase;
      evaluation: PhaseCompletionEvaluation;
    }
  | {
      status: "duplicate";
      revision: number;
      phaseId: string;
      evaluation: PhaseCompletionEvaluation;
    }
  | { status: "duplicate-id-conflict"; revision: number }
  | { status: "invalid-review"; message: string }
  | { status: "phase-not-found" | "phase-archived" | "stale-session" }
  | { status: "missing" }
  | ({ status: "corrupt" } & ProjectNotesCorruption);

export interface ProjectNotesRoadmapFinalReviewRequest {
  statusUpdate: ProjectNotesRoadmapStatusRequest;
  review: Omit<
    ProjectNotesCompletionReviewRequest,
    "phaseId" | "expectedSession" | "reviewer" | "timestamp"
  >;
}

export type ProjectNotesRoadmapFinalReviewOutcome =
  | {
      status: "committed";
      snapshot: ProjectNotesSnapshot;
      phase: NotesPhase;
      statusOutcome: NotesRoadmapStatusOutcome;
      proposals: ProjectNotesRoadmapProposalOutcome[];
      evaluation: PhaseCompletionEvaluation;
    }
  | {
      status: "duplicate";
      revision: number;
      phaseId: string;
      statusOutcome: NotesRoadmapStatusOutcome;
      proposals: ProjectNotesRoadmapProposalOutcome[];
      evaluation: PhaseCompletionEvaluation;
    }
  | { status: "duplicate-id-conflict" | "stale-revision"; revision: number }
  | { status: "invalid-review"; message: string }
  | {
      status: "phase-not-found" | "phase-archived" | "phase-not-bound" | "stale-session";
    }
  | { status: "invalid-reference"; path: string; message: string }
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
      statusOutcome: NotesRoadmapStatusOutcome;
      proposals: ProjectNotesRoadmapProposalOutcome[];
    }
  | { status: "duplicate-id-conflict"; revision: number }
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

export const NOTES_REFERENCE_URL_MAX_LENGTH = 2_048;
export const NOTES_REFERENCE_METADATA_MAX_LENGTH = 4_096;
export const NOTES_PHASE_LIFECYCLE_REASON_MAX_LENGTH = 240;
export const NOTES_REFERENCE_METADATA_FIELDS = [
  "provider",
  "tool",
  "owner",
  "repo",
  "revision",
  "path",
  "query",
  "anchor",
  "relevance",
] as const satisfies readonly (keyof NotesReference)[];

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
const DOCUMENT_V2_KEYS = [
  "version",
  "reference",
  "currentFocus",
  "tasks",
  "handoff",
  "updatedAt",
  "legacyImportedAt",
];
const DOCUMENT_V3_KEYS = [...DOCUMENT_V2_KEYS, "phases", "references"];
const TASK_KEYS = ["id", "text", "status", "createdAt", "updatedAt", "completedAt", "archivedAt"];
const HANDOFF_KEYS = ["text", "updatedAt", "readAt"];
const REFERENCE_KEYS = [
  "id",
  "provider",
  "tool",
  "canonicalUrl",
  "owner",
  "repo",
  "revision",
  "path",
  "range",
  "issue",
  "pullRequest",
  "query",
  "anchor",
  "relevance",
  "capturedAt",
];
const REFERENCE_RANGE_KEYS = ["startLine", "endLine"];
const PHASE_KEYS = [
  "id",
  "title",
  "goal",
  "doneWhen",
  "order",
  "status",
  "sourcePrompt",
  "referenceIds",
  "session",
  "reminder",
  "attentionReason",
  "createdAt",
  "updatedAt",
  "completedAt",
  "archivedAt",
  "overrides",
  "lifecycleEvents",
  "roadmapEvents",
];
const LEGACY_V3_PHASE_REQUIRED_KEYS = PHASE_KEYS.filter(
  (key) => key !== "archivedAt" && key !== "roadmapEvents",
);
const SESSION_KEYS = ["sessionId", "sessionPath"];
const REMINDER_KEYS = ["id", "dueAt", "note", "createdAt"];
const OVERRIDES_KEYS = ["status", "referenceIds"];
const STATUS_OVERRIDE_KEYS = ["value", "source", "updatedAt"];
const REFERENCE_IDS_OVERRIDE_KEYS = ["value", "source", "updatedAt"];
const LIFECYCLE_EVENT_KEYS = ["id", "fromStatus", "toStatus", "source", "timestamp", "reason"];
const LEGACY_ROADMAP_STATUS_UPDATE_KEYS = [
  "type",
  "id",
  "actor",
  "transition",
  "progress",
  "blocker",
  "evidence",
  "statusOutcome",
  "proposedReferences",
  "timestamp",
];
const UNBOUND_VERIFICATION_ROADMAP_STATUS_UPDATE_KEYS = [
  ...LEGACY_ROADMAP_STATUS_UPDATE_KEYS,
  "verification",
  "verificationReason",
];
const ROADMAP_STATUS_UPDATE_KEYS = [
  ...UNBOUND_VERIFICATION_ROADMAP_STATUS_UPDATE_KEYS,
  "verificationSession",
];
const ROADMAP_REFERENCE_DECISION_KEYS = [
  "type",
  "id",
  "proposalId",
  "decision",
  "referenceId",
  "timestamp",
];
const ROADMAP_OVERRIDE_RESET_KEYS = ["type", "id", "field", "timestamp"];
const ROADMAP_IMPLEMENTATION_CHECKPOINT_KEYS = [
  "type",
  "id",
  "session",
  "planStepTotal",
  "completedPlanSteps",
  "runOutcome",
  "timestamp",
];
const ROADMAP_COMPLETION_REVIEW_KEYS = [
  "type",
  "id",
  "reviewer",
  "decision",
  "evidence",
  "reason",
  "implementationCheckpointId",
  "verificationStatusUpdateId",
  "acceptsVerificationException",
  "gateOutcome",
  "unmetGateCodes",
  "timestamp",
];
const LEGACY_ROADMAP_PROPOSAL_KEYS = [
  "id",
  "provider",
  "tool",
  "canonicalUrl",
  "owner",
  "repo",
  "revision",
  "path",
  "range",
  "issue",
  "pullRequest",
  "query",
  "anchor",
  "relevance",
  "disposition",
  "referenceId",
];
const ROADMAP_PROPOSAL_KEYS = [...LEGACY_ROADMAP_PROPOSAL_KEYS, "policyOutcome"];
const PHASE_STATUSES = new Set<NotesPhaseStatus>([
  "not-started",
  "planning",
  "waiting-for-approval",
  "in-progress",
  "review",
  "done",
  "needs-attention",
  "cancelled",
]);
const LIFECYCLE_EVENT_SOURCES = new Set<NotesLifecycleEventSource>([
  "user",
  "session",
  "agent",
  "system",
]);
const ROADMAP_ACTORS = new Set<NotesRoadmapActor>(["gg-coder", "ken", "ken-autopilot"]);
const ROADMAP_TRANSITIONS = new Set<NotesRoadmapTransition>([
  "pending",
  "in-progress",
  "blocked",
  "review",
]);
const ROADMAP_STATUS_OUTCOMES = new Set<NotesRoadmapStatusOutcome>([
  "applied",
  "same-status",
  "evidence-only",
  "manual-override",
  "done-terminal",
]);
const VERIFICATION_STATUSES = new Set<NotesVerificationStatus>([
  "passed",
  "failed",
  "exception-requested",
]);
const IMPLEMENTATION_RUN_OUTCOMES = new Set<NotesImplementationRunOutcome>([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);
const COMPLETION_GATE_OUTCOMES = new Set<NotesCompletionGateOutcome>([
  "done",
  "review",
  "needs-attention",
  "waiting-for-approval",
  "manual-override",
  "done-terminal",
]);
const COMPLETION_UNMET_GATE_CODES = new Set<NotesCompletionUnmetGateCode>([
  "missing-implementation",
  "stale-session",
  "run-not-successful",
  "incomplete-plan",
  "missing-verification",
  "failed-verification",
  "verification-exception-not-accepted",
  "unresolved-approval",
  "unresolved-attention",
  "inactive-phase",
]);

export function canonicalProjectKey(cwd: string): string {
  const normalized = cwd.replace(/\\/g, "/");
  const driveMatch = /^([A-Za-z]):(?:\/|$)/.exec(normalized);

  if (driveMatch) {
    const drive = `${driveMatch[1]!.toLowerCase()}:`;
    const remainder = normalized.slice(driveMatch[0].length);
    const segments = resolveSegments(remainder.split("/"), true);
    return segments.length === 0 ? `${drive}/` : `${drive}/${segments.join("/")}`.toLowerCase();
  }

  if (normalized.startsWith("//")) {
    const parts = normalized.slice(2).split("/").filter(Boolean);
    const rootParts = parts.slice(0, 2);
    const segments = resolveSegments(parts.slice(2), true);
    return `//${[...rootParts, ...segments].join("/")}`.toLowerCase();
  }

  const absolute = normalized.startsWith("/");
  const segments = resolveSegments(normalized.split("/"), absolute);
  const result = `${absolute ? "/" : ""}${segments.join("/")}`;
  return result || (absolute ? "/" : ".");
}

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

export function isNotesDocumentV2(value: unknown): value is NotesDocumentV2 {
  return validateNotesDocumentV2(value) === null;
}

export function migrateNotesDocumentV2(value: unknown): NotesValidationResult {
  const error = validateNotesDocumentV2(value);
  if (error) return { ok: false, error };
  const legacy = value as NotesDocumentV2;
  return {
    ok: true,
    document: {
      ...legacy,
      version: 3,
      tasks: stabilizeMigratedTaskIds(legacy.tasks),
      phases: [],
      references: [],
    },
  };
}

export function isNotesDocumentV3(value: unknown): value is NotesDocumentV3 {
  return validateNotesDocumentV3(value).ok;
}

export function validateNotesDocumentV3(value: unknown): NotesValidationResult {
  if (!isRecordWithKeys(value, DOCUMENT_V3_KEYS)) {
    return invalid("$", `expected exactly: ${DOCUMENT_V3_KEYS.join(", ")}`);
  }
  if (value.version !== 3) return invalid("version", "expected 3");
  const existingError = validateExistingNotesFields(value, true);
  if (existingError) return { ok: false, error: existingError };
  if (!Array.isArray(value.references)) return invalid("references", "expected an array");
  if (!Array.isArray(value.phases)) return invalid("phases", "expected an array");

  const referenceIds = new Set<string>();
  const referenceIdentities = new Map<string, number>();
  for (let index = 0; index < value.references.length; index += 1) {
    const referenceError = validateReference(value.references[index], `references[${index}]`);
    if (referenceError) return { ok: false, error: referenceError };
    const reference = value.references[index] as NotesReference;
    const id = reference.id;
    if (referenceIds.has(id)) return invalid(`references[${index}].id`, `duplicate ID: ${id}`);
    referenceIds.add(id);
    const identity = canonicalReferenceIdentity(reference)!;
    const duplicateIndex = referenceIdentities.get(identity);
    if (duplicateIndex !== undefined) {
      return invalid(
        `references[${index}].canonicalUrl`,
        `duplicate canonical source; already saved at references[${duplicateIndex}]`,
      );
    }
    referenceIdentities.set(identity, index);
  }

  const phaseIds = new Set<string>();
  for (let index = 0; index < value.phases.length; index += 1) {
    const phase = value.phases[index];
    const phaseError = validatePhase(phase, index, referenceIds);
    if (phaseError) return { ok: false, error: phaseError };
    const id = (phase as NotesPhase).id;
    if (phaseIds.has(id)) return invalid(`phases[${index}].id`, `duplicate ID: ${id}`);
    phaseIds.add(id);
  }

  return { ok: true, document: value as unknown as NotesDocumentV3 };
}

function validateNotesDocumentV2(value: unknown): NotesValidationError | null {
  if (!isRecordWithKeys(value, DOCUMENT_V2_KEYS)) {
    return validationError("$", `expected exactly: ${DOCUMENT_V2_KEYS.join(", ")}`);
  }
  if (value.version !== 2) return validationError("version", "expected 2");
  return validateExistingNotesFields(value, false);
}

function validateExistingNotesFields(
  value: Record<string, unknown>,
  requireStableTaskIds: boolean,
): NotesValidationError | null {
  if (typeof value.reference !== "string") return validationError("reference", "expected a string");
  if (typeof value.currentFocus !== "string") {
    return validationError("currentFocus", "expected a string");
  }
  if (!Array.isArray(value.tasks)) return validationError("tasks", "expected an array");
  const taskIds = new Set<string>();
  for (let index = 0; index < value.tasks.length; index += 1) {
    const task = value.tasks[index];
    if (!isNotesTask(task)) return validationError(`tasks[${index}]`, "invalid task record");
    if (requireStableTaskIds) {
      if (!isNonEmptyString(task.id)) {
        return validationError(`tasks[${index}].id`, "expected a stable ID");
      }
      if (taskIds.has(task.id)) {
        return validationError(`tasks[${index}].id`, `duplicate ID: ${task.id}`);
      }
      taskIds.add(task.id);
    }
  }
  if (!isNotesHandoff(value.handoff)) return validationError("handoff", "invalid handoff record");
  if (!isTimestamp(value.updatedAt))
    return validationError("updatedAt", "expected an ISO timestamp");
  if (!isNullableTimestamp(value.legacyImportedAt)) {
    return validationError("legacyImportedAt", "expected an ISO timestamp or null");
  }
  return null;
}

function stabilizeMigratedTaskIds(tasks: NotesTask[]): NotesTask[] {
  const reservedIds = new Set(tasks.map((task) => task.id).filter(isNonEmptyString));
  const assignedIds = new Set<string>();
  return tasks.map((task, index) => {
    if (isNonEmptyString(task.id) && !assignedIds.has(task.id)) {
      assignedIds.add(task.id);
      return task;
    }

    const baseId = `legacy-task-${index + 1}`;
    let id = baseId;
    let suffix = 2;
    while (reservedIds.has(id) || assignedIds.has(id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    assignedIds.add(id);
    return { ...task, id };
  });
}

function validateReference(value: unknown, pathPrefix: string): NotesValidationError | null {
  if (!isRecordWithKeys(value, REFERENCE_KEYS)) {
    return validationError(pathPrefix, `expected exactly: ${REFERENCE_KEYS.join(", ")}`);
  }
  if (!isNonEmptyString(value.id))
    return validationError(`${pathPrefix}.id`, "expected a stable ID");
  if (!isNonEmptyString(value.provider)) {
    return validationError(`${pathPrefix}.provider`, "expected a provider name");
  }
  if (isReferenceMetadataTooLong(value.provider)) {
    return referenceMetadataLengthError(`${pathPrefix}.provider`);
  }
  const nullableStringFields = ["tool", "revision", "path", "query", "anchor"] as const;
  for (const field of nullableStringFields) {
    if (!isNullableNonEmptyString(value[field])) {
      return validationError(`${pathPrefix}.${field}`, "expected a non-empty string or null");
    }
    if (isReferenceMetadataTooLong(value[field])) {
      return referenceMetadataLengthError(`${pathPrefix}.${field}`);
    }
  }
  if (
    typeof value.canonicalUrl === "string" &&
    value.canonicalUrl.length > NOTES_REFERENCE_URL_MAX_LENGTH
  ) {
    return validationError(
      `${pathPrefix}.canonicalUrl`,
      `expected ${NOTES_REFERENCE_URL_MAX_LENGTH.toLocaleString("en-US")} characters or fewer`,
    );
  }
  if (!isCanonicalHttpUrl(value.canonicalUrl)) {
    return validationError(
      `${pathPrefix}.canonicalUrl`,
      "expected an absolute http(s) URL without username or password",
    );
  }
  if (!isNonEmptyString(value.owner)) {
    return validationError(`${pathPrefix}.owner`, "repository owner is required");
  }
  if (isReferenceMetadataTooLong(value.owner)) {
    return referenceMetadataLengthError(`${pathPrefix}.owner`);
  }
  if (!isNonEmptyString(value.repo)) {
    return validationError(`${pathPrefix}.repo`, "repository name is required");
  }
  if (isReferenceMetadataTooLong(value.repo)) {
    return referenceMetadataLengthError(`${pathPrefix}.repo`);
  }
  if (value.range !== null) {
    if (!isRecordWithKeys(value.range, REFERENCE_RANGE_KEYS)) {
      return validationError(`${pathPrefix}.range`, "expected startLine and endLine or null");
    }
    if (!isPositiveInteger(value.range.startLine)) {
      return validationError(`${pathPrefix}.range.startLine`, "expected a positive integer");
    }
    if (!isPositiveInteger(value.range.endLine) || value.range.endLine < value.range.startLine) {
      return validationError(
        `${pathPrefix}.range.endLine`,
        "expected an integer at or after startLine",
      );
    }
    if (value.path === null) {
      return validationError(`${pathPrefix}.path`, "path is required when range is present");
    }
  }
  if (!isNullablePositiveInteger(value.issue)) {
    return validationError(`${pathPrefix}.issue`, "expected a positive integer or null");
  }
  if (!isNullablePositiveInteger(value.pullRequest)) {
    return validationError(`${pathPrefix}.pullRequest`, "expected a positive integer or null");
  }
  if (value.issue !== null && value.pullRequest !== null) {
    return validationError(
      `${pathPrefix}.pullRequest`,
      "a reference cannot target both an issue and a pull request",
    );
  }
  const semanticError = validateReferenceCoordinates(
    value as unknown as NotesReference,
    pathPrefix,
  );
  if (semanticError) return semanticError;
  if (typeof value.relevance !== "string") {
    return validationError(`${pathPrefix}.relevance`, "expected a string");
  }
  if (isReferenceMetadataTooLong(value.relevance)) {
    return referenceMetadataLengthError(`${pathPrefix}.relevance`);
  }
  if (!isTimestamp(value.capturedAt)) {
    return validationError(`${pathPrefix}.capturedAt`, "expected an ISO timestamp");
  }
  return null;
}

function validateReferenceCoordinates(
  reference: NotesReference,
  pathPrefix: string,
): NotesValidationError | null {
  if (reference.provider.trim().toLowerCase() !== "github") return null;
  const normalized = normalizeCanonicalUrl(reference.canonicalUrl)!;
  const url = new URL(normalized);
  if (url.hostname !== "github.com") {
    return validationError(
      `${pathPrefix}.canonicalUrl`,
      "GitHub references must use a github.com URL",
    );
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (
    segments.length < 2 ||
    segments[0]!.toLowerCase() !== reference.owner.trim().toLowerCase() ||
    segments[1]!.replace(/\.git$/i, "").toLowerCase() !==
      reference.repo
        .trim()
        .replace(/\.git$/i, "")
        .toLowerCase()
  ) {
    return validationError(
      `${pathPrefix}.canonicalUrl`,
      "URL owner and repository must match the stored repository",
    );
  }
  const directNumber = segments[3] && /^\d+$/.test(segments[3]) ? Number(segments[3]) : null;
  if (segments[2] === "issues" && directNumber !== null && reference.issue !== directNumber) {
    return validationError(
      `${pathPrefix}.issue`,
      `expected ${directNumber} to match the issue URL`,
    );
  }
  if (segments[2] === "pull" && directNumber !== null && reference.pullRequest !== directNumber) {
    return validationError(
      `${pathPrefix}.pullRequest`,
      `expected ${directNumber} to match the pull request URL`,
    );
  }
  return null;
}

function validatePhase(
  value: unknown,
  index: number,
  knownReferenceIds: ReadonlySet<string>,
): NotesValidationError | null {
  const pathPrefix = `phases[${index}]`;
  if (!isRecordWithKeys(value, PHASE_KEYS)) {
    return validationError(pathPrefix, `expected exactly: ${PHASE_KEYS.join(", ")}`);
  }
  if (!isNonEmptyString(value.id))
    return validationError(`${pathPrefix}.id`, "expected a stable ID");
  if (!isNonEmptyString(value.title))
    return validationError(`${pathPrefix}.title`, "title is required");
  if (typeof value.goal !== "string")
    return validationError(`${pathPrefix}.goal`, "expected a string");
  if (!Array.isArray(value.doneWhen) || !value.doneWhen.every(isNonEmptyString)) {
    return validationError(`${pathPrefix}.doneWhen`, "expected non-empty criteria strings");
  }
  if (value.order !== index) {
    return validationError(`${pathPrefix}.order`, `expected ${index} to match array order`);
  }
  if (!isPhaseStatus(value.status)) {
    return validationError(`${pathPrefix}.status`, "unknown phase status");
  }
  if (typeof value.sourcePrompt !== "string") {
    return validationError(`${pathPrefix}.sourcePrompt`, "expected a string");
  }
  const referenceIdsError = validateReferenceIds(
    value.referenceIds,
    `${pathPrefix}.referenceIds`,
    knownReferenceIds,
  );
  if (referenceIdsError) return referenceIdsError;
  const sessionError = validateSession(value.session, `${pathPrefix}.session`);
  if (sessionError) return sessionError;
  const reminderError = validateReminder(value.reminder, `${pathPrefix}.reminder`);
  if (reminderError) return reminderError;
  if (!isNullableNonEmptyString(value.attentionReason)) {
    return validationError(`${pathPrefix}.attentionReason`, "expected a non-empty string or null");
  }
  if (!isTimestamp(value.createdAt)) {
    return validationError(`${pathPrefix}.createdAt`, "expected an ISO timestamp");
  }
  if (!isTimestamp(value.updatedAt)) {
    return validationError(`${pathPrefix}.updatedAt`, "expected an ISO timestamp");
  }
  if (!isNullableTimestamp(value.completedAt)) {
    return validationError(`${pathPrefix}.completedAt`, "expected an ISO timestamp or null");
  }
  if (!isNullableTimestamp(value.archivedAt)) {
    return validationError(`${pathPrefix}.archivedAt`, "expected an ISO timestamp or null");
  }
  const overridesError = validateOverrides(
    value.overrides,
    `${pathPrefix}.overrides`,
    knownReferenceIds,
  );
  if (overridesError) return overridesError;
  const lifecycleError = validateLifecycleEvents(
    value.lifecycleEvents,
    `${pathPrefix}.lifecycleEvents`,
    value.status,
  );
  if (lifecycleError) return lifecycleError;
  return validateRoadmapEvents(
    value.roadmapEvents,
    `${pathPrefix}.roadmapEvents`,
    knownReferenceIds,
  );
}

function validateReferenceIds(
  value: unknown,
  pathPrefix: string,
  knownReferenceIds: ReadonlySet<string>,
): NotesValidationError | null {
  if (!Array.isArray(value))
    return validationError(pathPrefix, "expected an array of reference IDs");
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const id = value[index];
    if (!isNonEmptyString(id))
      return validationError(`${pathPrefix}[${index}]`, "expected a stable ID");
    if (seen.has(id)) return validationError(`${pathPrefix}[${index}]`, `duplicate link: ${id}`);
    if (!knownReferenceIds.has(id))
      return validationError(`${pathPrefix}[${index}]`, `unknown reference ID: ${id}`);
    seen.add(id);
  }
  return null;
}

function validateSession(value: unknown, pathPrefix: string): NotesValidationError | null {
  if (value === null) return null;
  if (!isRecordWithKeys(value, SESSION_KEYS)) {
    return validationError(pathPrefix, "expected sessionId and sessionPath or null");
  }
  if (!isNonEmptyString(value.sessionId)) {
    return validationError(`${pathPrefix}.sessionId`, "session ID is required");
  }
  if (!isNullableNonEmptyString(value.sessionPath)) {
    return validationError(`${pathPrefix}.sessionPath`, "expected a non-empty path or null");
  }
  return null;
}

function validateReminder(value: unknown, pathPrefix: string): NotesValidationError | null {
  if (value === null) return null;
  if (!isRecordWithKeys(value, REMINDER_KEYS)) {
    return validationError(pathPrefix, "expected id, dueAt, note, and createdAt or null");
  }
  if (!isNonEmptyString(value.id))
    return validationError(`${pathPrefix}.id`, "reminder ID is required");
  if (!isTimestamp(value.dueAt))
    return validationError(`${pathPrefix}.dueAt`, "expected an ISO timestamp");
  if (typeof value.note !== "string")
    return validationError(`${pathPrefix}.note`, "expected a string");
  if (!isTimestamp(value.createdAt)) {
    return validationError(`${pathPrefix}.createdAt`, "expected an ISO timestamp");
  }
  return null;
}

function validateOverrides(
  value: unknown,
  pathPrefix: string,
  knownReferenceIds: ReadonlySet<string>,
): NotesValidationError | null {
  if (!isRecordWithKeys(value, OVERRIDES_KEYS)) {
    return validationError(pathPrefix, "expected status and referenceIds override markers");
  }
  if (value.status !== null) {
    if (!isRecordWithKeys(value.status, STATUS_OVERRIDE_KEYS)) {
      return validationError(`${pathPrefix}.status`, "invalid status override marker");
    }
    if (!isPhaseStatus(value.status.value)) {
      return validationError(`${pathPrefix}.status.value`, "unknown phase status");
    }
    if (value.status.source !== "user") {
      return validationError(`${pathPrefix}.status.source`, "expected user");
    }
    if (!isTimestamp(value.status.updatedAt)) {
      return validationError(`${pathPrefix}.status.updatedAt`, "expected an ISO timestamp");
    }
  }
  if (value.referenceIds !== null) {
    if (!isRecordWithKeys(value.referenceIds, REFERENCE_IDS_OVERRIDE_KEYS)) {
      return validationError(`${pathPrefix}.referenceIds`, "invalid reference override marker");
    }
    const idsError = validateReferenceIds(
      value.referenceIds.value,
      `${pathPrefix}.referenceIds.value`,
      knownReferenceIds,
    );
    if (idsError) return idsError;
    if (value.referenceIds.source !== "user") {
      return validationError(`${pathPrefix}.referenceIds.source`, "expected user");
    }
    if (!isTimestamp(value.referenceIds.updatedAt)) {
      return validationError(`${pathPrefix}.referenceIds.updatedAt`, "expected an ISO timestamp");
    }
  }
  return null;
}

function validateLifecycleEvents(
  value: unknown,
  pathPrefix: string,
  phaseStatus: NotesPhaseStatus,
): NotesValidationError | null {
  if (!Array.isArray(value))
    return validationError(pathPrefix, "expected an append-only event array");
  const ids = new Set<string>();
  let previousStatus: NotesPhaseStatus | null | undefined;
  let previousTimestamp = -Infinity;
  for (let index = 0; index < value.length; index += 1) {
    const event = value[index];
    const eventPath = `${pathPrefix}[${index}]`;
    if (!isRecordWithKeys(event, LIFECYCLE_EVENT_KEYS)) {
      return validationError(eventPath, "invalid lifecycle transition record");
    }
    if (!isNonEmptyString(event.id))
      return validationError(`${eventPath}.id`, "event ID is required");
    if (ids.has(event.id)) return validationError(`${eventPath}.id`, `duplicate ID: ${event.id}`);
    ids.add(event.id);
    if (event.fromStatus !== null && !isPhaseStatus(event.fromStatus)) {
      return validationError(`${eventPath}.fromStatus`, "unknown phase status");
    }
    if (!isPhaseStatus(event.toStatus)) {
      return validationError(`${eventPath}.toStatus`, "unknown phase status");
    }
    if (event.fromStatus === event.toStatus) {
      return validationError(eventPath, "transition must change status");
    }
    if (previousStatus !== undefined && event.fromStatus !== previousStatus) {
      return validationError(`${eventPath}.fromStatus`, `expected ${previousStatus}`);
    }
    if (!isLifecycleEventSource(event.source)) {
      return validationError(`${eventPath}.source`, "unknown lifecycle event source");
    }
    if (!isTimestamp(event.timestamp)) {
      return validationError(`${eventPath}.timestamp`, "expected an ISO timestamp");
    }
    const timestamp = Date.parse(event.timestamp);
    if (timestamp < previousTimestamp) {
      return validationError(`${eventPath}.timestamp`, "events must be chronological");
    }
    if (!isNullableNonEmptyString(event.reason)) {
      return validationError(`${eventPath}.reason`, "expected a non-empty string or null");
    }
    previousStatus = event.toStatus;
    previousTimestamp = timestamp;
  }
  if (value.length > 0 && previousStatus !== phaseStatus) {
    return validationError(pathPrefix, `last event must end at phase status ${phaseStatus}`);
  }
  return null;
}

function validateRoadmapEvents(
  value: unknown,
  pathPrefix: string,
  knownReferenceIds: ReadonlySet<string>,
): NotesValidationError | null {
  if (!Array.isArray(value)) {
    return validationError(pathPrefix, "expected an append-only event array");
  }
  const eventIds = new Set<string>();
  const proposalIds = new Set<string>();
  const pendingProposalIds = new Set<string>();
  const decidedProposalIds = new Set<string>();
  const implementationCheckpoints = new Map<string, NotesRoadmapImplementationCheckpoint>();
  const implementationCheckpointIndexes = new Map<string, number>();
  const verificationUpdates = new Map<string, NotesRoadmapStatusUpdate>();
  const verificationUpdateIndexes = new Map<string, number>();
  let latestRejectedReviewIndex = -1;
  let previousTimestamp = -Infinity;

  for (let index = 0; index < value.length; index += 1) {
    const event = value[index];
    const eventPath = `${pathPrefix}[${index}]`;
    if (typeof event !== "object" || event === null || Array.isArray(event)) {
      return validationError(eventPath, "invalid roadmap event record");
    }
    const record = event as Record<string, unknown>;
    if (!isNonEmptyString(record.id)) {
      return validationError(`${eventPath}.id`, "event ID is required");
    }
    if (eventIds.has(record.id)) {
      return validationError(`${eventPath}.id`, `duplicate ID: ${record.id}`);
    }
    eventIds.add(record.id);
    if (!isTimestamp(record.timestamp)) {
      return validationError(`${eventPath}.timestamp`, "expected an ISO timestamp");
    }
    const timestamp = Date.parse(record.timestamp);
    if (timestamp < previousTimestamp) {
      return validationError(`${eventPath}.timestamp`, "events must be chronological");
    }
    previousTimestamp = timestamp;

    if (record.type === "status-update") {
      if (!isRecordWithKeys(record, ROADMAP_STATUS_UPDATE_KEYS)) {
        return validationError(eventPath, "invalid roadmap status update");
      }
      if (
        typeof record.actor !== "string" ||
        !ROADMAP_ACTORS.has(record.actor as NotesRoadmapActor)
      ) {
        return validationError(`${eventPath}.actor`, "unknown roadmap actor");
      }
      if (
        typeof record.transition !== "string" ||
        !ROADMAP_TRANSITIONS.has(record.transition as NotesRoadmapTransition)
      ) {
        return validationError(`${eventPath}.transition`, "unknown roadmap transition");
      }
      if (!isBoundedNonEmptyString(record.progress, 4_096)) {
        return validationError(`${eventPath}.progress`, "expected 1 to 4,096 characters");
      }
      if (record.transition === "blocked") {
        if (!isBoundedNonEmptyString(record.blocker, 1_024)) {
          return validationError(`${eventPath}.blocker`, "blocked reports require a blocker");
        }
      } else if (record.blocker !== null) {
        return validationError(
          `${eventPath}.blocker`,
          "only blocked reports may include a blocker",
        );
      }
      if (
        !Array.isArray(record.evidence) ||
        record.evidence.length > 20 ||
        !record.evidence.every((item) => isBoundedNonEmptyString(item, 4_096))
      ) {
        return validationError(`${eventPath}.evidence`, "expected up to 20 bounded evidence items");
      }
      if (record.transition === "review" && record.evidence.length === 0) {
        return validationError(`${eventPath}.evidence`, "review reports require evidence");
      }
      if (record.verification === null) {
        if (record.verificationReason !== null) {
          return validationError(
            `${eventPath}.verificationReason`,
            "verification reason requires a verification result",
          );
        }
        if (record.verificationSession !== null) {
          return validationError(
            `${eventPath}.verificationSession`,
            "verification session requires a verification result",
          );
        }
      } else {
        if (
          typeof record.verification !== "string" ||
          !VERIFICATION_STATUSES.has(record.verification as NotesVerificationStatus)
        ) {
          return validationError(`${eventPath}.verification`, "unknown verification result");
        }
        if (record.verification === "passed") {
          if (record.evidence.length === 0) {
            return validationError(
              `${eventPath}.evidence`,
              "passed verification requires evidence",
            );
          }
          if (record.verificationReason !== null) {
            return validationError(
              `${eventPath}.verificationReason`,
              "passed verification cannot include a failure or exception reason",
            );
          }
        } else if (!isBoundedNonEmptyString(record.verificationReason, 1_024)) {
          return validationError(
            `${eventPath}.verificationReason`,
            "failed or exception verification requires a bounded reason",
          );
        }
        const verificationSessionError = validateSession(
          record.verificationSession,
          `${eventPath}.verificationSession`,
        );
        if (verificationSessionError) return verificationSessionError;
        verificationUpdates.set(record.id, record as unknown as NotesRoadmapStatusUpdate);
        verificationUpdateIndexes.set(record.id, index);
      }
      if (
        typeof record.statusOutcome !== "string" ||
        !ROADMAP_STATUS_OUTCOMES.has(record.statusOutcome as NotesRoadmapStatusOutcome)
      ) {
        return validationError(`${eventPath}.statusOutcome`, "unknown status outcome");
      }
      if (!Array.isArray(record.proposedReferences) || record.proposedReferences.length > 20) {
        return validationError(`${eventPath}.proposedReferences`, "expected up to 20 proposals");
      }
      for (
        let proposalIndex = 0;
        proposalIndex < record.proposedReferences.length;
        proposalIndex += 1
      ) {
        const proposal = record.proposedReferences[proposalIndex];
        const proposalPath = `${eventPath}.proposedReferences[${proposalIndex}]`;
        const proposalError = validateRoadmapProposal(
          proposal,
          proposalPath,
          record.timestamp,
          knownReferenceIds,
        );
        if (proposalError) return proposalError;
        const typed = proposal as NotesRoadmapReferenceProposal;
        if (proposalIds.has(typed.id)) {
          return validationError(`${proposalPath}.id`, `duplicate ID: ${typed.id}`);
        }
        proposalIds.add(typed.id);
        if (typed.disposition === "pending") pendingProposalIds.add(typed.id);
      }
      continue;
    }

    if (record.type === "reference-decision") {
      if (!isRecordWithKeys(record, ROADMAP_REFERENCE_DECISION_KEYS)) {
        return validationError(eventPath, "invalid reference decision");
      }
      if (!isNonEmptyString(record.proposalId) || !pendingProposalIds.has(record.proposalId)) {
        return validationError(`${eventPath}.proposalId`, "expected a prior pending proposal ID");
      }
      if (decidedProposalIds.has(record.proposalId)) {
        return validationError(`${eventPath}.proposalId`, "proposal already has a decision");
      }
      if (record.decision !== "accepted" && record.decision !== "rejected") {
        return validationError(`${eventPath}.decision`, "expected accepted or rejected");
      }
      if (record.decision === "accepted") {
        if (!isNonEmptyString(record.referenceId) || !knownReferenceIds.has(record.referenceId)) {
          return validationError(
            `${eventPath}.referenceId`,
            "accepted decisions require a known reference ID",
          );
        }
      } else if (record.referenceId !== null) {
        return validationError(
          `${eventPath}.referenceId`,
          "rejected decisions cannot attach a reference",
        );
      }
      decidedProposalIds.add(record.proposalId);
      continue;
    }

    if (record.type === "override-reset") {
      if (!isRecordWithKeys(record, ROADMAP_OVERRIDE_RESET_KEYS)) {
        return validationError(eventPath, "invalid override reset");
      }
      if (record.field !== "status" && record.field !== "references") {
        return validationError(`${eventPath}.field`, "expected status or references");
      }
      continue;
    }

    if (record.type === "implementation-checkpoint") {
      if (!isRecordWithKeys(record, ROADMAP_IMPLEMENTATION_CHECKPOINT_KEYS)) {
        return validationError(eventPath, "invalid implementation checkpoint");
      }
      const sessionError = validateSession(record.session, `${eventPath}.session`);
      if (sessionError || record.session === null) {
        return (
          sessionError ?? validationError(`${eventPath}.session`, "a bound session is required")
        );
      }
      if (!isPositiveInteger(record.planStepTotal)) {
        return validationError(`${eventPath}.planStepTotal`, "expected a positive integer");
      }
      if (!Array.isArray(record.completedPlanSteps)) {
        return validationError(`${eventPath}.completedPlanSteps`, "expected a sorted step array");
      }
      let priorStep = 0;
      for (let stepIndex = 0; stepIndex < record.completedPlanSteps.length; stepIndex += 1) {
        const step = record.completedPlanSteps[stepIndex];
        if (!isPositiveInteger(step) || step > record.planStepTotal || step <= priorStep) {
          return validationError(
            `${eventPath}.completedPlanSteps[${stepIndex}]`,
            "expected unique ascending steps within the plan total",
          );
        }
        priorStep = step;
      }
      if (
        typeof record.runOutcome !== "string" ||
        !IMPLEMENTATION_RUN_OUTCOMES.has(record.runOutcome as NotesImplementationRunOutcome)
      ) {
        return validationError(`${eventPath}.runOutcome`, "unknown implementation run outcome");
      }
      implementationCheckpoints.set(
        record.id,
        record as unknown as NotesRoadmapImplementationCheckpoint,
      );
      implementationCheckpointIndexes.set(record.id, index);
      continue;
    }

    if (record.type === "completion-review") {
      if (!isRecordWithKeys(record, ROADMAP_COMPLETION_REVIEW_KEYS)) {
        return validationError(eventPath, "invalid completion review");
      }
      if (record.reviewer !== "ken" && record.reviewer !== "ken-autopilot") {
        return validationError(`${eventPath}.reviewer`, "expected Ken or Autopilot Ken");
      }
      if (record.decision !== "accepted" && record.decision !== "rejected") {
        return validationError(`${eventPath}.decision`, "expected accepted or rejected");
      }
      if (
        !Array.isArray(record.evidence) ||
        record.evidence.length > 20 ||
        !record.evidence.every((item) => isBoundedNonEmptyString(item, 4_096))
      ) {
        return validationError(`${eventPath}.evidence`, "expected up to 20 bounded evidence items");
      }
      if (record.decision === "accepted" && record.evidence.length === 0) {
        return validationError(`${eventPath}.evidence`, "accepted reviews require evidence");
      }
      if (record.reason !== null && !isBoundedNonEmptyString(record.reason, 1_024)) {
        return validationError(`${eventPath}.reason`, "expected a bounded reason or null");
      }
      if (record.decision === "rejected" && record.reason === null) {
        return validationError(`${eventPath}.reason`, "rejected reviews require a reason");
      }
      if (
        record.implementationCheckpointId !== null &&
        (!isNonEmptyString(record.implementationCheckpointId) ||
          !implementationCheckpoints.has(record.implementationCheckpointId))
      ) {
        return validationError(
          `${eventPath}.implementationCheckpointId`,
          "expected a prior implementation checkpoint ID or null",
        );
      }
      if (
        record.verificationStatusUpdateId !== null &&
        (!isNonEmptyString(record.verificationStatusUpdateId) ||
          !verificationUpdates.has(record.verificationStatusUpdateId))
      ) {
        return validationError(
          `${eventPath}.verificationStatusUpdateId`,
          "expected a prior typed verification update ID or null",
        );
      }
      if (typeof record.acceptsVerificationException !== "boolean") {
        return validationError(`${eventPath}.acceptsVerificationException`, "expected a boolean");
      }
      if (
        record.acceptsVerificationException &&
        (record.verificationStatusUpdateId === null ||
          verificationUpdates.get(record.verificationStatusUpdateId)?.verification !==
            "exception-requested")
      ) {
        return validationError(
          `${eventPath}.acceptsVerificationException`,
          "can only accept a referenced verification exception",
        );
      }
      if (
        typeof record.gateOutcome !== "string" ||
        !COMPLETION_GATE_OUTCOMES.has(record.gateOutcome as NotesCompletionGateOutcome)
      ) {
        return validationError(`${eventPath}.gateOutcome`, "unknown completion gate outcome");
      }
      if (!Array.isArray(record.unmetGateCodes) || record.unmetGateCodes.length > 20) {
        return validationError(`${eventPath}.unmetGateCodes`, "expected up to 20 unmet gate codes");
      }
      const unmetCodes = new Set<string>();
      for (let gateIndex = 0; gateIndex < record.unmetGateCodes.length; gateIndex += 1) {
        const gate = record.unmetGateCodes[gateIndex];
        if (
          typeof gate !== "string" ||
          !COMPLETION_UNMET_GATE_CODES.has(gate as NotesCompletionUnmetGateCode) ||
          unmetCodes.has(gate)
        ) {
          return validationError(
            `${eventPath}.unmetGateCodes[${gateIndex}]`,
            "expected a unique known completion gate code",
          );
        }
        unmetCodes.add(gate);
      }
      if (record.gateOutcome === "done") {
        const implementationCheckpoint =
          typeof record.implementationCheckpointId === "string"
            ? implementationCheckpoints.get(record.implementationCheckpointId)
            : undefined;
        const verificationStatusUpdate =
          typeof record.verificationStatusUpdateId === "string"
            ? verificationUpdates.get(record.verificationStatusUpdateId)
            : undefined;
        const hasCompleteSuccessfulImplementation =
          implementationCheckpoint !== undefined &&
          implementationCheckpoint.runOutcome === "succeeded" &&
          implementationCheckpoint.completedPlanSteps.length ===
            implementationCheckpoint.planStepTotal &&
          implementationCheckpoint.completedPlanSteps.every((step, index) => step === index + 1);
        const hasAcceptedVerification =
          (verificationStatusUpdate?.verification === "passed" &&
            !record.acceptsVerificationException) ||
          (verificationStatusUpdate?.verification === "exception-requested" &&
            record.acceptsVerificationException);
        const hasFreshReviewRoundEvidence =
          implementationCheckpoint !== undefined &&
          verificationStatusUpdate !== undefined &&
          (implementationCheckpointIndexes.get(implementationCheckpoint.id) ?? -1) >
            latestRejectedReviewIndex &&
          (verificationUpdateIndexes.get(verificationStatusUpdate.id) ?? -1) >
            latestRejectedReviewIndex;
        const hasSameSessionEvidence =
          implementationCheckpoint !== undefined &&
          verificationStatusUpdate?.verificationSession !== null &&
          verificationStatusUpdate?.verificationSession !== undefined &&
          isDeepStrictEqual(
            implementationCheckpoint.session,
            verificationStatusUpdate.verificationSession,
          );
        if (
          record.decision !== "accepted" ||
          !hasCompleteSuccessfulImplementation ||
          !hasAcceptedVerification ||
          !hasFreshReviewRoundEvidence ||
          !hasSameSessionEvidence ||
          record.unmetGateCodes.length > 0
        ) {
          return validationError(
            eventPath,
            "Done requires accepted review evidence, a successful complete implementation checkpoint, passed verification or an accepted verification exception, and no unmet gates",
          );
        }
      }
      if (record.decision === "rejected") latestRejectedReviewIndex = index;
      continue;
    }

    return validationError(`${eventPath}.type`, "unknown roadmap event type");
  }
  return null;
}

function validateRoadmapProposal(
  value: unknown,
  pathPrefix: string,
  timestamp: string,
  knownReferenceIds: ReadonlySet<string>,
): NotesValidationError | null {
  if (!isRecordWithKeys(value, ROADMAP_PROPOSAL_KEYS)) {
    return validationError(pathPrefix, `expected exactly: ${ROADMAP_PROPOSAL_KEYS.join(", ")}`);
  }
  if (!isNonEmptyString(value.id))
    return validationError(`${pathPrefix}.id`, "proposal ID is required");
  const referenceError = validateReference(
    {
      id: value.id,
      provider: value.provider,
      tool: value.tool,
      canonicalUrl: value.canonicalUrl,
      owner: value.owner,
      repo: value.repo,
      revision: value.revision,
      path: value.path,
      range: value.range,
      issue: value.issue,
      pullRequest: value.pullRequest,
      query: value.query,
      anchor: value.anchor,
      relevance: value.relevance,
      capturedAt: timestamp,
    },
    pathPrefix,
  );
  if (referenceError) return referenceError;
  if (
    value.disposition !== "pending" &&
    value.disposition !== "accepted" &&
    value.disposition !== "reused"
  ) {
    return validationError(`${pathPrefix}.disposition`, "expected pending, accepted, or reused");
  }
  const expectedDisposition =
    value.policyOutcome === "manual-review" ||
    value.policyOutcome === "reference-override-protected"
      ? "pending"
      : value.policyOutcome === "accepted" || value.policyOutcome === "reused"
        ? value.policyOutcome
        : null;
  if (expectedDisposition === null) {
    return validationError(
      `${pathPrefix}.policyOutcome`,
      "expected manual-review, reference-override-protected, accepted, or reused",
    );
  }
  if (value.disposition !== expectedDisposition) {
    return validationError(`${pathPrefix}.policyOutcome`, "must match the proposal disposition");
  }
  if (value.disposition === "accepted" || value.disposition === "reused") {
    if (!isNonEmptyString(value.referenceId) || !knownReferenceIds.has(value.referenceId)) {
      return validationError(
        `${pathPrefix}.referenceId`,
        "accepted or reused proposals require a known reference ID",
      );
    }
  } else if (value.referenceId !== null) {
    return validationError(
      `${pathPrefix}.referenceId`,
      "pending proposals cannot attach a reference",
    );
  }
  return null;
}

function invalid(path: string, message: string): NotesValidationResult {
  return { ok: false, error: validationError(path, message) };
}

function validationError(path: string, message: string): NotesValidationError {
  return { path, message };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isBoundedNonEmptyString(value: unknown, maximum: number): value is string {
  return isNonEmptyString(value) && value.length <= maximum;
}

function isReferenceMetadataTooLong(value: unknown): boolean {
  return typeof value === "string" && value.length > NOTES_REFERENCE_METADATA_MAX_LENGTH;
}

function referenceMetadataLengthError(pathPrefix: string): NotesValidationError {
  return validationError(
    pathPrefix,
    `expected ${NOTES_REFERENCE_METADATA_MAX_LENGTH.toLocaleString("en-US")} characters or fewer`,
  );
}

function isNullableNonEmptyString(value: unknown): value is string | null {
  return value === null || isNonEmptyString(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isNullablePositiveInteger(value: unknown): value is number | null {
  return value === null || isPositiveInteger(value);
}

function isPhaseStatus(value: unknown): value is NotesPhaseStatus {
  return typeof value === "string" && PHASE_STATUSES.has(value as NotesPhaseStatus);
}

function isLifecycleEventSource(value: unknown): value is NotesLifecycleEventSource {
  return (
    typeof value === "string" && LIFECYCLE_EVENT_SOURCES.has(value as NotesLifecycleEventSource)
  );
}

function normalizeCanonicalUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname || url.username || url.password) return null;
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    if (
      (url.protocol === "http:" && url.port === "80") ||
      (url.protocol === "https:" && url.port === "443")
    ) {
      url.port = "";
    }
    if (url.pathname === "/") url.pathname = "";
    else url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function canonicalReferenceIdentity(
  reference: Pick<NotesReference, "provider" | "canonicalUrl">,
): string | null {
  const url = normalizeCanonicalUrl(reference.canonicalUrl);
  const provider = reference.provider.trim().toLowerCase();
  return provider && url ? `${provider}\n${url}` : null;
}

function isCanonicalHttpUrl(value: unknown): value is string {
  return typeof value === "string" && normalizeCanonicalUrl(value) !== null;
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
  if (!isRecordWithKeys(value, DOCUMENT_V3_KEYS) || value.version !== 3) return current;
  if (!Array.isArray(value.phases)) return current;

  let migratedLegacyShape = false;
  const phases = value.phases.map((phase) => {
    if (typeof phase !== "object" || phase === null || Array.isArray(phase)) return phase;
    const record = phase as Record<string, unknown>;
    const keys = Object.keys(record);
    const hasRequiredKeys = LEGACY_V3_PHASE_REQUIRED_KEYS.every((key) => keys.includes(key));
    const onlyCurrentKeys = keys.every((key) => PHASE_KEYS.includes(key));
    if (!hasRequiredKeys || !onlyCurrentKeys) return phase;

    const missingPhaseFields = !keys.includes("archivedAt") || !keys.includes("roadmapEvents");
    if (missingPhaseFields) migratedLegacyShape = true;
    const migratedPhase = {
      ...record,
      archivedAt: keys.includes("archivedAt") ? record.archivedAt : null,
      roadmapEvents: keys.includes("roadmapEvents") ? record.roadmapEvents : [],
    };
    if (!Array.isArray(migratedPhase.roadmapEvents)) return migratedPhase;

    const roadmapEvents = migratedPhase.roadmapEvents.map((event) => {
      if (
        typeof event !== "object" ||
        event === null ||
        Array.isArray(event) ||
        (event as Record<string, unknown>).type !== "status-update"
      ) {
        return event;
      }
      const statusUpdate = event as Record<string, unknown>;
      let migratedEvent = false;
      const migratedStatusUpdate: Record<string, unknown> = isRecordWithKeys(
        statusUpdate,
        LEGACY_ROADMAP_STATUS_UPDATE_KEYS,
      )
        ? (() => {
            migratedEvent = true;
            migratedLegacyShape = true;
            return {
              ...statusUpdate,
              verification: null,
              verificationReason: null,
              verificationSession: null,
            };
          })()
        : isRecordWithKeys(statusUpdate, UNBOUND_VERIFICATION_ROADMAP_STATUS_UPDATE_KEYS)
          ? (() => {
              migratedEvent = true;
              migratedLegacyShape = true;
              return Object.assign({}, statusUpdate, { verificationSession: null });
            })()
          : statusUpdate;
      if (!Array.isArray(migratedStatusUpdate.proposedReferences)) {
        return migratedEvent ? migratedStatusUpdate : event;
      }
      const proposedReferences = migratedStatusUpdate.proposedReferences.map((proposal) => {
        if (!isRecordWithKeys(proposal, LEGACY_ROADMAP_PROPOSAL_KEYS)) return proposal;
        const policyOutcome =
          proposal.disposition === "pending"
            ? "manual-review"
            : proposal.disposition === "accepted" || proposal.disposition === "reused"
              ? proposal.disposition
              : null;
        if (policyOutcome === null) return proposal;
        migratedEvent = true;
        migratedLegacyShape = true;
        return { ...proposal, policyOutcome };
      });
      return migratedEvent ? { ...migratedStatusUpdate, proposedReferences } : event;
    });
    return { ...migratedPhase, roadmapEvents };
  });
  if (!migratedLegacyShape) return current;
  const migrated = validateNotesDocumentV3({ ...value, phases });
  return { ...migrated, migratedLegacyShape: migrated.ok };
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
      if (phase.lifecycleEvents[eventIndex]!.source !== "user") {
        return validationError(
          `phases[${phaseIndex}].lifecycleEvents[${eventIndex}].source`,
          "generic saves may only append user lifecycle events",
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

function sameSessionLink(
  current: NotesSessionLink | null,
  expected: NotesSessionLink | null,
): boolean {
  if (expected === null) return current === null;
  return (
    current !== null &&
    current.sessionId === expected.sessionId &&
    current.sessionPath === expected.sessionPath
  );
}

function chronologicalLifecycleTimestamp(phase: NotesPhase, requested: string): string {
  const requestedTime = Date.parse(requested);
  if (!Number.isFinite(requestedTime)) {
    throw new Error("Cannot record a phase lifecycle transition with an invalid timestamp.");
  }
  const previous = phase.lifecycleEvents.at(-1)?.timestamp;
  if (!previous) return new Date(requestedTime).toISOString();
  return new Date(Math.max(requestedTime, Date.parse(previous))).toISOString();
}

function boundedLifecycleReason(reason: string): string {
  const normalized = reason.replace(/\s+/g, " ").trim();
  const fallback = "Phase lifecycle changed.";
  return (normalized || fallback).slice(0, NOTES_PHASE_LIFECYCLE_REASON_MAX_LENGTH).trimEnd();
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
  });
  return "updated";
}

function roadmapTransitionStatus(transition: NotesRoadmapTransition): NotesAutomaticPhaseStatus {
  switch (transition) {
    case "pending":
      return "planning";
    case "in-progress":
      return "in-progress";
    case "blocked":
      return "needs-attention";
    case "review":
      return "review";
  }
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
    const error = validateReference(
      { ...references[index]!, id: `proposal-${index + 1}`, capturedAt: timestamp },
      `proposed_references[${index}]`,
    );
    if (error) return { path: error.path, message: error.message };
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

function completionEvaluationFromStoredReview(
  review: NotesRoadmapCompletionReview,
): PhaseCompletionEvaluation {
  return {
    gateOutcome: review.gateOutcome,
    unmetGateCodes: [...review.unmetGateCodes],
    implementationCheckpointId: review.implementationCheckpointId,
    verificationStatusUpdateId: review.verificationStatusUpdateId,
    targetStatus: null,
    reason: review.reason ?? "Final review was already recorded.",
  };
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

function sameCompletionReviewPayload(
  event: NotesRoadmapCompletionReview,
  request: ProjectNotesCompletionReviewRequest,
): boolean {
  return isDeepStrictEqual(
    {
      reviewer: event.reviewer,
      decision: event.decision,
      evidence: event.evidence,
      reason: event.reason,
      acceptsVerificationException: event.acceptsVerificationException,
    },
    {
      reviewer: request.reviewer,
      decision: request.decision,
      evidence: request.evidence,
      reason: request.reason,
      acceptsVerificationException: request.acceptsVerificationException,
    },
  );
}

function validateImplementationCheckpointRequest(
  request: ProjectNotesImplementationCheckpointRequest,
): string | null {
  if (!isNonEmptyString(request.checkpointId)) return "Checkpoint ID is required.";
  if (!isTimestamp(request.timestamp)) return "Checkpoint timestamp is invalid.";
  if (!isPositiveInteger(request.planStepTotal)) return "Plan step total must be positive.";
  if (!IMPLEMENTATION_RUN_OUTCOMES.has(request.runOutcome)) return "Run outcome is invalid.";
  if (!Array.isArray(request.completedPlanSteps)) return "Completed plan steps must be an array.";
  let previous = 0;
  for (const step of request.completedPlanSteps) {
    if (!isPositiveInteger(step) || step > request.planStepTotal || step <= previous) {
      return "Completed plan steps must be unique, ascending, and within the plan total.";
    }
    previous = step;
  }
  return validateSession(request.expectedSession, "expectedSession")?.message ?? null;
}

function validateCompletionReviewRequest(
  request: ProjectNotesCompletionReviewRequest,
): string | null {
  if (!isNonEmptyString(request.reviewId)) return "Review ID is required.";
  if (!isTimestamp(request.timestamp)) return "Review timestamp is invalid.";
  if (request.reviewer !== "ken" && request.reviewer !== "ken-autopilot") {
    return "Only Ken or Autopilot Ken may submit a final review.";
  }
  if (request.decision !== "accepted" && request.decision !== "rejected") {
    return "Review decision is invalid.";
  }
  if (
    !Array.isArray(request.evidence) ||
    request.evidence.length > 20 ||
    !request.evidence.every((item) => isBoundedNonEmptyString(item, 4_096))
  ) {
    return "Review evidence must contain up to 20 bounded items.";
  }
  if (request.decision === "accepted" && request.evidence.length === 0) {
    return "Accepted reviews require evidence.";
  }
  if (request.reason !== null && !isBoundedNonEmptyString(request.reason, 1_024)) {
    return "Review reason must be bounded or null.";
  }
  if (request.decision === "rejected" && request.reason === null) {
    return "Rejected reviews require a reason.";
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
  });
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
      evidence: request.evidence,
      verification: request.verification,
      verificationReason: request.verificationReason,
      proposedReferences: request.proposedReferences,
    },
  );
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
    const validated = validateNotesDocumentV3(document);
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

  async recordRoadmapStatusUpdate(
    cwd: string,
    request: ProjectNotesRoadmapStatusRequest,
  ): Promise<ProjectNotesRoadmapStatusOutcome> {
    const projectKey = canonicalProjectKey(cwd);
    const paths = this.paths(cwd);
    await this.ensureDirectory(paths.directory);
    return this.lock(paths.primary, async () => {
      const current = await this.readCurrent(paths, projectKey);
      if (current.status === "missing" || current.status === "corrupt") return current;
      const revision = current.envelope.revision;
      const phaseIndex = current.envelope.document.phases.findIndex(
        (phase) => phase.id === request.phaseId,
      );
      if (phaseIndex < 0) return { status: "phase-not-found" };
      const currentPhase = current.envelope.document.phases[phaseIndex]!;
      const normalizedReferences = request.proposedReferences.map(
        normalizeRoadmapProposedReference,
      );
      const normalizedRequest = { ...request, proposedReferences: normalizedReferences };
      const prior = currentPhase.roadmapEvents.find(
        (event): event is NotesRoadmapStatusUpdate =>
          event.type === "status-update" && event.id === request.updateId,
      );
      if (prior) {
        if (!sameRoadmapStatusPayload(prior, normalizedRequest)) {
          return { status: "duplicate-id-conflict", revision };
        }
        return {
          status: "duplicate",
          revision,
          phaseId: request.phaseId,
          statusOutcome: prior.statusOutcome,
          proposals: prior.proposedReferences.map(roadmapProposalOutcome),
        };
      }

      if (request.expectedRevision !== undefined && request.expectedRevision !== revision) {
        return { status: "stale-revision", revision };
      }
      if (currentPhase.archivedAt !== null) return { status: "phase-archived" };
      if (
        (request.requireBoundPhase || request.verification !== null) &&
        currentPhase.session === null
      ) {
        return { status: "phase-not-bound" };
      }
      if (
        request.expectedSession !== undefined &&
        !sameSessionLink(currentPhase.session, request.expectedSession)
      ) {
        return { status: "stale-session" };
      }
      const timestamp = chronologicalRoadmapTimestamp(currentPhase, request.timestamp);
      const referenceError = validateRoadmapProposedReferences(normalizedReferences, timestamp);
      if (referenceError) return { status: "invalid-reference", ...referenceError };

      const document = structuredClone(current.envelope.document);
      const phase = document.phases[phaseIndex]!;
      const lifecycleOutcome = applyPhaseLifecycleTransition(
        phase,
        {
          status: roadmapTransitionStatus(request.transition),
          source: "agent",
          reason:
            request.transition === "blocked"
              ? request.blocker!
              : `Roadmap report: ${request.progress}`,
          timestamp,
        },
        this.createId,
      );
      const statusOutcome = roadmapStatusOutcome(lifecycleOutcome);
      const proposals = appendRoadmapStatusEvent(
        document,
        phaseIndex,
        request,
        normalizedReferences,
        timestamp,
        statusOutcome,
        this.createId,
      );
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
      const next: StoredProjectNotesV1 = {
        storeVersion: 1,
        projectKey,
        revision: revision + 1,
        document: validation.document,
      };
      await this.atomicWrite(paths.backup, serializeEnvelope(current.envelope));
      await this.atomicWrite(paths.primary, serializeEnvelope(next));
      return {
        status: "committed",
        snapshot: toSnapshot(next),
        phase: structuredClone(phase),
        statusOutcome,
        proposals: proposals.map(roadmapProposalOutcome),
      };
    });
  }

  async recordRoadmapFinalReview(
    cwd: string,
    request: ProjectNotesRoadmapFinalReviewRequest,
  ): Promise<ProjectNotesRoadmapFinalReviewOutcome> {
    const reviewer = request.statusUpdate.actor;
    if (reviewer === "gg-coder") {
      return {
        status: "invalid-review",
        message: "Only Ken or Autopilot Ken may submit a final review.",
      };
    }
    if (request.statusUpdate.transition !== "review") {
      return {
        status: "invalid-review",
        message: "Final reviews require a review status transition.",
      };
    }
    const projectKey = canonicalProjectKey(cwd);
    const paths = this.paths(cwd);
    await this.ensureDirectory(paths.directory);
    return this.lock(paths.primary, async () => {
      const current = await this.readCurrent(paths, projectKey);
      if (current.status === "missing" || current.status === "corrupt") return current;
      const revision = current.envelope.revision;
      const statusRequest = request.statusUpdate;
      const phaseIndex = current.envelope.document.phases.findIndex(
        (phase) => phase.id === statusRequest.phaseId,
      );
      if (phaseIndex < 0) return { status: "phase-not-found" };
      const currentPhase = current.envelope.document.phases[phaseIndex]!;
      if (currentPhase.session === null) return { status: "phase-not-bound" };
      const normalizedReferences = statusRequest.proposedReferences.map(
        normalizeRoadmapProposedReference,
      );
      const normalizedStatusRequest = {
        ...statusRequest,
        proposedReferences: normalizedReferences,
      };
      const reviewRequest: ProjectNotesCompletionReviewRequest = {
        ...request.review,
        phaseId: statusRequest.phaseId,
        expectedSession: { ...currentPhase.session },
        reviewer,
        reason:
          request.review.reason === null
            ? null
            : request.review.reason.replace(/\s+/g, " ").trim().slice(0, 1_024),
        timestamp: statusRequest.timestamp,
      };
      const invalidReview = validateCompletionReviewRequest(reviewRequest);
      if (invalidReview) return { status: "invalid-review", message: invalidReview };
      if (statusRequest.updateId === reviewRequest.reviewId) {
        return { status: "duplicate-id-conflict", revision };
      }

      const priorStatus = currentPhase.roadmapEvents.find(
        (event): event is NotesRoadmapStatusUpdate =>
          event.type === "status-update" && event.id === statusRequest.updateId,
      );
      const priorReview = currentPhase.roadmapEvents.find(
        (event): event is NotesRoadmapCompletionReview =>
          event.type === "completion-review" && event.id === reviewRequest.reviewId,
      );
      if (priorStatus || priorReview) {
        if (
          priorStatus &&
          priorReview &&
          sameRoadmapStatusPayload(priorStatus, normalizedStatusRequest) &&
          sameCompletionReviewPayload(priorReview, reviewRequest)
        ) {
          return {
            status: "duplicate",
            revision,
            phaseId: statusRequest.phaseId,
            statusOutcome: priorStatus.statusOutcome,
            proposals: priorStatus.proposedReferences.map(roadmapProposalOutcome),
            evaluation: completionEvaluationFromStoredReview(priorReview),
          };
        }
        return { status: "duplicate-id-conflict", revision };
      }
      if (
        currentPhase.roadmapEvents.some(
          (event) => event.id === statusRequest.updateId || event.id === reviewRequest.reviewId,
        )
      ) {
        return { status: "duplicate-id-conflict", revision };
      }
      if (
        statusRequest.expectedRevision !== undefined &&
        statusRequest.expectedRevision !== revision
      ) {
        return { status: "stale-revision", revision };
      }
      if (currentPhase.archivedAt !== null) return { status: "phase-archived" };
      if (
        statusRequest.expectedSession !== undefined &&
        !sameSessionLink(currentPhase.session, statusRequest.expectedSession)
      ) {
        return { status: "stale-session" };
      }

      const timestamp = chronologicalRoadmapTimestamp(currentPhase, statusRequest.timestamp);
      const referenceError = validateRoadmapProposedReferences(normalizedReferences, timestamp);
      if (referenceError) return { status: "invalid-reference", ...referenceError };

      const document = structuredClone(current.envelope.document);
      const phase = document.phases[phaseIndex]!;
      const statusOutcome = "evidence-only" as const;
      const proposals = appendRoadmapStatusEvent(
        document,
        phaseIndex,
        statusRequest,
        normalizedReferences,
        timestamp,
        statusOutcome,
        this.createId,
      );
      const evaluation = evaluatePhaseCompletion({
        phase,
        expectedSession: reviewRequest.expectedSession,
        review: {
          reviewer: reviewRequest.reviewer,
          decision: reviewRequest.decision,
          acceptsVerificationException: reviewRequest.acceptsVerificationException,
          reason: reviewRequest.reason,
        },
      });
      if (reviewRequest.acceptsVerificationException) {
        const verification = phase.roadmapEvents.find(
          (event): event is NotesRoadmapStatusUpdate =>
            event.type === "status-update" && event.id === evaluation.verificationStatusUpdateId,
        );
        if (verification?.verification !== "exception-requested") {
          return {
            status: "invalid-review",
            message: "A review can only accept the latest referenced verification exception.",
          };
        }
      }

      phase.roadmapEvents.push({
        type: "completion-review",
        id: reviewRequest.reviewId,
        reviewer: reviewRequest.reviewer,
        decision: reviewRequest.decision,
        evidence: [...reviewRequest.evidence],
        reason: reviewRequest.reason,
        implementationCheckpointId: evaluation.implementationCheckpointId,
        verificationStatusUpdateId: evaluation.verificationStatusUpdateId,
        acceptsVerificationException: reviewRequest.acceptsVerificationException,
        gateOutcome: evaluation.gateOutcome,
        unmetGateCodes: [...evaluation.unmetGateCodes],
        timestamp,
      });
      applyCompletionEvaluation(phase, evaluation, timestamp, this.createId);
      phase.updatedAt = timestamp;
      document.updatedAt = timestamp;
      const validation = validateNotesDocumentV3(document);
      if (!validation.ok) {
        if (validation.error.path.includes("proposedReferences")) {
          return {
            status: "invalid-reference",
            path: validation.error.path,
            message: validation.error.message,
          };
        }
        throw new Error(
          `Final review reconciliation created invalid Notes: ${validation.error.path}`,
        );
      }
      const next: StoredProjectNotesV1 = {
        storeVersion: 1,
        projectKey,
        revision: revision + 1,
        document: validation.document,
      };
      await this.atomicWrite(paths.backup, serializeEnvelope(current.envelope));
      await this.atomicWrite(paths.primary, serializeEnvelope(next));
      return {
        status: "committed",
        snapshot: toSnapshot(next),
        phase: structuredClone(phase),
        statusOutcome,
        proposals: proposals.map(roadmapProposalOutcome),
        evaluation,
      };
    });
  }

  async recordImplementationCheckpoint(
    cwd: string,
    request: ProjectNotesImplementationCheckpointRequest,
  ): Promise<ProjectNotesImplementationCheckpointOutcome> {
    const invalid = validateImplementationCheckpointRequest(request);
    if (invalid) return { status: "invalid-checkpoint", message: invalid };
    const projectKey = canonicalProjectKey(cwd);
    const paths = this.paths(cwd);
    await this.ensureDirectory(paths.directory);
    return this.lock(paths.primary, async () => {
      const current = await this.readCurrent(paths, projectKey);
      if (current.status === "missing" || current.status === "corrupt") return current;
      const revision = current.envelope.revision;
      const phaseIndex = current.envelope.document.phases.findIndex(
        (phase) => phase.id === request.phaseId,
      );
      if (phaseIndex < 0) return { status: "phase-not-found" };
      const currentPhase = current.envelope.document.phases[phaseIndex]!;
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
      if (!sameSessionLink(currentPhase.session, request.expectedSession)) {
        return { status: "stale-session" };
      }

      const document = structuredClone(current.envelope.document);
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
      const validation = validateNotesDocumentV3(document);
      if (!validation.ok) {
        throw new Error(
          `Implementation checkpoint created invalid Notes: ${validation.error.path}`,
        );
      }
      const next: StoredProjectNotesV1 = {
        storeVersion: 1,
        projectKey,
        revision: revision + 1,
        document: validation.document,
      };
      await this.atomicWrite(paths.backup, serializeEnvelope(current.envelope));
      await this.atomicWrite(paths.primary, serializeEnvelope(next));
      return {
        status: "committed",
        snapshot: toSnapshot(next),
        phase: structuredClone(phase),
      };
    });
  }

  async recordCompletionReview(
    cwd: string,
    request: ProjectNotesCompletionReviewRequest,
  ): Promise<ProjectNotesCompletionReviewOutcome> {
    const invalid = validateCompletionReviewRequest(request);
    if (invalid) return { status: "invalid-review", message: invalid };
    const projectKey = canonicalProjectKey(cwd);
    const paths = this.paths(cwd);
    await this.ensureDirectory(paths.directory);
    return this.lock(paths.primary, async () => {
      const current = await this.readCurrent(paths, projectKey);
      if (current.status === "missing" || current.status === "corrupt") return current;
      const revision = current.envelope.revision;
      const phaseIndex = current.envelope.document.phases.findIndex(
        (phase) => phase.id === request.phaseId,
      );
      if (phaseIndex < 0) return { status: "phase-not-found" };
      const currentPhase = current.envelope.document.phases[phaseIndex]!;
      const prior = currentPhase.roadmapEvents.find(
        (event): event is NotesRoadmapCompletionReview =>
          event.type === "completion-review" && event.id === request.reviewId,
      );
      if (prior) {
        if (!sameCompletionReviewPayload(prior, request)) {
          return { status: "duplicate-id-conflict", revision };
        }
        return {
          status: "duplicate",
          revision,
          phaseId: request.phaseId,
          evaluation: {
            gateOutcome: prior.gateOutcome,
            unmetGateCodes: [...prior.unmetGateCodes],
            implementationCheckpointId: prior.implementationCheckpointId,
            verificationStatusUpdateId: prior.verificationStatusUpdateId,
            targetStatus: null,
            reason: prior.reason ?? "Final review was already recorded.",
          },
        };
      }
      if (currentPhase.roadmapEvents.some((event) => event.id === request.reviewId)) {
        return { status: "duplicate-id-conflict", revision };
      }
      if (currentPhase.archivedAt !== null) return { status: "phase-archived" };
      if (!sameSessionLink(currentPhase.session, request.expectedSession)) {
        return { status: "stale-session" };
      }

      const document = structuredClone(current.envelope.document);
      const phase = document.phases[phaseIndex]!;
      const timestamp = chronologicalRoadmapTimestamp(phase, request.timestamp);
      const evaluation = evaluatePhaseCompletion({
        phase,
        expectedSession: request.expectedSession,
        review: {
          reviewer: request.reviewer,
          decision: request.decision,
          acceptsVerificationException: request.acceptsVerificationException,
          reason: request.reason,
        },
      });
      if (request.acceptsVerificationException) {
        const verification = phase.roadmapEvents.find(
          (event): event is NotesRoadmapStatusUpdate =>
            event.type === "status-update" && event.id === evaluation.verificationStatusUpdateId,
        );
        if (verification?.verification !== "exception-requested") {
          return {
            status: "invalid-review",
            message: "A review can only accept the latest referenced verification exception.",
          };
        }
      }
      const reviewReason =
        request.reason === null ? null : request.reason.replace(/\s+/g, " ").trim().slice(0, 1_024);
      phase.roadmapEvents.push({
        type: "completion-review",
        id: request.reviewId,
        reviewer: request.reviewer,
        decision: request.decision,
        evidence: [...request.evidence],
        reason: reviewReason,
        implementationCheckpointId: evaluation.implementationCheckpointId,
        verificationStatusUpdateId: evaluation.verificationStatusUpdateId,
        acceptsVerificationException: request.acceptsVerificationException,
        gateOutcome: evaluation.gateOutcome,
        unmetGateCodes: [...evaluation.unmetGateCodes],
        timestamp,
      });
      applyCompletionEvaluation(phase, evaluation, timestamp, this.createId);
      phase.updatedAt = timestamp;
      document.updatedAt = timestamp;
      const validation = validateNotesDocumentV3(document);
      if (!validation.ok) {
        throw new Error(`Completion review created invalid Notes: ${validation.error.path}`);
      }
      const next: StoredProjectNotesV1 = {
        storeVersion: 1,
        projectKey,
        revision: revision + 1,
        document: validation.document,
      };
      await this.atomicWrite(paths.backup, serializeEnvelope(current.envelope));
      await this.atomicWrite(paths.primary, serializeEnvelope(next));
      return {
        status: "committed",
        snapshot: toSnapshot(next),
        phase: structuredClone(phase),
        evaluation,
      };
    });
  }

  async launchPhase(
    cwd: string,
    phaseId: string,
    createBinding: (context: FrozenPhaseLaunchContext) => Promise<NotesSessionLink>,
  ): Promise<ProjectNotesPhaseLaunchOutcome> {
    const projectKey = canonicalProjectKey(cwd);
    const paths = this.paths(cwd);
    await this.ensureDirectory(paths.directory);
    return this.lock(paths.primary, async () => {
      const current = await this.readCurrent(paths, projectKey);
      if (current.status === "missing" || current.status === "corrupt") return current;
      const phaseIndex = current.envelope.document.phases.findIndex(
        (phase) => phase.id === phaseId,
      );
      if (phaseIndex < 0) return { status: "phase-not-found" };
      const currentPhase = current.envelope.document.phases[phaseIndex]!;
      if (currentPhase.archivedAt !== null) return { status: "phase-archived" };
      const referencesById = new Map(
        current.envelope.document.references.map((reference) => [reference.id, reference]),
      );
      const references = currentPhase.referenceIds.map((id) => referencesById.get(id)!);
      if (currentPhase.session && currentPhase.session.sessionPath !== null) {
        return {
          status: "already-bound",
          snapshot: toSnapshot(current.envelope),
          phase: structuredClone(currentPhase),
          references: structuredClone(references),
          session: { ...currentPhase.session },
        };
      }

      const frozen: FrozenPhaseLaunchContext = {
        projectKey,
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
      const document = structuredClone(current.envelope.document);
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
        },
        this.createId,
      );
      if (transition !== "updated") boundPhase.updatedAt = timestamp;
      document.updatedAt = timestamp;
      const next: StoredProjectNotesV1 = {
        storeVersion: 1,
        projectKey,
        revision: current.envelope.revision + 1,
        document,
      };
      await this.atomicWrite(paths.backup, serializeEnvelope(current.envelope));
      await this.atomicWrite(paths.primary, serializeEnvelope(next));
      return {
        status: "accepted",
        snapshot: toSnapshot(next),
        phase: structuredClone(boundPhase),
        references: structuredClone(references),
        session: { ...session },
      };
    });
  }

  async updatePhaseSessionLink(
    cwd: string,
    phaseId: string,
    session: NotesSessionLink,
  ): Promise<ProjectNotesPhaseLinkOutcome> {
    if (
      !session.sessionId.trim() ||
      (session.sessionPath !== null && !session.sessionPath.trim())
    ) {
      throw new Error("Cannot store an invalid phase session link.");
    }
    return this.mutatePhaseLinkFields(cwd, phaseId, (phase) => {
      phase.session = { ...session };
    });
  }

  async recordPhaseLifecycleTransition(
    cwd: string,
    phaseId: string,
    transition: ProjectNotesPhaseLifecycleTransition,
  ): Promise<ProjectNotesPhaseLifecycleOutcome> {
    if (!isPhaseStatus(transition.status) || !isLifecycleEventSource(transition.source)) {
      throw new Error("Cannot record an invalid automatic phase lifecycle transition.");
    }
    if (!Number.isFinite(Date.parse(transition.timestamp))) {
      throw new Error("Cannot record a phase lifecycle transition with an invalid timestamp.");
    }
    const projectKey = canonicalProjectKey(cwd);
    const paths = this.paths(cwd);
    await this.ensureDirectory(paths.directory);
    return this.lock(paths.primary, async () => {
      const current = await this.readCurrent(paths, projectKey);
      if (current.status === "missing" || current.status === "corrupt") return current;
      const phaseIndex = current.envelope.document.phases.findIndex(
        (phase) => phase.id === phaseId,
      );
      if (phaseIndex < 0) return { status: "phase-not-found" };
      const currentPhase = current.envelope.document.phases[phaseIndex]!;
      if (currentPhase.archivedAt !== null) return { status: "phase-archived" };
      if (
        transition.expectedSession !== undefined &&
        !sameSessionLink(currentPhase.session, transition.expectedSession)
      ) {
        return { status: "stale-session" };
      }
      if (currentPhase.overrides.status !== null) return { status: "manual-override" };
      if (currentPhase.status === "done") return { status: "done-terminal" };
      if (currentPhase.status === transition.status) return { status: "same-status" };

      const document = structuredClone(current.envelope.document);
      const phase = document.phases[phaseIndex]!;
      const timestamp = chronologicalLifecycleTimestamp(phase, transition.timestamp);
      applyPhaseLifecycleTransition(phase, { ...transition, timestamp }, this.createId);
      document.updatedAt = timestamp;
      const next: StoredProjectNotesV1 = {
        storeVersion: 1,
        projectKey,
        revision: current.envelope.revision + 1,
        document,
      };
      await this.atomicWrite(paths.backup, serializeEnvelope(current.envelope));
      await this.atomicWrite(paths.primary, serializeEnvelope(next));
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
      expectedSession,
    });
  }

  private async mutatePhaseLinkFields(
    cwd: string,
    phaseId: string,
    mutate: (phase: NotesPhase) => void,
  ): Promise<ProjectNotesPhaseLinkOutcome> {
    const projectKey = canonicalProjectKey(cwd);
    const paths = this.paths(cwd);
    await this.ensureDirectory(paths.directory);
    return this.lock(paths.primary, async () => {
      const current = await this.readCurrent(paths, projectKey);
      if (current.status === "missing" || current.status === "corrupt") return current;
      const phaseIndex = current.envelope.document.phases.findIndex(
        (phase) => phase.id === phaseId,
      );
      if (phaseIndex < 0) return { status: "phase-not-found" };
      const currentPhase = current.envelope.document.phases[phaseIndex]!;
      if (currentPhase.archivedAt !== null) return { status: "phase-archived" };
      const document = structuredClone(current.envelope.document);
      const phase = document.phases[phaseIndex]!;
      mutate(phase);
      document.updatedAt = new Date().toISOString();
      const next: StoredProjectNotesV1 = {
        storeVersion: 1,
        projectKey,
        revision: current.envelope.revision + 1,
        document,
      };
      await this.atomicWrite(paths.backup, serializeEnvelope(current.envelope));
      await this.atomicWrite(paths.primary, serializeEnvelope(next));
      return { status: "ok", snapshot: toSnapshot(next), phase: structuredClone(phase) };
    });
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

function resolveSegments(parts: string[], rooted: boolean): string[] {
  const result: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (result.length > 0 && result[result.length - 1] !== "..") result.pop();
      else if (!rooted) result.push(part);
    } else {
      result.push(part);
    }
  }
  return result;
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

function isNotesTask(value: unknown): value is NotesTask {
  return (
    isRecordWithKeys(value, TASK_KEYS) &&
    typeof value.id === "string" &&
    typeof value.text === "string" &&
    (value.status === "todo" || value.status === "done") &&
    isTimestamp(value.createdAt) &&
    isTimestamp(value.updatedAt) &&
    isNullableTimestamp(value.completedAt) &&
    isNullableTimestamp(value.archivedAt)
  );
}

function isNotesHandoff(value: unknown): value is NotesHandoff {
  return (
    isRecordWithKeys(value, HANDOFF_KEYS) &&
    typeof value.text === "string" &&
    isNullableTimestamp(value.updatedAt) &&
    isNullableTimestamp(value.readAt)
  );
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

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}

function serializeEnvelope(envelope: StoredProjectNotesV1): string {
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

function toSnapshot(envelope: StoredProjectNotesV1): ProjectNotesSnapshot {
  return {
    projectKey: envelope.projectKey,
    revision: envelope.revision,
    document: envelope.document,
  };
}
