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

export interface PhaseLeaseHolderV1 {
  daemonInstanceId: string;
  sessionId: string;
  sessionPath: string | null;
  processId: number;
}

export interface PhaseLeaseV1 {
  version: 1;
  projectKey: string;
  phaseId: string;
  planId: string | null;
  leaseId: string;
  fence: number;
  holder: PhaseLeaseHolderV1;
  runState: "idle" | "running";
  acquiredAt: string;
  renewedAt: string;
  expiresAt: string;
  operationId: string;
}

export interface PhaseLeaseTokenV1 {
  leaseId: string;
  fence: number;
}

export type PhaseLeaseAction = "inspect" | "acquire" | "renew" | "takeover";

export interface PhaseLeaseRequestV2 {
  version: 2;
  action: PhaseLeaseAction;
  phaseId: string;
  expectedProjectKey: string;
  expectedRevision: number;
  planId: string | null;
  operationId: string;
  lease: PhaseLeaseTokenV1 | null;
  confirmTakeover: boolean;
  takeoverReason: string | null;
  predecessorProof: null;
}

export type PhaseBindingProtocolRequest =
  | PhaseBindingRequest
  | PhaseLeaseRequestV2
;

export type PhaseLeaseOutcome =
  | {
      status: "inspected" | "acquired" | "renewed" | "duplicate";
      roadmapRevision: number;
      leaseRevision: number;
      phaseId: string;
      lease: PhaseLeaseV1 | null;
    }
  | {
      status: "phase-lease-held" | "phase-lease-lost" | "lease-owner-unreachable";
      roadmapRevision: number;
      leaseRevision: number;
      currentLease: PhaseLeaseV1 | null;
    }
  | {
      status: "operation-conflict" | "stale-revision";
      roadmapRevision: number;
      leaseRevision: number;
    }
  | { status: "project-mismatch"; roadmapRevision: number; currentProjectKey: string }
  | { status: "phase-not-found" | "phase-archived" | "phase-terminal" | "plan-mismatch" }
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
const LEASE_REQUEST_KEYS = [
  "version",
  "action",
  "phaseId",
  "expectedProjectKey",
  "expectedRevision",
  "planId",
  "operationId",
  "lease",
  "confirmTakeover",
  "takeoverReason",
  "predecessorProof",
] as const;
const LEASE_TOKEN_KEYS = ["leaseId", "fence"] as const;
const LEASE_HOLDER_KEYS = ["daemonInstanceId", "sessionId", "sessionPath", "processId"] as const;
const LEASE_KEYS = [
  "version",
  "projectKey",
  "phaseId",
  "planId",
  "leaseId",
  "fence",
  "holder",
  "runState",
  "acquiredAt",
  "renewedAt",
  "expiresAt",
  "operationId",
] as const;
const RECONCILIATION_PLAN_KEYS = [
  "planId",
  "contentHash",
  "snapshotPath",
  "approvedAt",
  "approvedRevision",
  "baseCommit",
] as const;
const RECONCILIATION_REQUEST_KEYS = [
  "version",
  "action",
  "phaseId",
  "expectedProjectKey",
  "expectedRevision",
  "operationId",
  "repository",
  "plan",
  "workspace",
] as const;
const RECONCILIATION_SUCCESS_KEYS = [
  "status",
  "revision",
  "phaseId",
  "preservedStepIds",
  "revalidationStepIds",
  "revalidationEvidenceCount",
  "reconciledAt",
] as const;
const COMMITTED_KEYS = ["status", "revision", "phaseId", "previousSession", "session"] as const;
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


export function isPhaseBindingProtocolRequest(
  value: unknown,
): value is PhaseBindingProtocolRequest {
  return (
    isPhaseBindingRequest(value) ||
    isPhaseLeaseRequest(value)
  );
}

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

export function isPhaseLeaseRequest(value: unknown): value is PhaseLeaseRequestV2 {
  if (!isRecordWithExactKeys(value, LEASE_REQUEST_KEYS)) return false;
  if (
    value.version !== 2 ||
    (value.action !== "inspect" &&
      value.action !== "acquire" &&
      value.action !== "renew" &&
      value.action !== "takeover") ||
    !isBoundedString(value.phaseId, MAX_ID_LENGTH) ||
    !isBoundedString(value.expectedProjectKey, MAX_PROJECT_KEY_LENGTH) ||
    !isRevision(value.expectedRevision) ||
    (value.planId !== null && !isBoundedString(value.planId, MAX_ID_LENGTH)) ||
    !isBoundedString(value.operationId, MAX_ID_LENGTH) ||
    !isNullableLeaseToken(value.lease) ||
    typeof value.confirmTakeover !== "boolean" ||
    (value.takeoverReason !== null && !isBoundedString(value.takeoverReason, 1024)) ||
    value.predecessorProof !== null
  ) {
    return false;
  }
  if (value.action === "inspect" || value.action === "acquire") {
    return value.lease === null && !value.confirmTakeover && value.takeoverReason === null;
  }
  if (value.action === "renew") {
    return value.lease !== null && !value.confirmTakeover && value.takeoverReason === null;
  }
  return value.lease !== null && value.confirmTakeover && value.takeoverReason !== null;
}

