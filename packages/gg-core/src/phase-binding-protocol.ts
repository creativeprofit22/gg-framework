import {
  isNotesSessionLink,
  type NotesSessionLink,
  type ProjectNotesCorruptReason,
} from "./project-notes.js";

export type PhaseBindingAction = "bind-current" | "rebind-current";

export interface PhaseBindingRequest {
  version: 1;
  action: PhaseBindingAction;
  phaseId: string;
  expectedProjectKey: string;
  expectedRevision: number;
  expectedPreviousSession: NotesSessionLink | null;
  operationId: string;
  confirmRebind: boolean;
}

export type PhaseBindingOutcome =
  | {
      status: "committed" | "duplicate";
      revision: number;
      phaseId: string;
      previousSession: NotesSessionLink | null;
      session: NotesSessionLink;
    }
  | {
      status: "already-bound";
      revision: number;
      phaseId: string;
      session: NotesSessionLink;
    }
  | { status: "duplicate-id-conflict" | "stale-revision"; revision: number }
  | {
      status: "stale-previous-session";
      revision: number;
      currentSession: NotesSessionLink | null;
    }
  | { status: "project-mismatch"; revision: number; currentProjectKey: string }
  | {
      status: "phase-not-found" | "phase-archived" | "phase-terminal" | "missing-session-path";
    }
  | { status: "missing" }
  | {
      status: "corrupt";
      primary: ProjectNotesCorruptReason | null;
      backup: ProjectNotesCorruptReason | null;
    };

const REQUEST_KEYS = [
  "version",
  "action",
  "phaseId",
  "expectedProjectKey",
  "expectedRevision",
  "expectedPreviousSession",
  "operationId",
  "confirmRebind",
] as const;
const COMMITTED_KEYS = [
  "status",
  "revision",
  "phaseId",
  "previousSession",
  "session",
] as const;
const ALREADY_BOUND_KEYS = ["status", "revision", "phaseId", "session"] as const;
const REVISION_KEYS = ["status", "revision"] as const;
const STALE_SESSION_KEYS = ["status", "revision", "currentSession"] as const;
const PROJECT_MISMATCH_KEYS = ["status", "revision", "currentProjectKey"] as const;
const STATUS_KEYS = ["status"] as const;
const CORRUPT_KEYS = ["status", "primary", "backup"] as const;
const CORRUPT_REASONS: ReadonlySet<string> = new Set([
  "malformed-json",
  "invalid-envelope",
  "project-key-mismatch",
]);
const MAX_ID_LENGTH = 256;
const MAX_PROJECT_KEY_LENGTH = 4096;

export function isPhaseBindingRequest(value: unknown): value is PhaseBindingRequest {
  if (!isRecordWithExactKeys(value, REQUEST_KEYS)) return false;
  if (
    value.version !== 1 ||
    (value.action !== "bind-current" && value.action !== "rebind-current") ||
    !isBoundedString(value.phaseId, MAX_ID_LENGTH) ||
    !isBoundedString(value.expectedProjectKey, MAX_PROJECT_KEY_LENGTH) ||
    !isRevision(value.expectedRevision) ||
    !isNullableSessionLink(value.expectedPreviousSession) ||
    !isBoundedString(value.operationId, MAX_ID_LENGTH) ||
    typeof value.confirmRebind !== "boolean"
  ) {
    return false;
  }
  return value.action === "bind-current"
    ? value.expectedPreviousSession === null && !value.confirmRebind
    : value.expectedPreviousSession !== null && value.confirmRebind;
}

export function isPhaseBindingOutcome(value: unknown): value is PhaseBindingOutcome {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const status = (value as { status?: unknown }).status;
  if (status === "committed" || status === "duplicate") {
    return (
      isRecordWithExactKeys(value, COMMITTED_KEYS) &&
      isRevision(value.revision) &&
      isBoundedString(value.phaseId, MAX_ID_LENGTH) &&
      isNullableSessionLink(value.previousSession) &&
      isNotesSessionLink(value.session)
    );
  }
  if (status === "already-bound") {
    return (
      isRecordWithExactKeys(value, ALREADY_BOUND_KEYS) &&
      isRevision(value.revision) &&
      isBoundedString(value.phaseId, MAX_ID_LENGTH) &&
      isNotesSessionLink(value.session)
    );
  }
  if (status === "duplicate-id-conflict" || status === "stale-revision") {
    return isRecordWithExactKeys(value, REVISION_KEYS) && isRevision(value.revision);
  }
  if (status === "stale-previous-session") {
    return (
      isRecordWithExactKeys(value, STALE_SESSION_KEYS) &&
      isRevision(value.revision) &&
      isNullableSessionLink(value.currentSession)
    );
  }
  if (status === "project-mismatch") {
    return (
      isRecordWithExactKeys(value, PROJECT_MISMATCH_KEYS) &&
      isRevision(value.revision) &&
      isBoundedString(value.currentProjectKey, MAX_PROJECT_KEY_LENGTH)
    );
  }
  if (
    status === "phase-not-found" ||
    status === "phase-archived" ||
    status === "phase-terminal" ||
    status === "missing-session-path" ||
    status === "missing"
  ) {
    return isRecordWithExactKeys(value, STATUS_KEYS);
  }
  if (status === "corrupt") {
    return (
      isRecordWithExactKeys(value, CORRUPT_KEYS) &&
      (value.primary === null ||
        (typeof value.primary === "string" && CORRUPT_REASONS.has(value.primary))) &&
      (value.backup === null ||
        (typeof value.backup === "string" && CORRUPT_REASONS.has(value.backup)))
    );
  }
  return false;
}

function isNullableSessionLink(value: unknown): value is NotesSessionLink | null {
  return value === null || isNotesSessionLink(value);
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function isRecordWithExactKeys<const Keys extends readonly string[]>(
  value: unknown,
  expected: Keys,
): value is Record<Keys[number], unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => actual.includes(key));
}
