import {
  canonicalReferenceIdentity,
  normalizeCanonicalUrl,
  NOTES_REFERENCE_METADATA_MAX_LENGTH,
  NOTES_REFERENCE_URL_MAX_LENGTH,
} from "./notes-reference";

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

/** Legacy browser shape accepted only as a v2-to-v3 migration input. */
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

export type PhaseStartResult =
  | {
      status: "accepted";
      operationId: string;
      session: NotesSessionLink;
      packageTokenCount: number;
    }
  | {
      status: "already-bound";
      operationId: string;
      session: NotesSessionLink;
      packageTokenCount: number;
    }
  | {
      status: "failed";
      code: string;
      operationId: string | null;
      message: string;
    };

export type PhaseLaunchErrorCode = "prompt-failed" | "launch-failed";

export interface PhaseLaunchErrorEvent {
  type: "phase_launch_error";
  data: {
    operationId: string;
    phaseId: string;
    code: PhaseLaunchErrorCode;
    message: string;
    detail?: string;
  };
}

export function isPhaseLaunchErrorEvent(event: {
  type: string;
  data: unknown;
}): event is PhaseLaunchErrorEvent {
  if (event.type !== "phase_launch_error" || typeof event.data !== "object" || !event.data) {
    return false;
  }
  const data = event.data as Record<string, unknown>;
  return (
    typeof data.operationId === "string" &&
    data.operationId.length > 0 &&
    typeof data.phaseId === "string" &&
    data.phaseId.length > 0 &&
    (data.code === "prompt-failed" || data.code === "launch-failed") &&
    typeof data.message === "string" &&
    data.message.length > 0 &&
    (data.detail === undefined || typeof data.detail === "string")
  );
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
export type NotesRoadmapTransition = "pending" | "in-progress" | "blocked" | "review";
export type NotesRoadmapStatusOutcome =
  | "applied"
  | "same-status"
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

export type NotesRoadmapEvent =
  | NotesRoadmapStatusUpdate
  | NotesRoadmapReferenceDecision
  | NotesRoadmapOverrideReset;

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

export type NotesParseFailureReason = "malformed-json" | "unsupported-version" | "invalid-shape";

export type NotesParseResult =
  | {
      ok: true;
      document: NotesDocumentV3;
      migratedFromV2: boolean;
      migratedArchiveShape: boolean;
    }
  | { ok: false; reason: NotesParseFailureReason; error?: NotesValidationError };

export type NotesLoadSource = "v3" | "v2-migrated" | "legacy" | "empty" | "legacy-fallback";

export type NotesMigrationEligibility =
  | "valid-v3"
  | "valid-v2-migrated"
  | "valid-legacy"
  | "empty"
  | "ineligible-unreadable"
  | "ineligible-invalid-document";

export type NotesLoadDiagnostic =
  | { kind: "document-parse"; reason: NotesParseFailureReason; error?: NotesValidationError }
  | { kind: "storage-read"; key: string; error: unknown }
  | { kind: "storage-write"; key: string; error: unknown }
  | { kind: "ambiguous-legacy"; selectedKey: string; matchingKeys: string[] };

export interface NotesLoadResult {
  document: NotesDocumentV3;
  value: string;
  source: NotesLoadSource;
  legacyKey: string | null;
  v2ImportAttempted: boolean;
  v2ImportSucceeded: boolean | null;
  legacyRecoveryAttempted: boolean;
  legacyRecoverySucceeded: boolean | null;
  diagnostics: NotesLoadDiagnostic[];
  migrationEligibility: NotesMigrationEligibility;
}

export interface NotesWriteResult {
  key: string;
  ok: boolean;
  error?: unknown;
}

export interface NotesSaveResult {
  legacy: NotesWriteResult;
  v3: NotesWriteResult;
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

export type ProjectNotesReadOutcome =
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

export type NotesOperationFailureReason =
  | "invalid"
  | "missing"
  | "corrupt"
  | "unavailable"
  | "storage";

export type NotesReferenceOperationResult =
  | { status: "committed"; referenceId: string }
  | { status: "reused"; referenceId: string }
  | { status: "collision"; referenceId: string }
  | { status: "linked-blocked"; phaseIds: string[] }
  | { status: "missing-reference" }
  | { status: "missing-phase"; phaseId: string }
  | { status: "failed"; reason: NotesOperationFailureReason };

export type NotesRoadmapMutationResult =
  | {
      status: "committed";
      phaseId: string;
      referenceId?: string;
      resultingStatus?: NotesPhaseStatus;
    }
  | { status: "already-decided"; phaseId: string; decision: "accepted" | "rejected" }
  | { status: "decision-conflict"; phaseId: string; decision: "accepted" | "rejected" }
  | { status: "missing-phase"; phaseId: string }
  | { status: "archived-phase"; phaseId: string }
  | { status: "missing-proposal"; phaseId: string; proposalId: string }
  | { status: "no-protected-update"; phaseId: string }
  | { status: "failed"; reason: NotesOperationFailureReason };

export type NotesPromptSaveInput =
  | { kind: "new-draft"; title: string; prompt: string }
  | {
      kind: "existing-phase";
      phaseId: string;
      prompt: string;
      expectedSourcePrompt: string;
    };

export type NotesPromptSaveResult =
  | { status: "committed"; phaseId: string; title: string }
  | { status: "replacement-conflict"; phaseId: string; title: string }
  | { status: "missing-phase"; phaseId: string }
  | { status: "archived-phase"; phaseId: string; title: string }
  | { status: "failed"; reason: "invalid"; error?: NotesValidationError }
  | {
      status: "failed";
      reason: Exclude<NotesOperationFailureReason, "invalid">;
    };

export interface NotesSidecarEvent {
  type: string;
  data: unknown;
}

export interface NotesChangeEvent extends NotesSidecarEvent {
  type: "notes_change";
  data: ProjectNotesSnapshot;
}

/** Every new SSE connection emits this signal after its event bridge is ready. */
export interface NotesReadyEvent extends NotesSidecarEvent {
  type: "ready";
}

export interface NotesClient {
  getNotes(): Promise<ProjectNotesReadOutcome>;
  migrateNotes(document: NotesDocumentV3): Promise<ProjectNotesMigrationOutcome>;
  saveNotes(expectedRevision: number, document: NotesDocumentV3): Promise<ProjectNotesSaveOutcome>;
  subscribe(onEvent: (event: NotesSidecarEvent) => void): () => void;
}

export type NotesAuthorityDiagnostic =
  | { kind: "sidecar-open"; error: unknown }
  | { kind: "sidecar-corrupt"; corruption: ProjectNotesCorruption }
  | { kind: "migration-refused"; load: NotesLoadResult }
  | { kind: "migration-failed"; error: unknown }
  | { kind: "save-failed"; error: unknown }
  | { kind: "fallback-storage"; load: NotesLoadResult; save: NotesSaveResult | null };

export function isPhaseStartResult(value: unknown): value is PhaseStartResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.status === "accepted" || record.status === "already-bound") {
    return (
      hasExactKeys(record, ["status", "operationId", "session", "packageTokenCount"]) &&
      typeof record.operationId === "string" &&
      isNotesSessionLink(record.session) &&
      Number.isInteger(record.packageTokenCount) &&
      (record.packageTokenCount as number) >= 0
    );
  }
  return (
    record.status === "failed" &&
    hasExactKeys(record, ["status", "code", "operationId", "message"]) &&
    typeof record.code === "string" &&
    (record.operationId === null || typeof record.operationId === "string") &&
    typeof record.message === "string"
  );
}