export function isPhaseLease(value: unknown): value is PhaseLeaseV1 {
  if (!isRecordWithExactKeys(value, LEASE_KEYS)) return false;
  if (
    value.version !== 1 ||
    !isBoundedString(value.projectKey, MAX_PROJECT_KEY_LENGTH) ||
    !isBoundedString(value.phaseId, MAX_ID_LENGTH) ||
    (value.planId !== null && !isBoundedString(value.planId, MAX_ID_LENGTH)) ||
    !isBoundedString(value.leaseId, MAX_ID_LENGTH) ||
    !isPositiveSafeInteger(value.fence) ||
    !isPhaseLeaseHolder(value.holder) ||
    (value.runState !== "idle" && value.runState !== "running") ||
    !isTimestamp(value.acquiredAt) ||
    !isTimestamp(value.renewedAt) ||
    !isTimestamp(value.expiresAt) ||
    !isBoundedString(value.operationId, MAX_ID_LENGTH)
  ) {
    return false;
  }
  const acquiredAt = Date.parse(value.acquiredAt as string);
  const renewedAt = Date.parse(value.renewedAt as string);
  const expiresAt = Date.parse(value.expiresAt as string);
  return acquiredAt <= renewedAt && renewedAt < expiresAt;
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

export function isPhaseLeaseOutcome(value: unknown): value is PhaseLeaseOutcome {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const status = (value as { status?: unknown }).status;
  if (
    status === "inspected" ||
    status === "acquired" ||
    status === "renewed" ||
    status === "duplicate"
  ) {
    return (
      isRecordWithExactKeys(value, [
        "status",
        "roadmapRevision",
        "leaseRevision",
        "phaseId",
        "lease",
      ]) &&
      isRevision(value.roadmapRevision) &&
      isRevision(value.leaseRevision) &&
      isBoundedString(value.phaseId, MAX_ID_LENGTH) &&
      (value.lease === null ||
        (isPhaseLease(value.lease) && value.lease.phaseId === value.phaseId))
    );
  }
  if (
    status === "phase-lease-held" ||
    status === "phase-lease-lost" ||
    status === "lease-owner-unreachable"
  ) {
    return (
      isRecordWithExactKeys(value, [
        "status",
        "roadmapRevision",
        "leaseRevision",
        "currentLease",
      ]) &&
      isRevision(value.roadmapRevision) &&
      isRevision(value.leaseRevision) &&
      (value.currentLease === null || isPhaseLease(value.currentLease))
    );
  }
  if (status === "operation-conflict" || status === "stale-revision") {
    return (
      isRecordWithExactKeys(value, ["status", "roadmapRevision", "leaseRevision"]) &&
      isRevision(value.roadmapRevision) &&
      isRevision(value.leaseRevision)
    );
  }
  if (status === "project-mismatch") {
    return (
      isRecordWithExactKeys(value, ["status", "roadmapRevision", "currentProjectKey"]) &&
      isRevision(value.roadmapRevision) &&
      isBoundedString(value.currentProjectKey, MAX_PROJECT_KEY_LENGTH)
    );
  }
  if (
    status === "phase-not-found" ||
    status === "phase-archived" ||
    status === "phase-terminal" ||
    status === "plan-mismatch" ||
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

function isPhaseLeaseHolder(value: unknown): value is PhaseLeaseHolderV1 {
  return (
    isRecordWithExactKeys(value, LEASE_HOLDER_KEYS) &&
    isBoundedString(value.daemonInstanceId, MAX_ID_LENGTH) &&
    isBoundedString(value.sessionId, MAX_ID_LENGTH) &&
    (value.sessionPath === null || isBoundedString(value.sessionPath, MAX_PROJECT_KEY_LENGTH)) &&
    isPositiveSafeInteger(value.processId)
  );
}

function isNullableLeaseToken(value: unknown): value is PhaseLeaseTokenV1 | null {
  return (
    value === null ||
    (isRecordWithExactKeys(value, LEASE_TOKEN_KEYS) &&
      isBoundedString(value.leaseId, MAX_ID_LENGTH) &&
      isPositiveSafeInteger(value.fence))
  );
}

function isNullableSessionLink(value: unknown): value is NotesSessionLink | null {
  return value === null || isNotesSessionLink(value);
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
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
