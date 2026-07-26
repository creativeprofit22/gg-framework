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
];
const ORIGINAL_V3_PHASE_KEYS = [
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
  "overrides",
  "lifecycleEvents",
];
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

/** Adds the Phase 18 archive marker to the original v3 phase shape. */
export function migrateNotesDocumentV3PhaseArchive(value: unknown): NotesValidationResult {
  if (!isRecord(value) || !hasExactKeys(value, DOCUMENT_V3_KEYS) || value.version !== 3) {
    return validateNotesDocumentV3(value);
  }
  if (!Array.isArray(value.phases)) return validateNotesDocumentV3(value);

  let migrated = false;
  const phases = value.phases.map((phase) => {
    if (!isRecord(phase) || !hasExactKeys(phase, ORIGINAL_V3_PHASE_KEYS)) return phase;
    migrated = true;
    return { ...phase, archivedAt: null };
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
  for (let index = 0; index < value.references.length; index += 1) {
    const error = validateReference(value.references[index], `references[${index}]`);
    if (error) return { ok: false, error };
    const id = (value.references[index] as NotesReference).id;
    if (referenceIds.has(id)) return invalid(`references[${index}].id`, `duplicate ID: ${id}`);
    referenceIds.add(id);
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
  for (const field of ["tool", "revision", "path", "query", "anchor"] as const) {
    if (!isNullableNonEmptyString(value[field])) {
      return validationError(`${path}.${field}`, "expected a non-empty string or null");
    }
  }
  if (!isCanonicalHttpUrl(value.canonicalUrl)) {
    return validationError(`${path}.canonicalUrl`, "expected an absolute http(s) URL");
  }
  if (!isNonEmptyString(value.owner))
    return validationError(`${path}.owner`, "repository owner is required");
  if (!isNonEmptyString(value.repo))
    return validationError(`${path}.repo`, "repository name is required");
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
    return validationError(path, "a reference cannot target both an issue and a pull request");
  }
  if (typeof value.relevance !== "string")
    return validationError(`${path}.relevance`, "expected a string");
  if (!isTimestamp(value.capturedAt))
    return validationError(`${path}.capturedAt`, "expected an ISO timestamp");
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
  return validateLifecycleEvents(value.lifecycleEvents, `${path}.lifecycleEvents`, value.status);
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
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0;
  } catch {
    return false;
  }
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
