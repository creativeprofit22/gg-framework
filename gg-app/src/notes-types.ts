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

export interface NotesDocumentV2 {
  version: 2;
  reference: string;
  currentFocus: string;
  tasks: NotesTask[];
  handoff: NotesHandoff;
  updatedAt: string;
  legacyImportedAt: string | null;
}

export type NotesParseFailureReason = "malformed-json" | "unsupported-version" | "invalid-shape";

export type NotesParseResult =
  | { ok: true; document: NotesDocumentV2 }
  | { ok: false; reason: NotesParseFailureReason };

export type NotesLoadSource = "v2" | "legacy" | "empty" | "legacy-fallback";

export type NotesMigrationEligibility =
  | "valid-v2"
  | "valid-legacy"
  | "empty"
  | "ineligible-unreadable"
  | "ineligible-invalid-v2";

export type NotesLoadDiagnostic =
  | { kind: "v2-parse"; reason: NotesParseFailureReason }
  | { kind: "storage-read"; key: string; error: unknown }
  | { kind: "storage-write"; key: string; error: unknown }
  | { kind: "ambiguous-legacy"; selectedKey: string; matchingKeys: string[] };

export interface NotesLoadResult {
  document: NotesDocumentV2;
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
  v2: NotesWriteResult;
}

export interface ProjectNotesSnapshot {
  projectKey: string;
  revision: number;
  document: NotesDocumentV2;
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
  | { status: "invalid" };

export type ProjectNotesSaveOutcome =
  | { status: "ok"; snapshot: ProjectNotesSnapshot }
  | { status: "conflict"; snapshot: ProjectNotesSnapshot }
  | { status: "missing" }
  | ({ status: "corrupt" } & ProjectNotesCorruption)
  | { status: "invalid" };

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
  migrateNotes(document: NotesDocumentV2): Promise<ProjectNotesMigrationOutcome>;
  saveNotes(expectedRevision: number, document: NotesDocumentV2): Promise<ProjectNotesSaveOutcome>;
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
    isNotesDocumentV2(value.document)
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
  if (value.status === "invalid") return hasExactKeys(value, ["status"]);
  if (value.status === "corrupt") return isCorruption(value);
  return (
    value.status === "ok" &&
    typeof value.migrated === "boolean" &&
    isProjectNotesSnapshot(value.snapshot)
  );
}

export function isProjectNotesSaveOutcome(value: unknown): value is ProjectNotesSaveOutcome {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  if (value.status === "missing" || value.status === "invalid") {
    return hasExactKeys(value, ["status"]);
  }
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

export function isNotesDocumentV2(value: unknown): value is NotesDocumentV2 {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "version",
      "reference",
      "currentFocus",
      "tasks",
      "handoff",
      "updatedAt",
      "legacyImportedAt",
    ]) &&
    value.version === 2 &&
    typeof value.reference === "string" &&
    typeof value.currentFocus === "string" &&
    Array.isArray(value.tasks) &&
    value.tasks.every(isTask) &&
    isHandoff(value.handoff) &&
    isTimestamp(value.updatedAt) &&
    isNullableTimestamp(value.legacyImportedAt)
  );
}

function isTask(value: unknown): value is NotesTask {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "id",
      "text",
      "status",
      "createdAt",
      "updatedAt",
      "completedAt",
      "archivedAt",
    ]) &&
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
    hasExactKeys(value, ["text", "updatedAt", "readAt"]) &&
    typeof value.text === "string" &&
    isNullableTimestamp(value.updatedAt) &&
    isNullableTimestamp(value.readAt)
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
