import { isNotesSessionLink, type NotesSessionLink, type ProjectNotesCorruptReason } from "./project-notes.js";

export const MANUAL_COMPLETION_APPROVAL_GATE_CODES = [
  "phase-not-found",
  "already-done",
  "inactive-phase",
  "archived-phase",
  "missing-implementation",
  "run-not-successful",
  "incomplete-plan",
  "missing-verification",
  "stale-verification",
  "failed-verification",
  "verification-exception",
  "stale-session",
  "unresolved-approval",
  "unresolved-attention",
  "status-override",
  "evidence-mismatch",
] as const;
export type ManualCompletionApprovalGateCode =
  (typeof MANUAL_COMPLETION_APPROVAL_GATE_CODES)[number];

export interface ManualCompletionApprovalPreviewRequest {
  version: 1;
  phaseId: string;
  expectedRevision: number;
}

export interface ManualCompletionApprovalCheckpoint {
  nonce: string;
  projectKey: string;
  phaseId: string;
  revision: number;
  session: NotesSessionLink;
  implementationCheckpointId: string;
  verificationStatusUpdateId: string;
  expiresAt: string;
}

export type ManualCompletionApprovalPreviewOutcome =
  | { status: "ready"; checkpoint: ManualCompletionApprovalCheckpoint }
  | { status: "stale-revision"; revision: number }
  | { status: "unmet-gate"; revision: number; code: ManualCompletionApprovalGateCode }
  | { status: "missing" }
  | {
      status: "corrupt";
      primary: ProjectNotesCorruptReason | null;
      backup: ProjectNotesCorruptReason | null;
    };

export interface ManualCompletionApprovalCommitRequest {
  version: 1;
  nonce: string;
  confirmed: true;
}

export type ManualCompletionApprovalCommitOutcome =
  | { status: "committed" | "duplicate"; revision: number; phaseId: string; approvalId: string }
  | { status: "nonce-not-found" | "nonce-expired" }
  | { status: "stale-revision"; revision: number }
  | { status: "unmet-gate"; revision: number; code: ManualCompletionApprovalGateCode }
  | { status: "missing" }
  | {
      status: "corrupt";
      primary: ProjectNotesCorruptReason | null;
      backup: ProjectNotesCorruptReason | null;
    };

const PREVIEW_REQUEST_KEYS = ["version", "phaseId", "expectedRevision"] as const;
const COMMIT_REQUEST_KEYS = ["version", "nonce", "confirmed"] as const;
const CHECKPOINT_KEYS = [
  "nonce",
  "projectKey",
  "phaseId",
  "revision",
  "session",
  "implementationCheckpointId",
  "verificationStatusUpdateId",
  "expiresAt",
] as const;
const GATE_CODES: ReadonlySet<string> = new Set(MANUAL_COMPLETION_APPROVAL_GATE_CODES);
const CORRUPT_REASONS: ReadonlySet<string> = new Set([
  "malformed-json",
  "invalid-envelope",
  "project-key-mismatch",
]);

export function isManualCompletionApprovalPreviewRequest(
  value: unknown,
): value is ManualCompletionApprovalPreviewRequest {
  return (
    isExactRecord(value, PREVIEW_REQUEST_KEYS) &&
    value.version === 1 &&
    isBoundedString(value.phaseId, 256) &&
    isRevision(value.expectedRevision)
  );
}

export function isManualCompletionApprovalCommitRequest(
  value: unknown,
): value is ManualCompletionApprovalCommitRequest {
  return (
    isExactRecord(value, COMMIT_REQUEST_KEYS) &&
    value.version === 1 &&
    isBoundedString(value.nonce, 256) &&
    value.confirmed === true
  );
}

export function isManualCompletionApprovalPreviewOutcome(
  value: unknown,
): value is ManualCompletionApprovalPreviewOutcome {
  if (!isRecord(value)) return false;
  if (value.status === "ready") {
    return (
      isExactRecord(value, ["status", "checkpoint"] as const) &&
      isCheckpoint(value.checkpoint)
    );
  }
  return isSharedOutcome(value);
}

export function isManualCompletionApprovalCommitOutcome(
  value: unknown,
): value is ManualCompletionApprovalCommitOutcome {
  if (!isRecord(value)) return false;
  if (value.status === "committed" || value.status === "duplicate") {
    return (
      isExactRecord(value, ["status", "revision", "phaseId", "approvalId"] as const) &&
      isRevision(value.revision) &&
      isBoundedString(value.phaseId, 256) &&
      isBoundedString(value.approvalId, 256)
    );
  }
  if (value.status === "nonce-not-found" || value.status === "nonce-expired") {
    return isExactRecord(value, ["status"] as const);
  }
  return isSharedOutcome(value);
}

function isCheckpoint(value: unknown): value is ManualCompletionApprovalCheckpoint {
  return (
    isExactRecord(value, CHECKPOINT_KEYS) &&
    isBoundedString(value.nonce, 256) &&
    isBoundedString(value.projectKey, 4_096) &&
    isBoundedString(value.phaseId, 256) &&
    isRevision(value.revision) &&
    isNotesSessionLink(value.session) &&
    value.session.sessionPath !== null &&
    isBoundedString(value.implementationCheckpointId, 256) &&
    isBoundedString(value.verificationStatusUpdateId, 256) &&
    typeof value.expiresAt === "string" &&
    Number.isFinite(Date.parse(value.expiresAt))
  );
}

function isSharedOutcome(value: Record<string, unknown>): boolean {
  if (value.status === "stale-revision") {
    return isExactRecord(value, ["status", "revision"] as const) && isRevision(value.revision);
  }
  if (value.status === "unmet-gate") {
    return (
      isExactRecord(value, ["status", "revision", "code"] as const) &&
      isRevision(value.revision) &&
      typeof value.code === "string" &&
      GATE_CODES.has(value.code)
    );
  }
  if (value.status === "missing") return isExactRecord(value, ["status"] as const);
  if (value.status === "corrupt") {
    return (
      isExactRecord(value, ["status", "primary", "backup"] as const) &&
      (value.primary === null ||
        (typeof value.primary === "string" && CORRUPT_REASONS.has(value.primary))) &&
      (value.backup === null ||
        (typeof value.backup === "string" && CORRUPT_REASONS.has(value.backup)))
    );
  }
  return false;
}

function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExactRecord<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
): value is Record<Keys[number], unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}