function isNotesSessionLink(value: unknown): value is NotesSessionLink {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    hasExactKeys(value as Record<string, unknown>, ["sessionId", "sessionPath"]) &&
    typeof (value as NotesSessionLink).sessionId === "string" &&
    ((value as NotesSessionLink).sessionPath === null ||
      typeof (value as NotesSessionLink).sessionPath === "string")
  );
}

export function isProjectNotesSnapshot(value: unknown): value is ProjectNotesSnapshot {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["projectKey", "revision", "document"]) &&
    typeof value.projectKey === "string" &&
    value.projectKey.length > 0 &&
    Number.isInteger(value.revision) &&
    (value.revision as number) >= 0 &&
    isNotesDocumentV3(value.document)
  );
}

export function isProjectNotesReadOutcome(value: unknown): value is ProjectNotesReadOutcome {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  if (value.status === "missing") return hasExactKeys(value, ["status"]);
  if (value.status === "corrupt") return isCorruption(value);
  return (
    value.status === "ok" &&
    typeof value.recoveredFromBackup === "boolean" &&
    isProjectNotesSnapshot(value.snapshot)
  );
}

export function isProjectNotesMigrationOutcome(
  value: unknown,
): value is ProjectNotesMigrationOutcome {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  if (value.status === "invalid") return isInvalidOutcome(value);
  if (value.status === "corrupt") return isCorruption(value);
  return (
    value.status === "ok" &&
    typeof value.migrated === "boolean" &&
    isProjectNotesSnapshot(value.snapshot)
  );
}

