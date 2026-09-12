import { isPhaseLease, type PhaseLeaseV1 } from "./phase-binding-protocol.js";
import { isNotesSessionLink } from "./project-notes.js";

export const PHASE_START_STATUSES = ["accepted", "already-bound", "failed"] as const;

export type PhaseStartStatus = (typeof PHASE_START_STATUSES)[number];

/**
 * Closed wire-protocol set. Adding a code requires a coordinated producer/client
 * update; older clients intentionally reject unknown codes instead of guessing.
 */
export const PHASE_START_FAILURE_CODES = [
  "invalid-phase-id",
  "coding-mode-required",
  "session-busy",
  "session-mutation-in-progress",
  "reconciliation-in-progress",
  "phase-not-found",
  "phase-archived",
  "phase-inactive",
  "advancement-confirmation-required",
  "phase-lease-held",
  "phase-lease-lost",
  "lease-owner-unreachable",
  "plan-not-approved",
  "plan-snapshot-missing",
  "plan-reconciliation-required",
  "repository-unverifiable",
  "notes-missing",
  "notes-corrupt",
  "launch-failed",
] as const;

export type PhaseStartFailureCode = (typeof PHASE_START_FAILURE_CODES)[number];

export interface PhaseStartSession {
  sessionId: string;
  sessionPath: string | null;
}

export type PhaseStartReconciliationOutcome =
  | "ready"
  | "needs-plan"
  | "needs-reconciliation"
  | "completion-pending"
  | "completed";

export type PhaseStartResult =
  | {
      status: "accepted";
      operationId: string;
      session: PhaseStartSession;
      packageTokenCount: number;
      lease?: PhaseLeaseV1;
      reconciliation?: PhaseStartReconciliationOutcome;
    }
  | {
      status: "already-bound";
      operationId: string;
      session: PhaseStartSession;
      packageTokenCount: 0;
      lease?: PhaseLeaseV1;
      reconciliation?: PhaseStartReconciliationOutcome;
    }
  | {
      status: "failed";
      code: PhaseStartFailureCode;
      operationId: string | null;
      message: string;
    };

export type LegacyPhaseStartFailureCode = Exclude<
  PhaseStartFailureCode,
  | "advancement-confirmation-required"
  | "phase-lease-held"
  | "phase-lease-lost"
  | "lease-owner-unreachable"
  | "plan-not-approved"
  | "plan-snapshot-missing"
  | "plan-reconciliation-required"
  | "repository-unverifiable"
>;

export type LegacyPhaseStartResult =
  | Exclude<PhaseStartResult, { status: "failed" }>
  | {
      status: "failed";
      code: LegacyPhaseStartFailureCode;
      operationId: string | null;
      message: string;
    };

/** Downgrades the v2-only advancement gate for clients using the original closed code set. */
export function toLegacyPhaseStartResult(result: PhaseStartResult): LegacyPhaseStartResult {
  if (result.status !== "failed" || LEGACY_PHASE_START_FAILURE_CODE_SET.has(result.code)) {
    if (result.status === "accepted" || result.status === "already-bound") {
      const { lease: _lease, reconciliation: _reconciliation, ...legacy } = result;
      return legacy;
    }
    return result as LegacyPhaseStartResult;
  }
  return {
    ...result,
    code: result.code === "advancement-confirmation-required" ? "phase-inactive" : "launch-failed",
  };
}

const PHASE_START_FAILURE_CODE_SET: ReadonlySet<string> = new Set(PHASE_START_FAILURE_CODES);
const V2_PHASE_START_FAILURE_CODE_SET: ReadonlySet<string> = new Set([
  "advancement-confirmation-required",
  "phase-lease-held",
  "phase-lease-lost",
  "lease-owner-unreachable",
  "plan-not-approved",
  "plan-snapshot-missing",
  "plan-reconciliation-required",
  "repository-unverifiable",
]);
const LEGACY_PHASE_START_FAILURE_CODE_SET: ReadonlySet<string> = new Set(
  PHASE_START_FAILURE_CODES.filter((code) => !V2_PHASE_START_FAILURE_CODE_SET.has(code)),
);

export function isPhaseStartFailureCode(value: unknown): value is PhaseStartFailureCode {
  return typeof value === "string" && PHASE_START_FAILURE_CODE_SET.has(value);
}

export function isPhaseStartSession(value: unknown): value is PhaseStartSession {
  return isNotesSessionLink(value);
}

export function isPhaseStartResult(value: unknown): value is PhaseStartResult {
  if (!isRecord(value)) return false;
  if (value.status === "accepted" || value.status === "already-bound") {
    const legacy = hasExactKeys(value, ["status", "operationId", "session", "packageTokenCount"]);
    const durable = hasExactKeys(value, [
      "status",
      "operationId",
      "session",
      "packageTokenCount",
      "lease",
      "reconciliation",
    ]);
    return (
      (legacy || durable) &&
      isNonEmptyString(value.operationId) &&
      isPhaseStartSession(value.session) &&
      Number.isInteger(value.packageTokenCount) &&
      (value.status === "accepted"
        ? (value.packageTokenCount as number) >= 0
        : value.packageTokenCount === 0) &&
      (!durable ||
        (isPhaseLease(value.lease) && isPhaseStartReconciliationOutcome(value.reconciliation)))
    );
  }
  return (
    value.status === "failed" &&
    hasExactKeys(value, ["status", "code", "operationId", "message"]) &&
    isPhaseStartFailureCode(value.code) &&
    (value.operationId === null || isNonEmptyString(value.operationId)) &&
    isNonEmptyString(value.message)
  );
}

function isPhaseStartReconciliationOutcome(
  value: unknown,
): value is PhaseStartReconciliationOutcome {
  return (
    value === "ready" ||
    value === "needs-plan" ||
    value === "needs-reconciliation" ||
    value === "completion-pending" ||
    value === "completed"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => actual.includes(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
