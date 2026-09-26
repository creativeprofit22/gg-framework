import { validateNotesDocumentV3 } from "./project-notes.js";
import type {
  NotesPhase,
  NotesPhaseStatus,
  NotesValidationError,
  ProjectNotesSnapshot,
} from "./project-notes.js";

/** Native user action only. Neither paths nor claimed actors confer authority. */
export interface PhaseDeletionRequest {
  version: 1;
  action: "delete" | "recover";
  operationId: string;
  phaseId: string;
  expectedProjectKey: string;
  expectedRevision: number;
  expectedGeneration: number;
}

export type NotesPhaseRetiredRuntime = Pick<NotesPhase,
  "session" | "reminder" | "attentionReason" | "overrides" |
  "pendingAutomaticLifecycleTransition" | "status" | "completedAt" | "archivedAt"
> & {
  execution: NonNullable<NotesPhase["execution"]> | null;
  /** Historical validation boundary, never an execution capability. */
  roadmapEventCount: number;
};

export type NotesPhaseDeletionEvent = {
  request: PhaseDeletionRequest;
  fingerprint: string;
  timestamp: string;
} & (
  | { action: "delete"; retired: NotesPhaseRetiredRuntime }
  | { action: "recover"; deletionId: string; fromStatus: NotesPhaseStatus;
      toStatus: "not-started" | "done"; resetsRuntimeAuthority: true }
);

/** Retained indefinitely in place. No expiry or permanent purge is supported. */
export interface NotesPhaseDeletion {
  version: 1;
  currentDeletionId: string | null;
  events: NotesPhaseDeletionEvent[];
}

export type PhaseDeletionRefusal =
  | "active-execution" | "conflicting-lease" | "ambiguous-lease"
  | "recovery-required" | "protected-advancement" | "stale-generation"
  | "already-deleted" | "not-deleted" | "operation-id-reused";

export type PhaseDeletionOutcome =
  | { status: "committed"; action: "delete" | "recover"; operationId: string;
      replayed: boolean; snapshot: ProjectNotesSnapshot }
  | { status: "conflict"; snapshot: ProjectNotesSnapshot }
  | { status: "refused"; reason: PhaseDeletionRefusal; message: string }
  | { status: "missing" }
  | { status: "unavailable"; message: string }
  | { status: "uncertain"; operationId: string; message: string };

function keys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
const hasControlCharacters = (value: string): boolean =>
  Array.from(value).some(character => character.charCodeAt(0) <= 0x1f);