export function isProjectNotesSaveOutcome(value: unknown): value is ProjectNotesSaveOutcome {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  if (value.status === "missing") return hasExactKeys(value, ["status"]);
  if (value.status === "invalid") return isInvalidOutcome(value);
  if (value.status === "corrupt") return isCorruption(value);
  return (
    (value.status === "ok" || value.status === "conflict") && isProjectNotesSnapshot(value.snapshot)
  );
}

export function isNotesChangeEvent(value: NotesSidecarEvent): value is NotesChangeEvent {
  return value.type === "notes_change" && isProjectNotesSnapshot(value.data);
}

export function isNotesReadyEvent(value: NotesSidecarEvent): value is NotesReadyEvent {
  return value.type === "ready";
}

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
const ROADMAP_STATUS_UPDATE_KEYS = [
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
const ROADMAP_REFERENCE_DECISION_KEYS = [
  "type",
  "id",
  "proposalId",
  "decision",
  "referenceId",
  "timestamp",
];
const ROADMAP_OVERRIDE_RESET_KEYS = ["type", "id", "field", "timestamp"];
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
  "manual-override",
  "done-terminal",
]);

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

/** Adds missing additive fields to legacy v3 phase and roadmap records, then validates. */
export function migrateNotesDocumentV3PhaseShape(value: unknown): NotesValidationResult {
  if (!isRecord(value) || !hasExactKeys(value, DOCUMENT_V3_KEYS) || value.version !== 3) {
    return validateNotesDocumentV3(value);
  }
  if (!Array.isArray(value.phases)) return validateNotesDocumentV3(value);

  let migrated = false;
  const phases = value.phases.map((phase) => {
    if (!isRecord(phase)) return phase;
    const keys = Object.keys(phase);
    const hasRequiredKeys = LEGACY_V3_PHASE_REQUIRED_KEYS.every((key) => keys.includes(key));
    const onlyCurrentKeys = keys.every((key) => PHASE_KEYS.includes(key));
    if (!hasRequiredKeys || !onlyCurrentKeys) return phase;

    const missingPhaseFields = !keys.includes("archivedAt") || !keys.includes("roadmapEvents");
    if (missingPhaseFields) migrated = true;
    const migratedPhase = {
      ...phase,
      archivedAt: keys.includes("archivedAt") ? phase.archivedAt : null,
      roadmapEvents: keys.includes("roadmapEvents") ? phase.roadmapEvents : [],
    };
    if (!Array.isArray(migratedPhase.roadmapEvents)) return migratedPhase;

    const roadmapEvents = migratedPhase.roadmapEvents.map((event) => {
      if (!isRecord(event) || event.type !== "status-update") return event;
      if (!Array.isArray(event.proposedReferences)) return event;
      let migratedEvent = false;
      const proposedReferences = event.proposedReferences.map((proposal) => {
        if (!isRecord(proposal) || !hasExactKeys(proposal, LEGACY_ROADMAP_PROPOSAL_KEYS)) {
          return proposal;
        }
        const policyOutcome =
          proposal.disposition === "pending"
            ? "manual-review"
            : proposal.disposition === "accepted" || proposal.disposition === "reused"
              ? proposal.disposition
              : null;
        if (policyOutcome === null) return proposal;
        migratedEvent = true;
        migrated = true;
        return { ...proposal, policyOutcome };
      });
      return migratedEvent ? { ...event, proposedReferences } : event;
    });
    return { ...migratedPhase, roadmapEvents };
  });
  return validateNotesDocumentV3(migrated ? { ...value, phases } : value);
}

export function validateNotesDocumentV3(value: unknown): NotesValidationResult {
  if (!isRecord(value) || !hasExactKeys(value, DOCUMENT_V3_KEYS)) {
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
    const error = validateReference(value.references[index], `references[${index}]`);
    if (error) return { ok: false, error };
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
    const error = validatePhase(phase, index, referenceIds);
    if (error) return { ok: false, error };
    const id = (phase as NotesPhase).id;
    if (phaseIds.has(id)) return invalid(`phases[${index}].id`, `duplicate ID: ${id}`);
    phaseIds.add(id);
  }
  return { ok: true, document: value as unknown as NotesDocumentV3 };
}

