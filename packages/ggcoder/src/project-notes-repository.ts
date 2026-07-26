import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { withFileLock } from "@kenkaiiii/gg-core";

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
const SESSION_KEYS = ["sessionId", "sessionPath"];
const REMINDER_KEYS = ["id", "dueAt", "note", "createdAt"];
const OVERRIDES_KEYS = ["status", "referenceIds"];
const STATUS_OVERRIDE_KEYS = ["value", "source", "updatedAt"];
const REFERENCE_IDS_OVERRIDE_KEYS = ["value", "source", "updatedAt"];
const LIFECYCLE_EVENT_KEYS = ["id", "fromStatus", "toStatus", "source", "timestamp", "reason"];
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
  for (let index = 0; index < value.references.length; index += 1) {
    const referenceError = validateReference(value.references[index], `references[${index}]`);
    if (referenceError) return { ok: false, error: referenceError };
    const id = (value.references[index] as NotesReference).id;
    if (referenceIds.has(id)) return invalid(`references[${index}].id`, `duplicate ID: ${id}`);
    referenceIds.add(id);
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
  const nullableStringFields = ["tool", "revision", "path", "query", "anchor"] as const;
  for (const field of nullableStringFields) {
    if (!isNullableNonEmptyString(value[field])) {
      return validationError(`${pathPrefix}.${field}`, "expected a non-empty string or null");
    }
  }
  if (!isCanonicalHttpUrl(value.canonicalUrl)) {
    return validationError(`${pathPrefix}.canonicalUrl`, "expected an absolute http(s) URL");
  }
  if (!isNonEmptyString(value.owner)) {
    return validationError(`${pathPrefix}.owner`, "repository owner is required");
  }
  if (!isNonEmptyString(value.repo)) {
    return validationError(`${pathPrefix}.repo`, "repository name is required");
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
      pathPrefix,
      "a reference cannot target both an issue and a pull request",
    );
  }
  if (typeof value.relevance !== "string") {
    return validationError(`${pathPrefix}.relevance`, "expected a string");
  }
  if (!isTimestamp(value.capturedAt)) {
    return validationError(`${pathPrefix}.capturedAt`, "expected an ISO timestamp");
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
  return validateLifecycleEvents(
    value.lifecycleEvents,
    `${pathPrefix}.lifecycleEvents`,
    value.status,
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
    if (!isRecordWithKeys(phase, ORIGINAL_V3_PHASE_KEYS)) return phase;
    migratedLegacyShape = true;
    return { ...phase, archivedAt: null };
  });
  if (!migratedLegacyShape) return current;
  const migrated = validateNotesDocumentV3({ ...value, phases });
  return { ...migrated, migratedLegacyShape: migrated.ok };
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
      const appendOnlyError = validateAppendOnlyLifecycleEvents(
        current.envelope.document,
        validated.document,
      );
      if (appendOnlyError) return { status: "invalid", error: appendOnlyError };

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