const id = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !hasControlCharacters(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const timestamp = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export function isPhaseDeletionRequest(value: unknown): value is PhaseDeletionRequest {
  return keys(value, ["version", "action", "operationId", "phaseId", "expectedProjectKey",
    "expectedRevision", "expectedGeneration"]) && value.version === 1 &&
    (value.action === "delete" || value.action === "recover") && id(value.operationId) &&
    id(value.phaseId) && typeof value.expectedProjectKey === "string" &&
    value.expectedProjectKey.trim().length > 0 && value.expectedProjectKey.length <= 4096 &&
    !hasControlCharacters(value.expectedProjectKey) && integer(value.expectedRevision) &&
    integer(value.expectedGeneration);
}

const refusalReasons: readonly PhaseDeletionRefusal[] = ["active-execution", "conflicting-lease",
  "ambiguous-lease", "recovery-required", "protected-advancement", "stale-generation",
  "already-deleted", "not-deleted", "operation-id-reused"];

export function isPhaseDeletionOutcome(value: unknown): value is PhaseDeletionOutcome {
  if (keys(value, ["status"]) && value.status === "missing") return true;
  if (keys(value, ["status", "message"]) && value.status === "unavailable") {
    return typeof value.message === "string" && value.message.length > 0 && value.message.length <= 1024;
  }
  if (keys(value, ["status", "reason", "message"]) && value.status === "refused") {
    return refusalReasons.includes(value.reason as PhaseDeletionRefusal) &&
      typeof value.message === "string" && value.message.length > 0 && value.message.length <= 1024;
  }
  if (keys(value, ["status", "operationId", "message"]) && value.status === "uncertain") {
    return id(value.operationId) && typeof value.message === "string" &&
      value.message.length > 0 && value.message.length <= 1024;
  }
  if ((!keys(value, ["status", "snapshot"]) || value.status !== "conflict") &&
      (!keys(value, ["status", "action", "operationId", "replayed", "snapshot"]) ||
        value.status !== "committed" || (value.action !== "delete" && value.action !== "recover") ||
        !id(value.operationId) || typeof value.replayed !== "boolean")) return false;
  return keys(value.snapshot, ["projectKey", "revision", "document"]) &&
    typeof value.snapshot.projectKey === "string" && value.snapshot.projectKey.length > 0 &&
    value.snapshot.projectKey.length <= 4096 && integer(value.snapshot.revision) &&
    validateNotesDocumentV3(value.snapshot.document).ok;
}

/** Bounded canonical payload, not a security hash. Key ordering cannot alter replay identity. */
export function phaseDeletionFingerprint(request: PhaseDeletionRequest): string {
  return JSON.stringify([request.version, request.action, request.operationId, request.phaseId,
    request.expectedProjectKey, request.expectedRevision, request.expectedGeneration]);
}

export function isNotesPhaseDeleted(phase: Pick<NotesPhase, "deletion">): boolean {
  return phase.deletion !== undefined && phase.deletion.currentDeletionId !== null;
}

export function isNotesPhasePresent(phase: Pick<NotesPhase, "deletion">): boolean {
  return !isNotesPhaseDeleted(phase);
}

export function notesPhaseDeletionGeneration(phase: Pick<NotesPhase, "deletion">): number {
  return phase.deletion?.events.length ?? 0;
}

/** Nested runtime fields are checked by the existing Notes validators, not a second schema. */
export function validateNotesPhaseDeletion(
  value: unknown,
  phaseId: string,
  roadmapEventCount: number,
  validateRetired: (value: NotesPhaseRetiredRuntime, path: string) => NotesValidationError | null,
  path = "deletion",
): NotesValidationError | null {
  const fail = (message: string): NotesValidationError => ({ path, message });
  if (!keys(value, ["version", "currentDeletionId", "events"]) || value.version !== 1 ||
      (value.currentDeletionId !== null && !id(value.currentDeletionId)) ||
      !Array.isArray(value.events) || value.events.length === 0) return fail("invalid deletion metadata");
  const operationIds = new Set<string>();
  let current: string | null = null;
  let previousTime = -Infinity;
  let previousRevision = -1;
  let previousCount = 0;
  let deletedStatus: NotesPhaseStatus | undefined;
  let projectKey: string | undefined;
  for (const [index, event] of value.events.entries()) {
    const common = ["request", "fingerprint", "timestamp", "action"];
    if (!keys(event, [...common, "retired"]) &&
        !keys(event, [...common, "deletionId", "fromStatus", "toStatus", "resetsRuntimeAuthority"])) {
      return fail("invalid deletion event");
    }
    if (!isPhaseDeletionRequest(event.request) || event.request.action !== event.action ||
        event.request.phaseId !== phaseId || event.request.expectedGeneration !== index ||
        event.fingerprint !== phaseDeletionFingerprint(event.request) ||
        operationIds.has(event.request.operationId) || !timestamp(event.timestamp) ||
        Date.parse(event.timestamp) < previousTime || event.request.expectedRevision <= previousRevision ||
        (projectKey !== undefined && event.request.expectedProjectKey !== projectKey)) {
      return fail("incoherent deletion request or event sequence");
    }
    operationIds.add(event.request.operationId);
    previousTime = Date.parse(event.timestamp);
    previousRevision = event.request.expectedRevision;
    projectKey = event.request.expectedProjectKey;
    if (event.action === "delete") {
      if (current !== null || !keys(event.retired, ["session", "execution", "reminder",
        "attentionReason", "overrides", "pendingAutomaticLifecycleTransition", "status",
        "completedAt", "archivedAt", "roadmapEventCount"]) ||
        !integer(event.retired.roadmapEventCount) || event.retired.roadmapEventCount < previousCount ||
        event.retired.roadmapEventCount > roadmapEventCount) return fail("invalid retired runtime boundary");
      const retired = event.retired as unknown as NotesPhaseRetiredRuntime;
      const error = validateRetired(retired, `${path}.events[${index}].retired`);
      if (error) return error;
      previousCount = retired.roadmapEventCount;
      deletedStatus = retired.status;
      current = event.request.operationId;
    } else {
      if (current === null || event.deletionId !== current || event.fromStatus !== deletedStatus ||
          event.toStatus !== (deletedStatus === "done" ? "done" : "not-started") ||
          event.resetsRuntimeAuthority !== true) return fail("invalid recovery transition");
      current = null;
    }
  }
  return value.currentDeletionId === current ? null : fail("current deletion does not match history");
}

/** Pure transition only. The repository must authorize and validate the whole document under lock. */
export function applyNotesPhaseDeletion(
  phase: NotesPhase,
  request: PhaseDeletionRequest,
  now: string,
): NotesPhase {
  if (!isPhaseDeletionRequest(request) || request.phaseId !== phase.id || !timestamp(now) ||
      request.expectedGeneration !== notesPhaseDeletionGeneration(phase)) {
    throw new Error("Invalid or stale phase deletion transition");
  }
  const events = phase.deletion?.events ?? [];
  if (events.some(event => event.request.operationId === request.operationId) ||
      (events.length > 0 && (Date.parse(now) < Date.parse(events.at(-1)!.timestamp) ||
        request.expectedRevision <= events.at(-1)!.request.expectedRevision))) {
    throw new Error("Deletion replay must be resolved before applying a transition");
  }
  if ((request.action === "delete") === isNotesPhaseDeleted(phase)) {
    throw new Error("Phase deletion state does not permit this transition");
  }
  const common = { request: structuredClone(request), fingerprint: phaseDeletionFingerprint(request), timestamp: now };
  const next = structuredClone(phase);
  delete next.execution;
  next.session = null;
  next.reminder = null;
  next.attentionReason = null;
  next.overrides = { status: null, referenceIds: null };
  next.pendingAutomaticLifecycleTransition = null;
  next.updatedAt = now;
  let event: NotesPhaseDeletionEvent;
  if (request.action === "delete") {
    event = { ...common, action: "delete", retired: structuredClone({
      session: phase.session, execution: phase.execution ?? null, reminder: phase.reminder,
      attentionReason: phase.attentionReason, overrides: phase.overrides,
      pendingAutomaticLifecycleTransition: phase.pendingAutomaticLifecycleTransition,
      status: phase.status, completedAt: phase.completedAt, archivedAt: phase.archivedAt,
      roadmapEventCount: phase.roadmapEvents.length,
    }) };
  } else {
    const toStatus = phase.status === "done" ? "done" : "not-started";
    event = { ...common, action: "recover", deletionId: phase.deletion!.currentDeletionId!,
      fromStatus: phase.status, toStatus, resetsRuntimeAuthority: true };
    next.status = toStatus;
    if (toStatus !== "done") next.completedAt = null;
    if (toStatus !== phase.status) next.lifecycleEvents.push({
      id: `recovery:${request.operationId}`, fromStatus: phase.status, toStatus,
      source: "system", kind: "other", timestamp: now,
      reason: "Recovered phase; fresh execution and plan approval required.",
    });
  }
  next.deletion = { version: 1, currentDeletionId: request.action === "delete" ? request.operationId : null,
    events: [...structuredClone(events), event] };
  return next;
}