function validateNotesDocumentV2(value: unknown): NotesValidationError | null {
  if (!isRecord(value) || !hasExactKeys(value, DOCUMENT_V2_KEYS)) {
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
  const ids = new Set<string>();
  for (let index = 0; index < value.tasks.length; index += 1) {
    const task = value.tasks[index];
    if (!isTask(task)) return validationError(`tasks[${index}]`, "invalid task record");
    if (requireStableTaskIds) {
      if (!isNonEmptyString(task.id)) {
        return validationError(`tasks[${index}].id`, "expected a stable ID");
      }
      if (ids.has(task.id)) {
        return validationError(`tasks[${index}].id`, `duplicate ID: ${task.id}`);
      }
      ids.add(task.id);
    }
  }
  if (!isHandoff(value.handoff)) return validationError("handoff", "invalid handoff record");
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

function validateReference(value: unknown, path: string): NotesValidationError | null {
  if (!isRecord(value) || !hasExactKeys(value, REFERENCE_KEYS)) {
    return validationError(path, `expected exactly: ${REFERENCE_KEYS.join(", ")}`);
  }
  if (!isNonEmptyString(value.id)) return validationError(`${path}.id`, "expected a stable ID");
  if (!isNonEmptyString(value.provider))
    return validationError(`${path}.provider`, "expected a provider name");
  if (isReferenceMetadataTooLong(value.provider)) {
    return referenceMetadataLengthError(`${path}.provider`);
  }
  for (const field of ["tool", "revision", "path", "query", "anchor"] as const) {
    if (!isNullableNonEmptyString(value[field])) {
      return validationError(`${path}.${field}`, "expected a non-empty string or null");
    }
    if (isReferenceMetadataTooLong(value[field])) {
      return referenceMetadataLengthError(`${path}.${field}`);
    }
  }
  if (
    typeof value.canonicalUrl === "string" &&
    value.canonicalUrl.length > NOTES_REFERENCE_URL_MAX_LENGTH
  ) {
    return validationError(
      `${path}.canonicalUrl`,
      `expected ${NOTES_REFERENCE_URL_MAX_LENGTH.toLocaleString("en-US")} characters or fewer`,
    );
  }
  if (!isCanonicalHttpUrl(value.canonicalUrl)) {
    return validationError(
      `${path}.canonicalUrl`,
      "expected an absolute http(s) URL without username or password",
    );
  }
  if (!isNonEmptyString(value.owner))
    return validationError(`${path}.owner`, "repository owner is required");
  if (isReferenceMetadataTooLong(value.owner)) {
    return referenceMetadataLengthError(`${path}.owner`);
  }
  if (!isNonEmptyString(value.repo))
    return validationError(`${path}.repo`, "repository name is required");
  if (isReferenceMetadataTooLong(value.repo)) {
    return referenceMetadataLengthError(`${path}.repo`);
  }
  if (value.range !== null) {
    if (!isRecord(value.range) || !hasExactKeys(value.range, ["startLine", "endLine"])) {
      return validationError(`${path}.range`, "expected startLine and endLine or null");
    }
    if (!isPositiveInteger(value.range.startLine)) {
      return validationError(`${path}.range.startLine`, "expected a positive integer");
    }
    if (!isPositiveInteger(value.range.endLine) || value.range.endLine < value.range.startLine) {
      return validationError(`${path}.range.endLine`, "expected an integer at or after startLine");
    }
    if (value.path === null)
      return validationError(`${path}.path`, "path is required when range is present");
  }
  if (!isNullablePositiveInteger(value.issue)) {
    return validationError(`${path}.issue`, "expected a positive integer or null");
  }
  if (!isNullablePositiveInteger(value.pullRequest)) {
    return validationError(`${path}.pullRequest`, "expected a positive integer or null");
  }
  if (value.issue !== null && value.pullRequest !== null) {
    return validationError(
      `${path}.pullRequest`,
      "a reference cannot target both an issue and a pull request",
    );
  }
  const semanticError = validateReferenceCoordinates(value as unknown as NotesReference, path);
  if (semanticError) return semanticError;
  if (typeof value.relevance !== "string")
    return validationError(`${path}.relevance`, "expected a string");
  if (isReferenceMetadataTooLong(value.relevance)) {
    return referenceMetadataLengthError(`${path}.relevance`);
  }
  if (!isTimestamp(value.capturedAt))
    return validationError(`${path}.capturedAt`, "expected an ISO timestamp");
  return null;
}

function validateReferenceCoordinates(
  reference: NotesReference,
  path: string,
): NotesValidationError | null {
  if (reference.provider.trim().toLowerCase() !== "github") return null;
  const normalized = normalizeCanonicalUrl(reference.canonicalUrl)!;
  const url = new URL(normalized);
  if (url.hostname !== "github.com") {
    return validationError(`${path}.canonicalUrl`, "GitHub references must use a github.com URL");
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
      `${path}.canonicalUrl`,
      "URL owner and repository must match the stored repository",
    );
  }
  const directNumber = segments[3] && /^\d+$/.test(segments[3]) ? Number(segments[3]) : null;
  if (segments[2] === "issues" && directNumber !== null && reference.issue !== directNumber) {
    return validationError(`${path}.issue`, `expected ${directNumber} to match the issue URL`);
  }
  if (segments[2] === "pull" && directNumber !== null && reference.pullRequest !== directNumber) {
    return validationError(
      `${path}.pullRequest`,
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
  const path = `phases[${index}]`;
  if (!isRecord(value) || !hasExactKeys(value, PHASE_KEYS)) {
    return validationError(path, `expected exactly: ${PHASE_KEYS.join(", ")}`);
  }
  if (!isNonEmptyString(value.id)) return validationError(`${path}.id`, "expected a stable ID");
  if (!isNonEmptyString(value.title)) return validationError(`${path}.title`, "title is required");
  if (typeof value.goal !== "string") return validationError(`${path}.goal`, "expected a string");
  if (!Array.isArray(value.doneWhen) || !value.doneWhen.every(isNonEmptyString)) {
    return validationError(`${path}.doneWhen`, "expected non-empty criteria strings");
  }
  if (value.order !== index)
    return validationError(`${path}.order`, `expected ${index} to match array order`);
  if (!isPhaseStatus(value.status))
    return validationError(`${path}.status`, "unknown phase status");
  if (typeof value.sourcePrompt !== "string")
    return validationError(`${path}.sourcePrompt`, "expected a string");
  const linksError = validateReferenceIds(
    value.referenceIds,
    `${path}.referenceIds`,
    knownReferenceIds,
  );
  if (linksError) return linksError;
  const sessionError = validateSession(value.session, `${path}.session`);
  if (sessionError) return sessionError;
  const reminderError = validateReminder(value.reminder, `${path}.reminder`);
  if (reminderError) return reminderError;
  if (!isNullableNonEmptyString(value.attentionReason)) {
    return validationError(`${path}.attentionReason`, "expected a non-empty string or null");
  }
  if (!isTimestamp(value.createdAt))
    return validationError(`${path}.createdAt`, "expected an ISO timestamp");
  if (!isTimestamp(value.updatedAt))
    return validationError(`${path}.updatedAt`, "expected an ISO timestamp");
  if (!isNullableTimestamp(value.completedAt)) {
    return validationError(`${path}.completedAt`, "expected an ISO timestamp or null");
  }
  if (!isNullableTimestamp(value.archivedAt)) {
    return validationError(`${path}.archivedAt`, "expected an ISO timestamp or null");
  }
  const overridesError = validateOverrides(value.overrides, `${path}.overrides`, knownReferenceIds);
  if (overridesError) return overridesError;
  const lifecycleError = validateLifecycleEvents(
    value.lifecycleEvents,
    `${path}.lifecycleEvents`,
    value.status,
  );
  if (lifecycleError) return lifecycleError;
  return validateRoadmapEvents(value.roadmapEvents, `${path}.roadmapEvents`, knownReferenceIds);
}

function validateReferenceIds(
  value: unknown,
  path: string,
  knownReferenceIds: ReadonlySet<string>,
): NotesValidationError | null {
  if (!Array.isArray(value)) return validationError(path, "expected an array of reference IDs");
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const id = value[index];
    if (!isNonEmptyString(id)) return validationError(`${path}[${index}]`, "expected a stable ID");
    if (seen.has(id)) return validationError(`${path}[${index}]`, `duplicate link: ${id}`);
    if (!knownReferenceIds.has(id))
      return validationError(`${path}[${index}]`, `unknown reference ID: ${id}`);
    seen.add(id);
  }
  return null;
}

function validateSession(value: unknown, path: string): NotesValidationError | null {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, ["sessionId", "sessionPath"])) {
    return validationError(path, "expected sessionId and sessionPath or null");
  }
  if (!isNonEmptyString(value.sessionId)) {
    return validationError(`${path}.sessionId`, "session ID is required");
  }
  if (!isNullableNonEmptyString(value.sessionPath)) {
    return validationError(`${path}.sessionPath`, "expected a non-empty path or null");
  }
  return null;
}

