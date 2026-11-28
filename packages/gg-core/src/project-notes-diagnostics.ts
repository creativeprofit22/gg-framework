import { isNotesSessionLink, type NotesSessionLink } from "./project-notes.js";

export const PROJECT_NOTES_DIAGNOSTIC_CONSISTENCIES = [
  "consistent",
  "unbound",
  "bound-to-other-session",
  "identity-mismatch",
  "project-mismatch",
  "store-unavailable",
] as const;

export type ProjectNotesDiagnosticConsistency =
  (typeof PROJECT_NOTES_DIAGNOSTIC_CONSISTENCIES)[number];

export interface ProjectNotesDiagnosticPhaseLink {
  phaseId: string;
  projectKey: string;
  session: NotesSessionLink;
}

export interface ProjectNotesStorageDiagnostics {
  version: 1;
  applicationIdentity: string | null;
  daemonOwner: "node-sidecar";
  agentDataRoot: string;
  canonicalCwd: string;
  projectKey: string;
  projectNotesStore: {
    primaryPath: string;
    backupPath: string;
  };
  logicalSessionId: string;
  currentSession: NotesSessionLink;
  activePhaseContext: ProjectNotesDiagnosticPhaseLink | null;
  persistedPhaseBinding: ProjectNotesDiagnosticPhaseLink | null;
  consistency: ProjectNotesDiagnosticConsistency;
}

const DIAGNOSTIC_KEYS = [
  "version",
  "applicationIdentity",
  "daemonOwner",
  "agentDataRoot",
  "canonicalCwd",
  "projectKey",
  "projectNotesStore",
  "logicalSessionId",
  "currentSession",
  "activePhaseContext",
  "persistedPhaseBinding",
  "consistency",
] as const;
const STORE_KEYS = ["primaryPath", "backupPath"] as const;
const PHASE_LINK_KEYS = ["phaseId", "projectKey", "session"] as const;
const CONSISTENCY_SET: ReadonlySet<string> = new Set(PROJECT_NOTES_DIAGNOSTIC_CONSISTENCIES);

export function isProjectNotesStorageDiagnostics(
  value: unknown,
): value is ProjectNotesStorageDiagnostics {
  if (!isRecordWithExactKeys(value, DIAGNOSTIC_KEYS)) return false;
  const hasValidIdentity =
    value.applicationIdentity === null ||
    isProjectNotesApplicationIdentity(value.applicationIdentity);
  return (
    value.version === 1 &&
    hasValidIdentity &&
    (value.applicationIdentity !== null || value.consistency === "identity-mismatch") &&
    value.daemonOwner === "node-sidecar" &&
    isAbsolutePath(value.agentDataRoot) &&
    isAbsolutePath(value.canonicalCwd) &&
    isNonEmptyString(value.projectKey) &&
    isProjectNotesStore(value.projectNotesStore) &&
    isNonEmptyString(value.logicalSessionId) &&
    isDiagnosticSessionLink(value.currentSession) &&
    isNullablePhaseLink(value.activePhaseContext) &&
    isNullablePhaseLink(value.persistedPhaseBinding) &&
    typeof value.consistency === "string" &&
    CONSISTENCY_SET.has(value.consistency)
  );
}

function isProjectNotesStore(value: unknown): boolean {
  return (
    isRecordWithExactKeys(value, STORE_KEYS) &&
    isAbsolutePath(value.primaryPath) &&
    isAbsolutePath(value.backupPath)
  );
}

function isNullablePhaseLink(value: unknown): value is ProjectNotesDiagnosticPhaseLink | null {
  if (value === null) return true;
  return (
    isRecordWithExactKeys(value, PHASE_LINK_KEYS) &&
    isNonEmptyString(value.phaseId) &&
    isNonEmptyString(value.projectKey) &&
    isDiagnosticSessionLink(value.session)
  );
}

function isDiagnosticSessionLink(value: unknown): value is NotesSessionLink {
  return (
    isNotesSessionLink(value) && (value.sessionPath === null || isAbsolutePath(value.sessionPath))
  );
}

export function isProjectNotesApplicationIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    /^[A-Za-z0-9._-]+$/.test(value)
  );
}

function isAbsolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    (/^\//.test(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value))
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecordWithExactKeys<const Keys extends readonly string[]>(
  value: unknown,
  expected: Keys,
): value is Record<Keys[number], unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => actual.includes(key));
}
