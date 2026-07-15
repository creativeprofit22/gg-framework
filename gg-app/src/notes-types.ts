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