function validateReminder(value: unknown, path: string): NotesValidationError | null {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, ["id", "dueAt", "note", "createdAt"])) {
    return validationError(path, "expected id, dueAt, note, and createdAt or null");
  }
  if (!isNonEmptyString(value.id)) return validationError(`${path}.id`, "reminder ID is required");
  if (!isTimestamp(value.dueAt))
    return validationError(`${path}.dueAt`, "expected an ISO timestamp");
  if (typeof value.note !== "string") return validationError(`${path}.note`, "expected a string");
  if (!isTimestamp(value.createdAt))
    return validationError(`${path}.createdAt`, "expected an ISO timestamp");
  return null;
}

function validateOverrides(
  value: unknown,
  path: string,
  knownReferenceIds: ReadonlySet<string>,
): NotesValidationError | null {
  if (!isRecord(value) || !hasExactKeys(value, ["status", "referenceIds"])) {
    return validationError(path, "expected status and referenceIds override markers");
  }
  if (value.status !== null) {
    if (!isRecord(value.status) || !hasExactKeys(value.status, ["value", "source", "updatedAt"])) {
      return validationError(`${path}.status`, "invalid status override marker");
    }
    if (!isPhaseStatus(value.status.value))
      return validationError(`${path}.status.value`, "unknown phase status");
    if (value.status.source !== "user")
      return validationError(`${path}.status.source`, "expected user");
    if (!isTimestamp(value.status.updatedAt)) {
      return validationError(`${path}.status.updatedAt`, "expected an ISO timestamp");
    }
  }
  if (value.referenceIds !== null) {
    if (
      !isRecord(value.referenceIds) ||
      !hasExactKeys(value.referenceIds, ["value", "source", "updatedAt"])
    ) {
      return validationError(`${path}.referenceIds`, "invalid reference override marker");
    }
    const error = validateReferenceIds(
      value.referenceIds.value,
      `${path}.referenceIds.value`,
      knownReferenceIds,
    );
    if (error) return error;
    if (value.referenceIds.source !== "user") {
      return validationError(`${path}.referenceIds.source`, "expected user");
    }
    if (!isTimestamp(value.referenceIds.updatedAt)) {
      return validationError(`${path}.referenceIds.updatedAt`, "expected an ISO timestamp");
    }
  }
  return null;
}

