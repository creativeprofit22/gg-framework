import { NOTES_PHASE_STATUSES, validateNotesDocumentV3 } from "./project-notes.js";
import type { NotesPhaseStatus, ProjectNotesSnapshot } from "./project-notes.js";

/**
 * Native user action only: "done" marks a phase Done by hand; any other status
 * reopens a phase the user previously marked Done. Generic saves cannot do either.
 */
export interface UserPhaseStatusOverrideRequest {
  version: 1;
  phaseId: string;
  status: NotesPhaseStatus;
  /** Null applies the change against the latest revision; phase preconditions still hold. */
  expectedRevision: number | null;
  timestamp: string;
}

export type UserPhaseStatusOverrideRefusal =
  "active-execution" | "protected-advancement" | "terminal-status" | "not-manually-done";

export type UserPhaseStatusOverrideOutcome =
  | {
      status: "committed";
      phaseId: string;
      resultingStatus: NotesPhaseStatus;
      snapshot: ProjectNotesSnapshot;
    }
  | { status: "stale-revision"; snapshot: ProjectNotesSnapshot }
  | { status: "refused"; reason: UserPhaseStatusOverrideRefusal; message: string }
  | { status: "phase-not-found" }
  | { status: "phase-archived" }
  | { status: "missing" }
  | { status: "corrupt" }
  | { status: "unavailable"; message: string };

const REFUSAL_REASONS: readonly UserPhaseStatusOverrideRefusal[] = [
  "active-execution",
  "protected-advancement",
  "terminal-status",
  "not-manually-done",
];

function keys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function revision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function message(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024;
}

function phaseStatus(value: unknown): value is NotesPhaseStatus {
  return NOTES_PHASE_STATUSES.includes(value as NotesPhaseStatus);
}

function snapshot(value: unknown): value is ProjectNotesSnapshot {
  return (
    keys(value, ["projectKey", "revision", "document"]) &&
    typeof value.projectKey === "string" &&
    value.projectKey.length > 0 &&
    value.projectKey.length <= 4096 &&
    revision(value.revision) &&
    validateNotesDocumentV3(value.document).ok
  );
}

export function isUserPhaseStatusOverrideRequest(
  value: unknown,
): value is UserPhaseStatusOverrideRequest {
  return (
    keys(value, ["version", "phaseId", "status", "expectedRevision", "timestamp"]) &&
    value.version === 1 &&
    typeof value.phaseId === "string" &&
    value.phaseId.trim().length > 0 &&
    value.phaseId.length <= 256 &&
    phaseStatus(value.status) &&
    (value.expectedRevision === null || revision(value.expectedRevision)) &&
    typeof value.timestamp === "string" &&
    value.timestamp.length <= 64 &&
    Number.isFinite(Date.parse(value.timestamp))
  );
}

export function isUserPhaseStatusOverrideOutcome(
  value: unknown,
): value is UserPhaseStatusOverrideOutcome {
  if (keys(value, ["status"])) {
    return (
      value.status === "phase-not-found" ||
      value.status === "phase-archived" ||
      value.status === "missing" ||
      value.status === "corrupt"
    );
  }
  if (keys(value, ["status", "message"])) {
    return value.status === "unavailable" && message(value.message);
  }
  if (keys(value, ["status", "reason", "message"])) {
    return (
      value.status === "refused" &&
      REFUSAL_REASONS.includes(value.reason as UserPhaseStatusOverrideRefusal) &&
      message(value.message)
    );
  }
  if (keys(value, ["status", "snapshot"])) {
    return value.status === "stale-revision" && snapshot(value.snapshot);
  }
  return (
    keys(value, ["status", "phaseId", "resultingStatus", "snapshot"]) &&
    value.status === "committed" &&
    typeof value.phaseId === "string" &&
    value.phaseId.length > 0 &&
    phaseStatus(value.resultingStatus) &&
    snapshot(value.snapshot)
  );
}