function validateLifecycleEvents(
  value: unknown,
  path: string,
  phaseStatus: NotesPhaseStatus,
): NotesValidationError | null {
  if (!Array.isArray(value)) return validationError(path, "expected an append-only event array");
  const ids = new Set<string>();
  let previousStatus: NotesPhaseStatus | null | undefined;
  let previousTimestamp = -Infinity;
  for (let index = 0; index < value.length; index += 1) {
    const event = value[index];
    const eventPath = `${path}[${index}]`;
    if (
      !isRecord(event) ||
      !hasExactKeys(event, ["id", "fromStatus", "toStatus", "source", "timestamp", "reason"])
    ) {
      return validationError(eventPath, "invalid lifecycle transition record");
    }
    if (!isNonEmptyString(event.id))
      return validationError(`${eventPath}.id`, "event ID is required");
    if (ids.has(event.id)) return validationError(`${eventPath}.id`, `duplicate ID: ${event.id}`);
    ids.add(event.id);
    if (event.fromStatus !== null && !isPhaseStatus(event.fromStatus)) {
      return validationError(`${eventPath}.fromStatus`, "unknown phase status");
    }
    if (!isPhaseStatus(event.toStatus))
      return validationError(`${eventPath}.toStatus`, "unknown phase status");
    if (event.fromStatus === event.toStatus)
      return validationError(eventPath, "transition must change status");
    if (previousStatus !== undefined && event.fromStatus !== previousStatus) {
      return validationError(`${eventPath}.fromStatus`, `expected ${previousStatus}`);
    }
    if (!isLifecycleEventSource(event.source)) {
      return validationError(`${eventPath}.source`, "unknown lifecycle event source");
    }
    if (!isTimestamp(event.timestamp))
      return validationError(`${eventPath}.timestamp`, "expected an ISO timestamp");
    const timestamp = Date.parse(event.timestamp);
    if (timestamp < previousTimestamp)
      return validationError(`${eventPath}.timestamp`, "events must be chronological");
    if (!isNullableNonEmptyString(event.reason)) {
      return validationError(`${eventPath}.reason`, "expected a non-empty string or null");
    }
    previousStatus = event.toStatus;
    previousTimestamp = timestamp;
  }
  if (value.length > 0 && previousStatus !== phaseStatus) {
    return validationError(path, `last event must end at phase status ${phaseStatus}`);
  }
  return null;
}

function validateRoadmapEvents(
  value: unknown,
  path: string,
  knownReferenceIds: ReadonlySet<string>,
): NotesValidationError | null {
  if (!Array.isArray(value)) return validationError(path, "expected an append-only event array");
  const eventIds = new Set<string>();
  const proposalIds = new Set<string>();
  const pendingProposalIds = new Set<string>();
  const decidedProposalIds = new Set<string>();
  let previousTimestamp = -Infinity;

  for (let index = 0; index < value.length; index += 1) {
    const event = value[index];
    const eventPath = `${path}[${index}]`;
    if (!isRecord(event) || !isNonEmptyString(event.id)) {
      return validationError(`${eventPath}.id`, "event ID is required");
    }
    if (eventIds.has(event.id))
      return validationError(`${eventPath}.id`, `duplicate ID: ${event.id}`);
    eventIds.add(event.id);
    if (!isTimestamp(event.timestamp)) {
      return validationError(`${eventPath}.timestamp`, "expected an ISO timestamp");
    }
    const timestamp = Date.parse(event.timestamp);
    if (timestamp < previousTimestamp) {
      return validationError(`${eventPath}.timestamp`, "events must be chronological");
    }
    previousTimestamp = timestamp;

    if (event.type === "status-update") {
      if (!hasExactKeys(event, ROADMAP_STATUS_UPDATE_KEYS)) {
        return validationError(eventPath, "invalid roadmap status update");
      }
      if (
        typeof event.actor !== "string" ||
        !ROADMAP_ACTORS.has(event.actor as NotesRoadmapActor)
      ) {
        return validationError(`${eventPath}.actor`, "unknown roadmap actor");
      }
      if (
        typeof event.transition !== "string" ||
        !ROADMAP_TRANSITIONS.has(event.transition as NotesRoadmapTransition)
      ) {
        return validationError(`${eventPath}.transition`, "unknown roadmap transition");
      }
      if (!isBoundedNonEmptyString(event.progress, 4_096)) {
        return validationError(`${eventPath}.progress`, "expected 1 to 4,096 characters");
      }
      if (event.transition === "blocked") {
        if (!isBoundedNonEmptyString(event.blocker, 1_024)) {
          return validationError(`${eventPath}.blocker`, "blocked reports require a blocker");
        }
      } else if (event.blocker !== null) {
        return validationError(
          `${eventPath}.blocker`,
          "only blocked reports may include a blocker",
        );
      }
      if (
        !Array.isArray(event.evidence) ||
        event.evidence.length > 20 ||
        !event.evidence.every((item) => isBoundedNonEmptyString(item, 4_096))
      ) {
        return validationError(`${eventPath}.evidence`, "expected up to 20 bounded evidence items");
      }
      if (event.transition === "review" && event.evidence.length === 0) {
        return validationError(`${eventPath}.evidence`, "review reports require evidence");
      }
      if (
        typeof event.statusOutcome !== "string" ||
        !ROADMAP_STATUS_OUTCOMES.has(event.statusOutcome as NotesRoadmapStatusOutcome)
      ) {
        return validationError(`${eventPath}.statusOutcome`, "unknown status outcome");
      }
      if (!Array.isArray(event.proposedReferences) || event.proposedReferences.length > 20) {
        return validationError(`${eventPath}.proposedReferences`, "expected up to 20 proposals");
      }
      for (
        let proposalIndex = 0;
        proposalIndex < event.proposedReferences.length;
        proposalIndex += 1
      ) {
        const proposal = event.proposedReferences[proposalIndex];
        const proposalPath = `${eventPath}.proposedReferences[${proposalIndex}]`;
        const error = validateRoadmapProposal(
          proposal,
          proposalPath,
          event.timestamp,
          knownReferenceIds,
        );
        if (error) return error;
        const id = (proposal as NotesRoadmapReferenceProposal).id;
        if (proposalIds.has(id))
          return validationError(`${proposalPath}.id`, `duplicate ID: ${id}`);
        proposalIds.add(id);
        if ((proposal as NotesRoadmapReferenceProposal).disposition === "pending") {
          pendingProposalIds.add(id);
        }
      }
      continue;
    }

    if (event.type === "reference-decision") {
      if (!hasExactKeys(event, ROADMAP_REFERENCE_DECISION_KEYS)) {
        return validationError(eventPath, "invalid reference decision");
      }
      if (!isNonEmptyString(event.proposalId) || !pendingProposalIds.has(event.proposalId)) {
        return validationError(`${eventPath}.proposalId`, "expected a prior pending proposal ID");
      }
      if (decidedProposalIds.has(event.proposalId)) {
        return validationError(`${eventPath}.proposalId`, "proposal already has a decision");
      }
      if (event.decision !== "accepted" && event.decision !== "rejected") {
        return validationError(`${eventPath}.decision`, "expected accepted or rejected");
      }
      if (event.decision === "accepted") {
        if (!isNonEmptyString(event.referenceId) || !knownReferenceIds.has(event.referenceId)) {
          return validationError(
            `${eventPath}.referenceId`,
            "accepted decisions require a known reference ID",
          );
        }
      } else if (event.referenceId !== null) {
        return validationError(
          `${eventPath}.referenceId`,
          "rejected decisions cannot attach a reference",
        );
      }
      decidedProposalIds.add(event.proposalId);
      continue;
    }

    if (event.type === "override-reset") {
      if (!hasExactKeys(event, ROADMAP_OVERRIDE_RESET_KEYS)) {
        return validationError(eventPath, "invalid override reset");
      }
      if (event.field !== "status" && event.field !== "references") {
        return validationError(`${eventPath}.field`, "expected status or references");
      }
      continue;
    }
    return validationError(`${eventPath}.type`, "unknown roadmap event type");
  }
  return null;
}

function validateRoadmapProposal(
  value: unknown,
  path: string,
  timestamp: string,
  knownReferenceIds: ReadonlySet<string>,
): NotesValidationError | null {
  if (!isRecord(value) || !hasExactKeys(value, ROADMAP_PROPOSAL_KEYS)) {
    return validationError(path, `expected exactly: ${ROADMAP_PROPOSAL_KEYS.join(", ")}`);
  }
  if (!isNonEmptyString(value.id)) return validationError(`${path}.id`, "proposal ID is required");
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
    path,
  );
  if (referenceError) return referenceError;
  if (
    value.disposition !== "pending" &&
    value.disposition !== "accepted" &&
    value.disposition !== "reused"
  ) {
    return validationError(`${path}.disposition`, "expected pending, accepted, or reused");
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
      `${path}.policyOutcome`,
      "expected manual-review, reference-override-protected, accepted, or reused",
    );
  }
  if (value.disposition !== expectedDisposition) {
    return validationError(`${path}.policyOutcome`, "must match the proposal disposition");
  }
  if (value.disposition === "accepted" || value.disposition === "reused") {
    if (!isNonEmptyString(value.referenceId) || !knownReferenceIds.has(value.referenceId)) {
      return validationError(
        `${path}.referenceId`,
        "accepted or reused proposals require a known reference ID",
      );
    }
  } else if (value.referenceId !== null) {
    return validationError(`${path}.referenceId`, "pending proposals cannot attach a reference");
  }
  return null;
}

function isTask(value: unknown): value is NotesTask {
  return (
    isRecord(value) &&
    hasExactKeys(value, TASK_KEYS) &&
    typeof value.id === "string" &&
    typeof value.text === "string" &&
    (value.status === "todo" || value.status === "done") &&
    isTimestamp(value.createdAt) &&
    isTimestamp(value.updatedAt) &&
    isNullableTimestamp(value.completedAt) &&
    isNullableTimestamp(value.archivedAt)
  );
}

function isHandoff(value: unknown): value is NotesHandoff {
  return (
    isRecord(value) &&
    hasExactKeys(value, HANDOFF_KEYS) &&
    typeof value.text === "string" &&
    isNullableTimestamp(value.updatedAt) &&
    isNullableTimestamp(value.readAt)
  );
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

function referenceMetadataLengthError(path: string): NotesValidationError {
  return validationError(
    path,
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

function isCanonicalHttpUrl(value: unknown): value is string {
  return typeof value === "string" && normalizeCanonicalUrl(value) !== null;
}

function isInvalidOutcome(value: Record<string, unknown>): boolean {
  return (
    value.status === "invalid" &&
    hasExactKeys(value, ["status", "error"]) &&
    isRecord(value.error) &&
    hasExactKeys(value.error, ["path", "message"]) &&
    typeof value.error.path === "string" &&
    typeof value.error.message === "string"
  );
}

function isCorruption(value: unknown): value is { status: "corrupt" } & ProjectNotesCorruption {
  return (
    isRecord(value) &&
    value.status === "corrupt" &&
    isNullableCorruptReason(value.primary) &&
    isNullableCorruptReason(value.backup)
  );
}

function isNullableCorruptReason(value: unknown): value is ProjectNotesCorruptReason | null {
  return (
    value === null ||
    value === "malformed-json" ||
    value === "invalid-envelope" ||
    value === "project-key-mismatch"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
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
