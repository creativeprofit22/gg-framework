import {
  isNotesPhasePresent,
  isNotesPhaseStatus,
  isNotesReviewDecision,
  isNotesRoadmapReviewer,
  isNotesVerificationStatus,
  isValidNotesRoadmapEvidence,
  NOTES_ROADMAP_REASON_MAX_LENGTH,
  canonicalReferenceIdentity,
  normalizeCanonicalUrl,
  validateNotesReferenceProjection,
  type NotesDocumentV3,
  type NotesPhase,
  type NotesPhaseStatus,
  type NotesReferenceProjection,
  type NotesReviewDecision,
  type NotesRoadmapReviewer,
  type NotesVerificationStatus,
  type ProjectNotesCorruption,
  type ProjectNotesUnsupportedFormat,
  isProjectNotesUnsupportedFormat,
} from "./project-notes.js";

export const ROADMAP_PHASE_DRAFT_SUMMARY_MAX_LENGTH = 4_096;
export const ROADMAP_PROPOSED_PHASES_MAX_ITEMS = 20;
export const ROADMAP_PHASE_TITLE_MAX_LENGTH = 200;
export const ROADMAP_PHASE_GOAL_MAX_LENGTH = 4_096;
export const ROADMAP_PHASE_DONE_WHEN_MAX_ITEMS = 20;
export const ROADMAP_PHASE_DONE_WHEN_ITEM_MAX_LENGTH = 1_024;
export const ROADMAP_PHASE_SOURCE_PROMPT_MAX_LENGTH = 16_384;
export const ROADMAP_DRAFT_REFERENCE_KEY_MAX_LENGTH = 128;
export const ROADMAP_DRAFT_REFERENCES_MAX_ITEMS = 50;
// One phase may cite every reference in its draft.
export const ROADMAP_DRAFT_REFERENCE_KEYS_MAX_ITEMS = ROADMAP_DRAFT_REFERENCES_MAX_ITEMS;
export const ROADMAP_DRAFT_FEEDBACK_MAX_LENGTH = 4_096;

export interface RoadmapWorkflowValidationError {
  path: string;
  message: string;
}

export type RoadmapWorkflowValidationResult<T> =
  { ok: true; value: T } | { ok: false; error: RoadmapWorkflowValidationError };

export interface RoadmapInspectionVerificationSummary {
  status: NotesVerificationStatus;
  reason: string | null;
  /** Historical report fields: emitted together; absent only in legacy projections.
   * Neither a legacy label nor a historical report proves current completion criteria.
   */
  evidence?: string[];
  updateId?: string;
  timestamp?: string;
  progress?: string;
}

export interface RoadmapInspectionReviewSummary {
  reviewer: NotesRoadmapReviewer;
  decision: NotesReviewDecision;
  reason: string | null;
}

export interface RoadmapInspectionPhase {
  id: string;
  title: string;
  goal: string;
  doneWhen: string[];
  order: number;
  status: NotesPhaseStatus;
  archivedAt: string | null;
  hasBoundSession: boolean;
  latestProgress: string | null;
  latestBlocker: string | null;
  latestVerification: RoadmapInspectionVerificationSummary | null;
  latestReview: RoadmapInspectionReviewSummary | null;
  hasUserStatusOverride: boolean;
  /** Full saved prompt; present only in a single-phase (`phase_id`) inspection. */
  sourcePrompt?: string;
}

export interface RoadmapInspection {
  projectKey: string;
  revision: number;
  phases: RoadmapInspectionPhase[];
}

export type RoadmapInspectionOutcome =
  | ProjectNotesUnsupportedFormat
  | { status: "ok"; inspection: RoadmapInspection }
  | { status: "missing"; projectKey: string }
  | ({ status: "corrupt"; projectKey: string } & ProjectNotesCorruption);

export interface RoadmapDraftReferenceProposal extends Omit<NotesReferenceProjection, "id"> {
  referenceKey: string;
}

export interface RoadmapProposedPhase {
  title: string;
  goal: string;
  doneWhen: string[];
  sourcePrompt: string;
  referenceKeys?: string[];
  /** Existing Roadmap phase this new phase goes directly before; absent appends. */
  insertBeforePhaseId?: string;
}

/** Bounds an approval card's order lists; Notes itself has no phase cap. */
export const ROADMAP_PHASE_ORDER_PREVIEW_MAX_ITEMS = 1_000;

/** One phase as shown in an approval card's order list. */
export interface RoadmapPhaseOrderEntry {
  phaseId: string;
  /** Copied from Notes for display only. */
  title: string;
}

/** Roadmap order (present, unarchived phases) before and after a proposal is applied. */
export interface RoadmapPhaseOrderPreview {
  before: RoadmapPhaseOrderEntry[];
  after: RoadmapPhaseOrderEntry[];
}

export type RoadmapPhaseMovePosition = "before" | "after";

export interface RoadmapPhasePlacement {
  position: RoadmapPhaseMovePosition;
  targetPhaseId: string;
}

/** Why a phase cannot be placed where requested. */
export type RoadmapPhaseOrderRefusal =
  | { reason: "phase-not-movable"; phaseId: string; notMovable: RoadmapPhaseNotEditableReason }
  | { reason: "target-unavailable"; phaseId: string }
  | { reason: "same-phase"; phaseId: string }
  | { reason: "ahead-of-done"; phaseId: string; donePhaseId: string }
  | { reason: "no-change"; phaseId: string };

export interface RoadmapPhaseDraftRequest {
  expectedRevision: number;
  summary: string;
  phases: RoadmapProposedPhase[];
  proposedReferences?: RoadmapDraftReferenceProposal[];
  /** Why external code researched for this draft is deliberately not cited. */
  sourcesNotCited?: string;
}

export interface RoadmapDraftPhase extends Omit<RoadmapProposedPhase, "referenceKeys"> {
  phaseId: string;
  referenceIds: string[];
}

/** A pending proposal to add new phases. The wire shape has no `kind` key (legacy-compatible). */
export interface RoadmapPhaseCreateDraft {
  id: string;
  projectKey: string;
  basedOnRevision: number;
  createdAt: string;
  createdBySessionId: string;
  summary: string;
  references: NotesReferenceProjection[];
  phases: RoadmapDraftPhase[];
  /** The drafter's reason for citing none of the external code it researched. */
  sourcesNotCited: string | null;
  /** Present exactly when a phase sets `insertBeforePhaseId`; legacy drafts omit it. */
  orderPreview?: RoadmapPhaseOrderPreview;
  status: "pending" | "stale";
}

/** Phase fields an edit proposal may change, in canonical order. */
export const ROADMAP_PHASE_EDIT_FIELDS = ["title", "goal", "doneWhen", "sourcePrompt"] as const;
export type RoadmapPhaseEditField = (typeof ROADMAP_PHASE_EDIT_FIELDS)[number];
/** Loose bounds for `before` values copied from Notes, which the UI may save outside draft limits. */
export const ROADMAP_PHASE_EDIT_BEFORE_MAX_LENGTH = 65_536;
export const ROADMAP_PHASE_EDIT_BEFORE_DONE_WHEN_MAX_ITEMS = 200;

export type RoadmapPhaseFieldChange =
  | { field: "title" | "goal" | "sourcePrompt"; before: string; after: string }
  | { field: "doneWhen"; before: string[]; after: string[] };

/** A pending proposal to change fields of one existing phase. */
export interface RoadmapPhaseEditDraft {
  kind: "edit";
  id: string;
  projectKey: string;
  basedOnRevision: number;
  createdAt: string;
  createdBySessionId: string;
  summary: string;
  phaseId: string;
  /** The phase title when the edit was proposed, for display only. */
  phaseTitle: string;
  /** The target phase's `updatedAt` when proposed; any later phase change makes the edit stale. */
  basedOnUpdatedAt: string;
  /** 1..4 changes with unique fields in canonical order. */
  changes: RoadmapPhaseFieldChange[];
  status: "pending" | "stale";
}

/** A pending proposal to move one existing phase next to another. */
export interface RoadmapPhaseMoveDraft {
  kind: "move";
  id: string;
  projectKey: string;
  basedOnRevision: number;
  createdAt: string;
  createdBySessionId: string;
  summary: string;
  phaseId: string;
  /** The moved phase's title when proposed, for display only. */
  phaseTitle: string;
  position: RoadmapPhaseMovePosition;
  targetPhaseId: string;
  /** The target phase's title when proposed, for display only. */
  targetPhaseTitle: string;
  /** Any Roadmap order change since the proposal makes the move stale. */
  orderPreview: RoadmapPhaseOrderPreview;
  status: "pending" | "stale";
}

export type RoadmapPhaseDraft =
  RoadmapPhaseCreateDraft | RoadmapPhaseEditDraft | RoadmapPhaseMoveDraft;

export interface RoadmapPhaseMoveRequest {
  expectedRevision: number;
  summary: string;
  phaseId: string;
  /** Exactly one of `beforePhaseId` and `afterPhaseId`. */
  beforePhaseId?: string;
  afterPhaseId?: string;
}

export type RoadmapPhaseMoveApplication =
  | { status: "ok"; document: NotesDocumentV3 }
  | { status: "phase-changed"; phaseId: string }
  | { status: "phase-not-editable"; phaseId: string; reason: RoadmapPhaseNotEditableReason };

export interface RoadmapPhaseEditRequest {
  expectedRevision: number;
  summary: string;
  phaseId: string;
  title?: string;
  goal?: string;
  doneWhen?: string[];
  sourcePrompt?: string;
}

export type RoadmapPhaseNotEditableReason = "missing" | "deleted" | "done" | "archived";

export type RoadmapPhaseEditApplication =
  | { status: "ok"; document: NotesDocumentV3 }
  | { status: "phase-changed"; phaseId: string }
  | { status: "phase-not-editable"; phaseId: string; reason: RoadmapPhaseNotEditableReason };

export type RoadmapPhaseDraftApprovalResult =
  | { status: "created"; revision: number; phaseIds: string[] }
  | { status: "edited"; revision: number; phaseId: string }
  | { status: "moved"; revision: number; phaseId: string }
  | { status: "phase-changed"; phaseId: string }
  | { status: "phase-not-editable"; phaseId: string; reason: RoadmapPhaseNotEditableReason }
  | { status: "already-decided"; decision: "approved" | "rejected" }
  | { status: "stale-revision"; expectedRevision: number; currentRevision: number }
  | { status: "proposal-not-found" }
  | { status: "proposal-project-mismatch" }
  | { status: "reconciliation-in-progress" }
  | { status: "notes-missing" }
  | { status: "notes-corrupt" }
  | { status: "invalid-proposal"; message: string }
  | { status: "storage-failed"; message: string };

export type RoadmapPhaseDraftRejectionResult =
  | { status: "rejected" }
  | { status: "already-decided"; decision: "approved" | "rejected" }
  | { status: "proposal-not-found" }
  | { status: "proposal-project-mismatch" };

const PROPOSED_PHASE_BASE_KEYS = ["title", "goal", "doneWhen", "sourcePrompt"] as const;
const PROPOSED_PHASE_OPTIONAL_KEYS = ["referenceKeys", "insertBeforePhaseId"] as const;
const PROPOSED_PHASE_KEYS = [...PROPOSED_PHASE_BASE_KEYS, ...PROPOSED_PHASE_OPTIONAL_KEYS] as const;
const DRAFT_PHASE_BASE_KEYS = ["phaseId", ...PROPOSED_PHASE_BASE_KEYS] as const;
const DRAFT_PHASE_OPTIONAL_KEYS = ["referenceIds", "insertBeforePhaseId"] as const;
const DRAFT_PHASE_KEYS = [...DRAFT_PHASE_BASE_KEYS, ...DRAFT_PHASE_OPTIONAL_KEYS] as const;
const DRAFT_REQUEST_BASE_KEYS = ["expectedRevision", "summary", "phases"] as const;
const DRAFT_REQUEST_OPTIONAL_KEYS = ["proposedReferences", "sourcesNotCited"] as const;
const DRAFT_REQUEST_KEYS = [...DRAFT_REQUEST_BASE_KEYS, ...DRAFT_REQUEST_OPTIONAL_KEYS] as const;
export const ROADMAP_PHASE_DRAFT_SOURCES_NOT_CITED_MAX_LENGTH = 1_024;
const DRAFT_BASE_KEYS = [
  "id",
  "projectKey",
  "basedOnRevision",
  "createdAt",
  "createdBySessionId",
  "summary",
  "phases",
  "status",
] as const;
const DRAFT_OPTIONAL_KEYS = ["references", "sourcesNotCited", "orderPreview"] as const;
const DRAFT_KEYS = [
  ...DRAFT_BASE_KEYS.slice(0, 6),
  "references",
  "phases",
  "sourcesNotCited",
  "orderPreview",
  "status",
] as const;
const REFERENCE_PROJECTION_KEYS = [
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
] as const;
const DRAFT_REFERENCE_PROPOSAL_KEYS = [
  "referenceKey",
  ...REFERENCE_PROJECTION_KEYS.filter((key) => key !== "id"),
] as const;
const EDIT_REQUEST_BASE_KEYS = ["expectedRevision", "summary", "phaseId"] as const;
const EDIT_DRAFT_KEYS = [
  "kind",
  "id",
  "projectKey",
  "basedOnRevision",
  "createdAt",
  "createdBySessionId",
  "summary",
  "phaseId",
  "phaseTitle",
  "basedOnUpdatedAt",
  "changes",
  "status",
] as const;
const FIELD_CHANGE_KEYS = ["field", "before", "after"] as const;
const MOVE_REQUEST_BASE_KEYS = ["expectedRevision", "summary", "phaseId"] as const;
const MOVE_REQUEST_PLACEMENT_KEYS = ["beforePhaseId", "afterPhaseId"] as const;
const MOVE_DRAFT_KEYS = [
  "kind",
  "id",
  "projectKey",
  "basedOnRevision",
  "createdAt",
  "createdBySessionId",
  "summary",
  "phaseId",
  "phaseTitle",
  "position",
  "targetPhaseId",
  "targetPhaseTitle",
  "orderPreview",
  "status",
] as const;
const ORDER_PREVIEW_KEYS = ["before", "after"] as const;
const ORDER_ENTRY_KEYS = ["phaseId", "title"] as const;

/** Normalizes wire text before length checks and persistence. */
export function normalizeRoadmapWorkflowText(value: string): string {
  return value.normalize("NFC").replace(/\r\n?/g, "\n").trim();
}

export function validateRoadmapPhaseDraftRequest(
  value: unknown,
): RoadmapWorkflowValidationResult<RoadmapPhaseDraftRequest> {
  if (!isRecordWithKeys(value, DRAFT_REQUEST_BASE_KEYS, DRAFT_REQUEST_OPTIONAL_KEYS)) {
    return invalid("$", `expected exactly: ${DRAFT_REQUEST_KEYS.join(", ")}`);
  }
  if (!isNonNegativeInteger(value.expectedRevision)) {
    return invalid("expectedRevision", "expected a non-negative integer");
  }
  const summary = normalizedBoundedString(
    value.summary,
    ROADMAP_PHASE_DRAFT_SUMMARY_MAX_LENGTH,
    "summary",
  );
  if (!summary.ok) return summary;
  const sourcesNotCited =
    value.sourcesNotCited === undefined
      ? null
      : normalizedBoundedString(
          value.sourcesNotCited,
          ROADMAP_PHASE_DRAFT_SOURCES_NOT_CITED_MAX_LENGTH,
          "sourcesNotCited",
        );
  if (sourcesNotCited && !sourcesNotCited.ok) return sourcesNotCited;

  const references = validateDraftReferenceProposals(value.proposedReferences ?? []);
  if (!references.ok) return references;
  const referenceKeys = new Set(references.value.map((reference) => reference.referenceKey));

  if (
    !Array.isArray(value.phases) ||
    value.phases.length < 1 ||
    value.phases.length > ROADMAP_PROPOSED_PHASES_MAX_ITEMS
  ) {
    return invalid("phases", `expected 1..${ROADMAP_PROPOSED_PHASES_MAX_ITEMS} phases`);
  }

  const linkedReferenceKeys = new Set<string>();
  const phases: RoadmapProposedPhase[] = [];
  for (let index = 0; index < value.phases.length; index += 1) {
    const phase = validateProposedPhase(value.phases[index], `phases[${index}]`, referenceKeys);
    if (!phase.ok) return phase;
    for (const referenceKey of phase.value.referenceKeys ?? [])
      linkedReferenceKeys.add(referenceKey);
    phases.push(phase.value);
  }
  for (let index = 0; index < references.value.length; index += 1) {
    if (!linkedReferenceKeys.has(references.value[index]!.referenceKey)) {
      return invalid(
        `proposedReferences[${index}].referenceKey`,
        "reference must be linked to a phase",
      );
    }
  }
  return {
    ok: true,
    value: {
      expectedRevision: value.expectedRevision,
      summary: summary.value,
      phases,
      proposedReferences: references.value,
      ...(sourcesNotCited ? { sourcesNotCited: sourcesNotCited.value } : {}),
    },
  };
}

export function isRoadmapPhaseDraftRequest(value: unknown): value is RoadmapPhaseDraftRequest {
  return validateRoadmapPhaseDraftRequest(value).ok;
}

/** Validates either draft kind; drafts without `kind: "edit"` are create drafts. */
export function validateRoadmapPhaseDraft(
  value: unknown,
): RoadmapWorkflowValidationResult<RoadmapPhaseDraft> {
  if (isRecord(value) && value.kind === "edit") return validateRoadmapPhaseEditDraft(value);
  if (isRecord(value) && value.kind === "move") return validateRoadmapPhaseMoveDraft(value);
  return validateRoadmapPhaseCreateDraft(value);
}

export function isRoadmapPhaseMoveDraft(value: RoadmapPhaseDraft): value is RoadmapPhaseMoveDraft {
  return "kind" in value && value.kind === "move";
}

export function isRoadmapPhaseCreateDraft(
  value: RoadmapPhaseDraft,
): value is RoadmapPhaseCreateDraft {
  return !("kind" in value);
}

export function isRoadmapPhaseDraft(value: unknown): value is RoadmapPhaseDraft {
  return validateRoadmapPhaseDraft(value).ok;
}

export function isRoadmapPhaseEditDraft(value: RoadmapPhaseDraft): value is RoadmapPhaseEditDraft {
  return "kind" in value && value.kind === "edit";
}

export function validateRoadmapPhaseEditRequest(
  value: unknown,
): RoadmapWorkflowValidationResult<RoadmapPhaseEditRequest> {
  if (!isRecordWithKeys(value, EDIT_REQUEST_BASE_KEYS, ROADMAP_PHASE_EDIT_FIELDS)) {
    return invalid(
      "$",
      `expected ${EDIT_REQUEST_BASE_KEYS.join(", ")} and optionally ${ROADMAP_PHASE_EDIT_FIELDS.join(", ")}`,
    );
  }
  if (!isNonNegativeInteger(value.expectedRevision)) {
    return invalid("expectedRevision", "expected a non-negative integer");
  }
  const summary = normalizedBoundedString(
    value.summary,
    ROADMAP_PHASE_DRAFT_SUMMARY_MAX_LENGTH,
    "summary",
  );
  if (!summary.ok) return summary;
  const phaseId = boundedIdentifier(value.phaseId, "phaseId");
  if (!phaseId.ok) return phaseId;
  if (ROADMAP_PHASE_EDIT_FIELDS.every((field) => value[field] === undefined)) {
    return invalid("$", `expected at least one of: ${ROADMAP_PHASE_EDIT_FIELDS.join(", ")}`);
  }
  const request: RoadmapPhaseEditRequest = {
    expectedRevision: value.expectedRevision,
    summary: summary.value,
    phaseId: phaseId.value,
  };
  if (value.title !== undefined) {
    const title = validatePhaseTitle(value.title, "title");
    if (!title.ok) return title;
    request.title = title.value;
  }
  if (value.goal !== undefined) {
    const goal = validatePhaseGoal(value.goal, "goal");
    if (!goal.ok) return goal;
    request.goal = goal.value;
  }
  if (value.doneWhen !== undefined) {
    const doneWhen = validatePhaseDoneWhen(value.doneWhen, "doneWhen");
    if (!doneWhen.ok) return doneWhen;
    request.doneWhen = doneWhen.value;
  }
  if (value.sourcePrompt !== undefined) {
    const sourcePrompt = validatePhaseSourcePrompt(value.sourcePrompt, "sourcePrompt");
    if (!sourcePrompt.ok) return sourcePrompt;
    request.sourcePrompt = sourcePrompt.value;
  }
  return { ok: true, value: request };
}

export function validateRoadmapPhaseEditDraft(
  value: unknown,
): RoadmapWorkflowValidationResult<RoadmapPhaseEditDraft> {
  if (!isRecordWithExactKeys(value, EDIT_DRAFT_KEYS)) {
    return invalid("$", `expected exactly: ${EDIT_DRAFT_KEYS.join(", ")}`);
  }
  if (value.kind !== "edit") return invalid("kind", 'expected "edit"');
  const id = boundedIdentifier(value.id, "id");
  if (!id.ok) return id;
  const projectKey = normalizedBoundedString(value.projectKey, 4_096, "projectKey");
  if (!projectKey.ok) return projectKey;
  if (!isNonNegativeInteger(value.basedOnRevision)) {
    return invalid("basedOnRevision", "expected a non-negative integer");
  }
  if (!isIsoTimestamp(value.createdAt)) return invalid("createdAt", "expected an ISO timestamp");
  const sessionId = boundedIdentifier(value.createdBySessionId, "createdBySessionId");
  if (!sessionId.ok) return sessionId;
  const summary = normalizedBoundedString(
    value.summary,
    ROADMAP_PHASE_DRAFT_SUMMARY_MAX_LENGTH,
    "summary",
  );
  if (!summary.ok) return summary;
  const phaseId = boundedIdentifier(value.phaseId, "phaseId");
  if (!phaseId.ok) return phaseId;
  const phaseTitle = looseBeforeString(value.phaseTitle, "phaseTitle");
  if (!phaseTitle.ok) return phaseTitle;
  if (!isIsoTimestamp(value.basedOnUpdatedAt)) {
    return invalid("basedOnUpdatedAt", "expected an ISO timestamp");
  }
  if (value.status !== "pending" && value.status !== "stale") {
    return invalid("status", 'expected "pending" or "stale"');
  }
  if (
    !Array.isArray(value.changes) ||
    value.changes.length < 1 ||
    value.changes.length > ROADMAP_PHASE_EDIT_FIELDS.length
  ) {
    return invalid("changes", `expected 1..${ROADMAP_PHASE_EDIT_FIELDS.length} field changes`);
  }
  const changes: RoadmapPhaseFieldChange[] = [];
  let previousFieldIndex = -1;
  for (let index = 0; index < value.changes.length; index += 1) {
    const change = validateFieldChange(value.changes[index], `changes[${index}]`);
    if (!change.ok) return change;
    const fieldIndex = ROADMAP_PHASE_EDIT_FIELDS.indexOf(change.value.field);
    if (fieldIndex <= previousFieldIndex) {
      return invalid(`changes[${index}].field`, "expected unique fields in canonical order");
    }
    previousFieldIndex = fieldIndex;
    changes.push(change.value);
  }
  return {
    ok: true,
    value: {
      kind: "edit",
      id: id.value,
      projectKey: projectKey.value,
      basedOnRevision: value.basedOnRevision,
      createdAt: value.createdAt,
      createdBySessionId: sessionId.value,
      summary: summary.value,
      phaseId: phaseId.value,
      phaseTitle: phaseTitle.value,
      basedOnUpdatedAt: value.basedOnUpdatedAt,
      changes,
      status: value.status,
    },
  };
}

/** Returns why a phase cannot be edited, or null when it is editable. */
export function classifyRoadmapPhaseEditability(
  phase: Pick<NotesPhase, "deletion" | "status" | "archivedAt"> | undefined,
): RoadmapPhaseNotEditableReason | null {
  if (!phase) return "missing";
  if (!isNotesPhasePresent(phase)) return "deleted";
  if (phase.status === "done") return "done";
  if (phase.archivedAt !== null) return "archived";
  return null;
}

/** Lists only the requested fields whose (already validated) value differs from the phase. */
export function buildRoadmapPhaseEditChanges(
  phase: Pick<NotesPhase, RoadmapPhaseEditField>,
  request: RoadmapPhaseEditRequest,
): RoadmapPhaseFieldChange[] {
  const changes: RoadmapPhaseFieldChange[] = [];
  for (const field of ROADMAP_PHASE_EDIT_FIELDS) {
    if (field === "doneWhen") {
      const after = request.doneWhen;
      if (after !== undefined && !stringArraysEqual(phase.doneWhen, after)) {
        changes.push({ field, before: [...phase.doneWhen], after: [...after] });
      }
      continue;
    }
    const after = request[field];
    if (after !== undefined && after !== phase[field]) {
      changes.push({ field, before: phase[field], after });
    }
  }
  return changes;
}

/**
 * Applies an approved edit when the target phase is still editable and unchanged since the
 * proposal. The new `updatedAt` is forced strictly later than the phase's previous value.
 */
export function applyRoadmapPhaseEdit(
  document: NotesDocumentV3,
  draft: RoadmapPhaseEditDraft,
  timestamp: string,
): RoadmapPhaseEditApplication {
  const index = document.phases.findIndex((candidate) => candidate.id === draft.phaseId);
  const phase = document.phases[index];
  const reason = classifyRoadmapPhaseEditability(phase);
  if (reason !== null || !phase) {
    return { status: "phase-not-editable", phaseId: draft.phaseId, reason: reason ?? "missing" };
  }
  const unchanged =
    phase.updatedAt === draft.basedOnUpdatedAt &&
    draft.changes.every((change) =>
      change.field === "doneWhen"
        ? stringArraysEqual(phase.doneWhen, change.before)
        : phase[change.field] === change.before,
    );
  if (!unchanged) return { status: "phase-changed", phaseId: draft.phaseId };

  const updatedAt = strictlyLaterTimestamp(timestamp, phase.updatedAt);
  const nextPhase: NotesPhase = { ...phase, updatedAt };
  for (const change of draft.changes) {
    if (change.field === "doneWhen") nextPhase.doneWhen = [...change.after];
    else nextPhase[change.field] = change.after;
  }
  const phases = [...document.phases];
  phases[index] = nextPhase;
  return { status: "ok", document: { ...document, phases, updatedAt } };
}

/** On the Roadmap: present (not deleted) and not archived. */
export function isRoadmapPhaseOnRoadmap(
  phase: Pick<NotesPhase, "deletion" | "archivedAt">,
): boolean {
  return isNotesPhasePresent(phase) && phase.archivedAt === null;
}

/** Roadmap phases in stored order (Notes keeps `order` equal to the array index). */
export function roadmapPhaseOrderEntries(
  phases: readonly Pick<NotesPhase, "id" | "title" | "deletion" | "archivedAt">[],
): RoadmapPhaseOrderEntry[] {
  return phases
    .filter(isRoadmapPhaseOnRoadmap)
    .map((phase) => ({ phaseId: phase.id, title: phase.title }));
}

/** Returns the first Roadmap Done phase at or after `index`, if any. */
function doneRoadmapPhaseFrom(
  phases: readonly Pick<NotesPhase, "id" | "status" | "deletion" | "archivedAt">[],
  index: number,
): string | null {
  for (let position = index; position < phases.length; position += 1) {
    const phase = phases[position]!;
    if (isRoadmapPhaseOnRoadmap(phase) && phase.status === "done") return phase.id;
  }
  return null;
}

/**
 * Checks that a new phase may go directly before `targetPhaseId`: the target must be on the
 * Roadmap, and neither it nor any later Roadmap phase may be Done.
 */
export function validateRoadmapPhaseInsertionTarget(
  phases: readonly Pick<NotesPhase, "id" | "status" | "deletion" | "archivedAt">[],
  targetPhaseId: string,
): RoadmapPhaseOrderRefusal | null {
  const index = phases.findIndex((phase) => phase.id === targetPhaseId);
  const target = phases[index];
  if (!target || !isRoadmapPhaseOnRoadmap(target)) {
    return { reason: "target-unavailable", phaseId: targetPhaseId };
  }
  const donePhaseId = doneRoadmapPhaseFrom(phases, index);
  return donePhaseId === null
    ? null
    : { reason: "ahead-of-done", phaseId: targetPhaseId, donePhaseId };
}

/**
 * Places each inserted item directly before its target (keeping their relative order) and
 * appends the rest. Callers validate targets first; an unknown target is a bug.
 */
export function insertRoadmapPhases<T>(
  existing: readonly T[],
  inserted: readonly { item: T; insertBeforePhaseId?: string | undefined }[],
  idOf: (item: T) => string,
): T[] {
  const byTarget = new Map<string, T[]>();
  const appended: T[] = [];
  for (const { item, insertBeforePhaseId } of inserted) {
    if (insertBeforePhaseId === undefined) {
      appended.push(item);
      continue;
    }
    const group = byTarget.get(insertBeforePhaseId) ?? [];
    group.push(item);
    byTarget.set(insertBeforePhaseId, group);
  }
  const result: T[] = [];
  for (const item of existing) {
    const group = byTarget.get(idOf(item));
    if (group) {
      result.push(...group);
      byTarget.delete(idOf(item));
    }
    result.push(item);
  }
  if (byTarget.size > 0) {
    throw new Error(`insertRoadmapPhases: unknown target ${[...byTarget.keys()].join(", ")}`);
  }
  result.push(...appended);
  return result;
}

/** Plain-language reason for a refused placement, for tool and proposal errors. */
export function describeRoadmapPhaseOrderRefusal(refusal: RoadmapPhaseOrderRefusal): string {
  switch (refusal.reason) {
    case "phase-not-movable":
      return `phase ${refusal.phaseId} is ${refusal.notMovable} and cannot be moved`;
    case "target-unavailable":
      return `phase ${refusal.phaseId} is not on the Roadmap (missing, deleted, or archived)`;
    case "same-phase":
      return "a phase cannot be moved next to itself";
    case "ahead-of-done":
      return `that position is ahead of Done phase ${refusal.donePhaseId}`;
    case "no-change":
      return `phase ${refusal.phaseId} is already in that position`;
  }
}

/** Rewrites `order` to match array positions: no duplicates, no gaps. */
export function reindexRoadmapPhaseOrder<T extends { order: number }>(phases: readonly T[]): T[] {
  return phases.map((phase, order) => (phase.order === order ? phase : { ...phase, order }));
}

/**
 * Plans moving one phase directly before or after another. Done, archived and deleted phases
 * cannot move; the target must be on the Roadmap; and the moved phase may not land ahead of a
 * Roadmap Done phase. Returns the reordered, reindexed phase array.
 */
export function planRoadmapPhaseMove<
  T extends Pick<NotesPhase, "id" | "status" | "deletion" | "archivedAt" | "order">,
>(
  phases: readonly T[],
  phaseId: string,
  placement: RoadmapPhasePlacement,
): { ok: true; phases: T[] } | { ok: false; refusal: RoadmapPhaseOrderRefusal } {
  if (placement.targetPhaseId === phaseId) {
    return { ok: false, refusal: { reason: "same-phase", phaseId } };
  }
  const source = phases.find((phase) => phase.id === phaseId);
  const notMovable = classifyRoadmapPhaseEditability(source);
  if (notMovable !== null || !source) {
    return {
      ok: false,
      refusal: { reason: "phase-not-movable", phaseId, notMovable: notMovable ?? "missing" },
    };
  }
  const target = phases.find((phase) => phase.id === placement.targetPhaseId);
  if (!target || !isRoadmapPhaseOnRoadmap(target)) {
    return {
      ok: false,
      refusal: { reason: "target-unavailable", phaseId: placement.targetPhaseId },
    };
  }
  const remaining = phases.filter((phase) => phase.id !== phaseId);
  const targetIndex = remaining.findIndex((phase) => phase.id === placement.targetPhaseId);
  const insertAt = placement.position === "before" ? targetIndex : targetIndex + 1;
  const next = [...remaining];
  next.splice(insertAt, 0, source);
  const donePhaseId = doneRoadmapPhaseFrom(next, insertAt + 1);
  if (donePhaseId !== null) {
    return { ok: false, refusal: { reason: "ahead-of-done", phaseId, donePhaseId } };
  }
  const roadmapIds = (list: readonly T[]) =>
    list.filter(isRoadmapPhaseOnRoadmap).map((phase) => phase.id);
  if (stringArraysEqual(roadmapIds(phases), roadmapIds(next))) {
    return { ok: false, refusal: { reason: "no-change", phaseId } };
  }
  return { ok: true, phases: reindexRoadmapPhaseOrder(next) };
}

/** Moves one entry within an order list (entries are Roadmap phases only). */
export function moveRoadmapPhaseOrderEntry(
  entries: readonly RoadmapPhaseOrderEntry[],
  phaseId: string,
  placement: RoadmapPhasePlacement,
): RoadmapPhaseOrderEntry[] | null {
  const moved = entries.find((entry) => entry.phaseId === phaseId);
  if (!moved || placement.targetPhaseId === phaseId) return null;
  const remaining = entries.filter((entry) => entry.phaseId !== phaseId);
  const targetIndex = remaining.findIndex((entry) => entry.phaseId === placement.targetPhaseId);
  if (targetIndex < 0) return null;
  remaining.splice(placement.position === "before" ? targetIndex : targetIndex + 1, 0, moved);
  return remaining.map((entry) => ({ ...entry }));
}

export function roadmapPhaseMovePlacement(
  request: Pick<RoadmapPhaseMoveRequest, "beforePhaseId" | "afterPhaseId">,
): RoadmapPhasePlacement {
  return request.beforePhaseId !== undefined
    ? { position: "before", targetPhaseId: request.beforePhaseId }
    : { position: "after", targetPhaseId: request.afterPhaseId ?? "" };
}

export function validateRoadmapPhaseMoveRequest(
  value: unknown,
): RoadmapWorkflowValidationResult<RoadmapPhaseMoveRequest> {
  if (!isRecordWithKeys(value, MOVE_REQUEST_BASE_KEYS, MOVE_REQUEST_PLACEMENT_KEYS)) {
    return invalid(
      "$",
      `expected ${MOVE_REQUEST_BASE_KEYS.join(", ")} and exactly one of ${MOVE_REQUEST_PLACEMENT_KEYS.join(", ")}`,
    );
  }
  if (!isNonNegativeInteger(value.expectedRevision)) {
    return invalid("expectedRevision", "expected a non-negative integer");
  }
  const summary = normalizedBoundedString(
    value.summary,
    ROADMAP_PHASE_DRAFT_SUMMARY_MAX_LENGTH,
    "summary",
  );
  if (!summary.ok) return summary;
  const phaseId = boundedIdentifier(value.phaseId, "phaseId");
  if (!phaseId.ok) return phaseId;
  const hasBefore = value.beforePhaseId !== undefined;
  const hasAfter = value.afterPhaseId !== undefined;
  if (hasBefore === hasAfter) {
    return invalid("$", "expected exactly one of beforePhaseId or afterPhaseId");
  }
  const field = hasBefore ? "beforePhaseId" : "afterPhaseId";
  const target = boundedIdentifier(value[field], field);
  if (!target.ok) return target;
  if (target.value === phaseId.value) {
    return invalid(field, "a phase cannot be moved next to itself");
  }
  return {
    ok: true,
    value: {
      expectedRevision: value.expectedRevision,
      summary: summary.value,
      phaseId: phaseId.value,
      ...(hasBefore ? { beforePhaseId: target.value } : { afterPhaseId: target.value }),
    },
  };
}

export function validateRoadmapPhaseMoveDraft(
  value: unknown,
): RoadmapWorkflowValidationResult<RoadmapPhaseMoveDraft> {
  if (!isRecordWithExactKeys(value, MOVE_DRAFT_KEYS)) {
    return invalid("$", `expected exactly: ${MOVE_DRAFT_KEYS.join(", ")}`);
  }
  if (value.kind !== "move") return invalid("kind", 'expected "move"');
  const id = boundedIdentifier(value.id, "id");
  if (!id.ok) return id;
  const projectKey = normalizedBoundedString(value.projectKey, 4_096, "projectKey");
  if (!projectKey.ok) return projectKey;
  if (!isNonNegativeInteger(value.basedOnRevision)) {
    return invalid("basedOnRevision", "expected a non-negative integer");
  }
  if (!isIsoTimestamp(value.createdAt)) return invalid("createdAt", "expected an ISO timestamp");
  const sessionId = boundedIdentifier(value.createdBySessionId, "createdBySessionId");
  if (!sessionId.ok) return sessionId;
  const summary = normalizedBoundedString(
    value.summary,
    ROADMAP_PHASE_DRAFT_SUMMARY_MAX_LENGTH,
    "summary",
  );
  if (!summary.ok) return summary;
  const phaseId = boundedIdentifier(value.phaseId, "phaseId");
  if (!phaseId.ok) return phaseId;
  const phaseTitle = looseBeforeString(value.phaseTitle, "phaseTitle");
  if (!phaseTitle.ok) return phaseTitle;
  if (value.position !== "before" && value.position !== "after") {
    return invalid("position", 'expected "before" or "after"');
  }
  const targetPhaseId = boundedIdentifier(value.targetPhaseId, "targetPhaseId");
  if (!targetPhaseId.ok) return targetPhaseId;
  if (targetPhaseId.value === phaseId.value) {
    return invalid("targetPhaseId", "a phase cannot be moved next to itself");
  }
  const targetPhaseTitle = looseBeforeString(value.targetPhaseTitle, "targetPhaseTitle");
  if (!targetPhaseTitle.ok) return targetPhaseTitle;
  if (value.status !== "pending" && value.status !== "stale") {
    return invalid("status", 'expected "pending" or "stale"');
  }
  const preview = validateOrderPreview(value.orderPreview, "orderPreview");
  if (!preview.ok) return preview;
  const placement = { position: value.position, targetPhaseId: targetPhaseId.value } as const;
  const expectedAfter = moveRoadmapPhaseOrderEntry(preview.value.before, phaseId.value, placement);
  if (!expectedAfter || !orderEntriesEqual(expectedAfter, preview.value.after)) {
    return invalid("orderPreview.after", "expected the before order with the phase moved");
  }
  if (orderEntriesEqual(preview.value.before, preview.value.after)) {
    return invalid("orderPreview.after", "expected an order different from before");
  }
  return {
    ok: true,
    value: {
      kind: "move",
      id: id.value,
      projectKey: projectKey.value,
      basedOnRevision: value.basedOnRevision,
      createdAt: value.createdAt,
      createdBySessionId: sessionId.value,
      summary: summary.value,
      phaseId: phaseId.value,
      phaseTitle: phaseTitle.value,
      position: value.position,
      targetPhaseId: targetPhaseId.value,
      targetPhaseTitle: targetPhaseTitle.value,
      orderPreview: preview.value,
      status: value.status,
    },
  };
}

/**
 * Applies an approved move when the Roadmap order still matches the proposal and the move
 * still satisfies every placement rule. Only `order` values and `updatedAt` change.
 */
export function applyRoadmapPhaseMove(
  document: NotesDocumentV3,
  draft: RoadmapPhaseMoveDraft,
  timestamp: string,
): RoadmapPhaseMoveApplication {
  const source = document.phases.find((phase) => phase.id === draft.phaseId);
  const notMovable = classifyRoadmapPhaseEditability(source);
  if (notMovable !== null) {
    return { status: "phase-not-editable", phaseId: draft.phaseId, reason: notMovable };
  }
  const currentOrder = roadmapPhaseOrderEntries(document.phases).map((entry) => entry.phaseId);
  const proposedOrder = draft.orderPreview.before.map((entry) => entry.phaseId);
  if (!stringArraysEqual(currentOrder, proposedOrder)) {
    return { status: "phase-changed", phaseId: draft.phaseId };
  }
  const planned = planRoadmapPhaseMove(document.phases, draft.phaseId, {
    position: draft.position,
    targetPhaseId: draft.targetPhaseId,
  });
  if (!planned.ok) {
    return planned.refusal.reason === "phase-not-movable"
      ? {
          status: "phase-not-editable",
          phaseId: draft.phaseId,
          reason: planned.refusal.notMovable,
        }
      : { status: "phase-changed", phaseId: draft.phaseId };
  }
  const nextOrder = roadmapPhaseOrderEntries(planned.phases).map((entry) => entry.phaseId);
  const approvedOrder = draft.orderPreview.after.map((entry) => entry.phaseId);
  if (!stringArraysEqual(nextOrder, approvedOrder)) {
    return { status: "phase-changed", phaseId: draft.phaseId };
  }
  return {
    status: "ok",
    document: {
      ...document,
      phases: planned.phases,
      updatedAt: strictlyLaterTimestamp(timestamp, document.updatedAt),
    },
  };
}

/** Builds the approval-card order lists for a create draft that inserts phases. */
export function buildRoadmapPhaseInsertionPreview(
  phases: readonly Pick<NotesPhase, "id" | "title" | "deletion" | "archivedAt">[],
  drafted: readonly Pick<RoadmapDraftPhase, "phaseId" | "title" | "insertBeforePhaseId">[],
): RoadmapPhaseOrderPreview {
  const before = roadmapPhaseOrderEntries(phases);
  const after = insertRoadmapPhases(
    before,
    drafted.map((phase) => ({
      item: { phaseId: phase.phaseId, title: phase.title },
      insertBeforePhaseId: phase.insertBeforePhaseId,
    })),
    (entry) => entry.phaseId,
  );
  return { before, after: after.map((entry) => ({ ...entry })) };
}

function validateOrderPreview(
  value: unknown,
  path: string,
): RoadmapWorkflowValidationResult<RoadmapPhaseOrderPreview> {
  if (!isRecordWithExactKeys(value, ORDER_PREVIEW_KEYS)) {
    return invalid(path, `expected exactly: ${ORDER_PREVIEW_KEYS.join(", ")}`);
  }
  const before = validateOrderEntries(value.before, `${path}.before`);
  if (!before.ok) return before;
  const after = validateOrderEntries(value.after, `${path}.after`);
  if (!after.ok) return after;
  return { ok: true, value: { before: before.value, after: after.value } };
}

function validateOrderEntries(
  value: unknown,
  path: string,
): RoadmapWorkflowValidationResult<RoadmapPhaseOrderEntry[]> {
  if (!Array.isArray(value) || value.length > ROADMAP_PHASE_ORDER_PREVIEW_MAX_ITEMS) {
    return invalid(path, `expected up to ${ROADMAP_PHASE_ORDER_PREVIEW_MAX_ITEMS} phases`);
  }
  const seen = new Set<string>();
  const entries: RoadmapPhaseOrderEntry[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const candidate = value[index];
    if (!isRecordWithExactKeys(candidate, ORDER_ENTRY_KEYS)) {
      return invalid(`${path}[${index}]`, `expected exactly: ${ORDER_ENTRY_KEYS.join(", ")}`);
    }
    const phaseId = boundedIdentifier(candidate.phaseId, `${path}[${index}].phaseId`);
    if (!phaseId.ok) return phaseId;
    if (seen.has(phaseId.value)) {
      return invalid(`${path}[${index}].phaseId`, "expected a unique phase ID");
    }
    seen.add(phaseId.value);
    const title = looseBeforeString(candidate.title, `${path}[${index}].title`);
    if (!title.ok) return title;
    entries.push({ phaseId: phaseId.value, title: title.value });
  }
  return { ok: true, value: entries };
}

function orderEntriesEqual(
  left: readonly RoadmapPhaseOrderEntry[],
  right: readonly RoadmapPhaseOrderEntry[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry.phaseId === right[index]!.phaseId && entry.title === right[index]!.title,
    )
  );
}

export function validateRoadmapPhaseCreateDraft(
  value: unknown,
): RoadmapWorkflowValidationResult<RoadmapPhaseCreateDraft> {
  if (!isRecordWithKeys(value, DRAFT_BASE_KEYS, DRAFT_OPTIONAL_KEYS)) {
    return invalid("$", `expected exactly: ${DRAFT_KEYS.join(", ")}`);
  }
  const id = boundedIdentifier(value.id, "id");
  if (!id.ok) return id;
  const projectKey = normalizedBoundedString(value.projectKey, 4_096, "projectKey");
  if (!projectKey.ok) return projectKey;
  if (!isNonNegativeInteger(value.basedOnRevision)) {
    return invalid("basedOnRevision", "expected a non-negative integer");
  }
  if (!isIsoTimestamp(value.createdAt)) return invalid("createdAt", "expected an ISO timestamp");
  const sessionId = boundedIdentifier(value.createdBySessionId, "createdBySessionId");
  if (!sessionId.ok) return sessionId;
  const summary = normalizedBoundedString(
    value.summary,
    ROADMAP_PHASE_DRAFT_SUMMARY_MAX_LENGTH,
    "summary",
  );
  if (!summary.ok) return summary;
  const sourcesNotCited =
    value.sourcesNotCited === undefined || value.sourcesNotCited === null
      ? null
      : normalizedBoundedString(
          value.sourcesNotCited,
          ROADMAP_PHASE_DRAFT_SOURCES_NOT_CITED_MAX_LENGTH,
          "sourcesNotCited",
        );
  if (sourcesNotCited && !sourcesNotCited.ok) return sourcesNotCited;
  if (value.status !== "pending" && value.status !== "stale") {
    return invalid("status", 'expected "pending" or "stale"');
  }
  if (
    !Array.isArray(value.phases) ||
    value.phases.length < 1 ||
    value.phases.length > ROADMAP_PROPOSED_PHASES_MAX_ITEMS
  ) {
    return invalid("phases", `expected 1..${ROADMAP_PROPOSED_PHASES_MAX_ITEMS} phases`);
  }

  const references = validateDraftReferences(value.references ?? []);
  if (!references.ok) return references;
  const referenceIds = new Set(references.value.map((reference) => reference.id));

  const phaseIds = new Set<string>();
  const linkedReferenceIds = new Set<string>();
  const phases: RoadmapDraftPhase[] = [];
  for (let index = 0; index < value.phases.length; index += 1) {
    const candidate = value.phases[index];
    if (!isRecordWithKeys(candidate, DRAFT_PHASE_BASE_KEYS, DRAFT_PHASE_OPTIONAL_KEYS)) {
      return invalid(`phases[${index}]`, `expected exactly: ${DRAFT_PHASE_KEYS.join(", ")}`);
    }
    const phaseId = boundedIdentifier(candidate.phaseId, `phases[${index}].phaseId`);
    if (!phaseId.ok) return phaseId;
    if (phaseIds.has(phaseId.value)) {
      return invalid(`phases[${index}].phaseId`, "expected a unique phase ID");
    }
    phaseIds.add(phaseId.value);
    const phase = validateProposedPhaseRecord(candidate, `phases[${index}]`);
    if (!phase.ok) return phase;
    const linkedIds = validateReferenceLinks(
      candidate.referenceIds ?? [],
      `phases[${index}].referenceIds`,
      referenceIds,
    );
    if (!linkedIds.ok) return linkedIds;
    for (const referenceId of linkedIds.value) linkedReferenceIds.add(referenceId);
    const insertBefore = validateInsertBeforePhaseId(
      candidate.insertBeforePhaseId,
      `phases[${index}].insertBeforePhaseId`,
    );
    if (!insertBefore.ok) return insertBefore;
    phases.push({
      phaseId: phaseId.value,
      ...phase.value,
      referenceIds: linkedIds.value,
      ...(insertBefore.value === undefined ? {} : { insertBeforePhaseId: insertBefore.value }),
    });
  }
  for (let index = 0; index < references.value.length; index += 1) {
    if (!linkedReferenceIds.has(references.value[index]!.id)) {
      return invalid(`references[${index}].id`, "reference must be linked to a phase");
    }
  }

  const inserts = phases.some((phase) => phase.insertBeforePhaseId !== undefined);
  let orderPreview: RoadmapPhaseOrderPreview | undefined;
  if (value.orderPreview !== undefined || inserts) {
    if (value.orderPreview === undefined || !inserts) {
      return invalid("orderPreview", "expected an order preview exactly when phases are inserted");
    }
    const preview = validateOrderPreview(value.orderPreview, "orderPreview");
    if (!preview.ok) return preview;
    const existingIds = new Set(preview.value.before.map((entry) => entry.phaseId));
    for (let index = 0; index < phases.length; index += 1) {
      const target = phases[index]!.insertBeforePhaseId;
      if (target !== undefined && !existingIds.has(target)) {
        return invalid(
          `phases[${index}].insertBeforePhaseId`,
          "expected a phase in orderPreview.before",
        );
      }
      if (existingIds.has(phases[index]!.phaseId)) {
        return invalid(`phases[${index}].phaseId`, "expected a new phase ID");
      }
    }
    const expected = insertRoadmapPhases(
      preview.value.before,
      phases.map((phase) => ({
        item: { phaseId: phase.phaseId, title: phase.title },
        insertBeforePhaseId: phase.insertBeforePhaseId,
      })),
      (entry) => entry.phaseId,
    );
    if (!orderEntriesEqual(expected, preview.value.after)) {
      return invalid("orderPreview.after", "expected the before order with the new phases placed");
    }
    orderPreview = preview.value;
  }

  return {
    ok: true,
    value: {
      id: id.value,
      projectKey: projectKey.value,
      basedOnRevision: value.basedOnRevision,
      createdAt: value.createdAt,
      createdBySessionId: sessionId.value,
      summary: summary.value,
      references: references.value,
      phases,
      sourcesNotCited: sourcesNotCited ? sourcesNotCited.value : null,
      ...(orderPreview ? { orderPreview } : {}),
      status: value.status,
    },
  };
}

function validateInsertBeforePhaseId(
  value: unknown,
  path: string,
): RoadmapWorkflowValidationResult<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  return boundedIdentifier(value, path);
}

export function isRoadmapInspectionOutcome(value: unknown): value is RoadmapInspectionOutcome {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  if (value.status === "unsupported") return isProjectNotesUnsupportedFormat(value);
  if (value.status === "missing") {
    return (
      isRecordWithExactKeys(value, ["status", "projectKey"]) && isNonEmptyString(value.projectKey)
    );
  }
  if (value.status === "corrupt") {
    return (
      isRecordWithExactKeys(value, ["status", "projectKey", "primary", "backup"]) &&
      isNonEmptyString(value.projectKey) &&
      isCorruptReason(value.primary) &&
      isCorruptReason(value.backup)
    );
  }
  return (
    value.status === "ok" &&
    isRecordWithExactKeys(value, ["status", "inspection"]) &&
    isRoadmapInspection(value.inspection)
  );
}

export function isRoadmapInspection(value: unknown): value is RoadmapInspection {
  if (!isRecordWithExactKeys(value, ["projectKey", "revision", "phases"])) return false;
  return (
    isNonEmptyString(value.projectKey) &&
    isNonNegativeInteger(value.revision) &&
    Array.isArray(value.phases) &&
    value.phases.every(isRoadmapInspectionPhase)
  );
}

export function isRoadmapPhaseDraftApprovalResult(
  value: unknown,
): value is RoadmapPhaseDraftApprovalResult {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  switch (value.status) {
    case "created":
      return (
        isRecordWithExactKeys(value, ["status", "revision", "phaseIds"]) &&
        isNonNegativeInteger(value.revision) &&
        Array.isArray(value.phaseIds) &&
        value.phaseIds.length > 0 &&
        value.phaseIds.every(isNonEmptyString) &&
        new Set(value.phaseIds).size === value.phaseIds.length
      );
    case "edited":
    case "moved":
      return (
        isRecordWithExactKeys(value, ["status", "revision", "phaseId"]) &&
        isNonNegativeInteger(value.revision) &&
        isNonEmptyString(value.phaseId)
      );
    case "phase-changed":
      return isRecordWithExactKeys(value, ["status", "phaseId"]) && isNonEmptyString(value.phaseId);
    case "phase-not-editable":
      return (
        isRecordWithExactKeys(value, ["status", "phaseId", "reason"]) &&
        isNonEmptyString(value.phaseId) &&
        isNotEditableReason(value.reason)
      );
    case "already-decided":
      return isRecordWithExactKeys(value, ["status", "decision"]) && isDecision(value.decision);
    case "stale-revision":
      return (
        isRecordWithExactKeys(value, ["status", "expectedRevision", "currentRevision"]) &&
        isNonNegativeInteger(value.expectedRevision) &&
        isNonNegativeInteger(value.currentRevision)
      );
    case "invalid-proposal":
    case "storage-failed":
      return isRecordWithExactKeys(value, ["status", "message"]) && isNonEmptyString(value.message);
    case "proposal-not-found":
    case "proposal-project-mismatch":
    case "reconciliation-in-progress":
    case "notes-missing":
    case "notes-corrupt":
      return isRecordWithExactKeys(value, ["status"]);
    default:
      return false;
  }
}

export function isRoadmapPhaseDraftRejectionResult(
  value: unknown,
): value is RoadmapPhaseDraftRejectionResult {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  if (value.status === "already-decided") {
    return isRecordWithExactKeys(value, ["status", "decision"]) && isDecision(value.decision);
  }
  return (
    (value.status === "rejected" ||
      value.status === "proposal-not-found" ||
      value.status === "proposal-project-mismatch") &&
    isRecordWithExactKeys(value, ["status"])
  );
}

export function validateRoadmapDraftFeedback(
  value: unknown,
): RoadmapWorkflowValidationResult<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  return normalizedBoundedString(value, ROADMAP_DRAFT_FEEDBACK_MAX_LENGTH, "feedback");
}

function validateDraftReferenceProposals(
  value: unknown,
): RoadmapWorkflowValidationResult<RoadmapDraftReferenceProposal[]> {
  if (!Array.isArray(value) || value.length > ROADMAP_DRAFT_REFERENCES_MAX_ITEMS) {
    return invalid(
      "proposedReferences",
      `expected up to ${ROADMAP_DRAFT_REFERENCES_MAX_ITEMS} references`,
    );
  }
  const keys = new Set<string>();
  const identities = new Map<string, number>();
  const references: RoadmapDraftReferenceProposal[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const path = `proposedReferences[${index}]`;
    const candidate = value[index];
    if (!isRecordWithAllowedKeys(candidate, DRAFT_REFERENCE_PROPOSAL_KEYS)) {
      return invalid(path, "contains an unknown or missing required reference field");
    }
    const referenceKey = normalizedBoundedString(
      candidate.referenceKey,
      ROADMAP_DRAFT_REFERENCE_KEY_MAX_LENGTH,
      `${path}.referenceKey`,
    );
    if (!referenceKey.ok) return referenceKey;
    if (keys.has(referenceKey.value)) {
      return invalid(`${path}.referenceKey`, "expected a unique reference key");
    }
    keys.add(referenceKey.value);
    const reference = normalizeDraftReference(candidate, path, referenceKey.value);
    if (!reference.ok) return reference;
    const { id: _id, ...projection } = reference.value;
    const identity = canonicalReferenceIdentity(reference.value)!;
    const duplicateIndex = identities.get(identity);
    if (duplicateIndex !== undefined) {
      return invalid(
        `${path}.canonicalUrl`,
        `duplicate canonical source; already proposed at proposedReferences[${duplicateIndex}]`,
      );
    }
    identities.set(identity, index);
    references.push({ referenceKey: referenceKey.value, ...projection });
  }
  return { ok: true, value: references };
}

function validateDraftReferences(
  value: unknown,
): RoadmapWorkflowValidationResult<NotesReferenceProjection[]> {
  if (!Array.isArray(value) || value.length > ROADMAP_DRAFT_REFERENCES_MAX_ITEMS) {
    return invalid("references", `expected up to ${ROADMAP_DRAFT_REFERENCES_MAX_ITEMS} references`);
  }
  const ids = new Set<string>();
  const identities = new Map<string, number>();
  const references: NotesReferenceProjection[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const path = `references[${index}]`;
    const candidate = value[index];
    if (!isRecordWithExactKeys(candidate, REFERENCE_PROJECTION_KEYS)) {
      return invalid(path, `expected exactly: ${REFERENCE_PROJECTION_KEYS.join(", ")}`);
    }
    const id = boundedIdentifier(candidate.id, `${path}.id`);
    if (!id.ok) return id;
    if (ids.has(id.value)) return invalid(`${path}.id`, "expected a unique reference ID");
    ids.add(id.value);
    const reference = normalizeDraftReference(candidate, path, id.value);
    if (!reference.ok) return reference;
    const identity = canonicalReferenceIdentity(reference.value)!;
    const duplicateIndex = identities.get(identity);
    if (duplicateIndex !== undefined) {
      return invalid(
        `${path}.canonicalUrl`,
        `duplicate canonical source; already proposed at references[${duplicateIndex}]`,
      );
    }
    identities.set(identity, index);
    references.push(reference.value);
  }
  return { ok: true, value: references };
}

function normalizeDraftReference(
  value: Record<string, unknown>,
  path: string,
  id: string,
): RoadmapWorkflowValidationResult<NotesReferenceProjection> {
  const required = ["provider", "canonicalUrl", "owner", "repo"] as const;
  const normalizedRequired: Record<(typeof required)[number], string> = {
    provider: "",
    canonicalUrl: "",
    owner: "",
    repo: "",
  };
  for (const field of required) {
    const result = normalizedBoundedString(
      value[field],
      field === "canonicalUrl" ? 2_048 : 4_096,
      `${path}.${field}`,
    );
    if (!result.ok) return result;
    normalizedRequired[field] = result.value;
  }
  const optionalFields = ["tool", "revision", "path", "query", "anchor"] as const;
  const optional: Record<(typeof optionalFields)[number], string | null> = {
    tool: null,
    revision: null,
    path: null,
    query: null,
    anchor: null,
  };
  for (const field of optionalFields) {
    if (value[field] === undefined || value[field] === null) continue;
    const result = normalizedBoundedString(value[field], 4_096, `${path}.${field}`);
    if (!result.ok) return result;
    optional[field] = result.value;
  }
  if (typeof value.relevance !== "string") return invalid(`${path}.relevance`, "expected a string");
  const relevance = normalizeRoadmapWorkflowText(value.relevance);
  const canonicalUrl =
    normalizeCanonicalUrl(normalizedRequired.canonicalUrl) ?? normalizedRequired.canonicalUrl;
  const reference: NotesReferenceProjection = {
    id,
    provider: normalizedRequired.provider.toLowerCase(),
    tool: optional.tool,
    canonicalUrl,
    owner: normalizedRequired.owner,
    repo: normalizedRequired.repo,
    revision: optional.revision,
    path: optional.path,
    range:
      value.range === undefined || value.range === null || !isRecord(value.range)
        ? ((value.range as null | undefined) ?? null)
        : { startLine: value.range.startLine as number, endLine: value.range.endLine as number },
    issue: (value.issue as number | null | undefined) ?? null,
    pullRequest: (value.pullRequest as number | null | undefined) ?? null,
    query: optional.query,
    anchor: optional.anchor,
    relevance,
  };
  const error = validateNotesReferenceProjection(reference, path);
  if (error) return invalid(error.path, error.message);
  return { ok: true, value: reference };
}

function validateReferenceLinks(
  value: unknown,
  path: string,
  knownReferences: ReadonlySet<string>,
): RoadmapWorkflowValidationResult<string[]> {
  if (!Array.isArray(value) || value.length > ROADMAP_DRAFT_REFERENCE_KEYS_MAX_ITEMS) {
    return invalid(path, `expected up to ${ROADMAP_DRAFT_REFERENCE_KEYS_MAX_ITEMS} references`);
  }
  const seen = new Set<string>();
  const links: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const link = normalizedBoundedString(
      value[index],
      ROADMAP_DRAFT_REFERENCE_KEY_MAX_LENGTH,
      `${path}[${index}]`,
    );
    if (!link.ok) return link;
    if (seen.has(link.value))
      return invalid(`${path}[${index}]`, "expected a unique reference link");
    if (!knownReferences.has(link.value))
      return invalid(`${path}[${index}]`, "unknown reference link");
    seen.add(link.value);
    links.push(link.value);
  }
  return { ok: true, value: links };
}

function validateProposedPhase(
  value: unknown,
  path: string,
  knownReferenceKeys: ReadonlySet<string>,
): RoadmapWorkflowValidationResult<RoadmapProposedPhase> {
  if (!isRecordWithKeys(value, PROPOSED_PHASE_BASE_KEYS, PROPOSED_PHASE_OPTIONAL_KEYS)) {
    return invalid(path, `expected exactly: ${PROPOSED_PHASE_KEYS.join(", ")}`);
  }
  const phase = validateProposedPhaseRecord(value, path);
  if (!phase.ok) return phase;
  const referenceKeys = validateReferenceLinks(
    value.referenceKeys ?? [],
    `${path}.referenceKeys`,
    knownReferenceKeys,
  );
  if (!referenceKeys.ok) return referenceKeys;
  const insertBefore = validateInsertBeforePhaseId(
    value.insertBeforePhaseId,
    `${path}.insertBeforePhaseId`,
  );
  if (!insertBefore.ok) return insertBefore;
  return {
    ok: true,
    value: {
      ...phase.value,
      referenceKeys: referenceKeys.value,
      ...(insertBefore.value === undefined ? {} : { insertBeforePhaseId: insertBefore.value }),
    },
  };
}

function validateProposedPhaseRecord(
  value: Record<string, unknown>,
  path: string,
): RoadmapWorkflowValidationResult<RoadmapProposedPhase> {
  const title = validatePhaseTitle(value.title, `${path}.title`);
  if (!title.ok) return title;
  const goal = validatePhaseGoal(value.goal, `${path}.goal`);
  if (!goal.ok) return goal;
  const sourcePrompt = validatePhaseSourcePrompt(value.sourcePrompt, `${path}.sourcePrompt`);
  if (!sourcePrompt.ok) return sourcePrompt;
  const doneWhen = validatePhaseDoneWhen(value.doneWhen, `${path}.doneWhen`);
  if (!doneWhen.ok) return doneWhen;
  return {
    ok: true,
    value: {
      title: title.value,
      goal: goal.value,
      doneWhen: doneWhen.value,
      sourcePrompt: sourcePrompt.value,
    },
  };
}

function validatePhaseTitle(value: unknown, path: string): RoadmapWorkflowValidationResult<string> {
  return normalizedBoundedString(value, ROADMAP_PHASE_TITLE_MAX_LENGTH, path);
}

function validatePhaseGoal(value: unknown, path: string): RoadmapWorkflowValidationResult<string> {
  return normalizedBoundedString(value, ROADMAP_PHASE_GOAL_MAX_LENGTH, path);
}

function validatePhaseSourcePrompt(
  value: unknown,
  path: string,
): RoadmapWorkflowValidationResult<string> {
  return normalizedBoundedString(value, ROADMAP_PHASE_SOURCE_PROMPT_MAX_LENGTH, path);
}

function validatePhaseDoneWhen(
  value: unknown,
  path: string,
): RoadmapWorkflowValidationResult<string[]> {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > ROADMAP_PHASE_DONE_WHEN_MAX_ITEMS
  ) {
    return invalid(path, `expected 1..${ROADMAP_PHASE_DONE_WHEN_MAX_ITEMS} completion criteria`);
  }
  const seen = new Set<string>();
  const doneWhen: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = normalizedBoundedString(
      value[index],
      ROADMAP_PHASE_DONE_WHEN_ITEM_MAX_LENGTH,
      `${path}[${index}]`,
    );
    if (!item.ok) return item;
    if (seen.has(item.value)) {
      return invalid(`${path}[${index}]`, "expected a unique completion criterion");
    }
    seen.add(item.value);
    doneWhen.push(item.value);
  }
  return { ok: true, value: doneWhen };
}

function validateFieldChange(
  value: unknown,
  path: string,
): RoadmapWorkflowValidationResult<RoadmapPhaseFieldChange> {
  if (!isRecordWithExactKeys(value, FIELD_CHANGE_KEYS)) {
    return invalid(path, `expected exactly: ${FIELD_CHANGE_KEYS.join(", ")}`);
  }
  const field = value.field;
  if (field === "doneWhen") {
    const before = looseBeforeList(value.before, `${path}.before`);
    if (!before.ok) return before;
    const after = validatePhaseDoneWhen(value.after, `${path}.after`);
    if (!after.ok) return after;
    if (stringArraysEqual(before.value, after.value)) {
      return invalid(`${path}.after`, "expected a value different from before");
    }
    return { ok: true, value: { field, before: before.value, after: after.value } };
  }
  if (field !== "title" && field !== "goal" && field !== "sourcePrompt") {
    return invalid(`${path}.field`, `expected one of: ${ROADMAP_PHASE_EDIT_FIELDS.join(", ")}`);
  }
  const before = looseBeforeString(value.before, `${path}.before`);
  if (!before.ok) return before;
  const after =
    field === "title"
      ? validatePhaseTitle(value.after, `${path}.after`)
      : field === "goal"
        ? validatePhaseGoal(value.after, `${path}.after`)
        : validatePhaseSourcePrompt(value.after, `${path}.after`);
  if (!after.ok) return after;
  if (before.value === after.value) {
    return invalid(`${path}.after`, "expected a value different from before");
  }
  return { ok: true, value: { field, before: before.value, after: after.value } };
}

/** `before` values are copied verbatim from Notes: bounded, never normalized, may be empty. */
function looseBeforeString(value: unknown, path: string): RoadmapWorkflowValidationResult<string> {
  if (
    typeof value !== "string" ||
    Array.from(value).length > ROADMAP_PHASE_EDIT_BEFORE_MAX_LENGTH
  ) {
    return invalid(
      path,
      `expected a string of up to ${ROADMAP_PHASE_EDIT_BEFORE_MAX_LENGTH} characters`,
    );
  }
  return { ok: true, value };
}

function looseBeforeList(value: unknown, path: string): RoadmapWorkflowValidationResult<string[]> {
  if (!Array.isArray(value) || value.length > ROADMAP_PHASE_EDIT_BEFORE_DONE_WHEN_MAX_ITEMS) {
    return invalid(path, `expected up to ${ROADMAP_PHASE_EDIT_BEFORE_DONE_WHEN_MAX_ITEMS} items`);
  }
  const items: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = looseBeforeString(value[index], `${path}[${index}]`);
    if (!item.ok) return item;
    items.push(item.value);
  }
  return { ok: true, value: items };
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function strictlyLaterTimestamp(candidate: string, previous: string): string {
  const candidateMs = Date.parse(candidate);
  if (Number.isNaN(candidateMs)) throw new Error("applyRoadmapPhaseEdit: invalid timestamp");
  const previousMs = Date.parse(previous);
  if (Number.isNaN(previousMs) || candidateMs > previousMs) return candidate;
  return new Date(previousMs + 1).toISOString();
}

function isNotEditableReason(value: unknown): value is RoadmapPhaseNotEditableReason {
  return value === "missing" || value === "deleted" || value === "done" || value === "archived";
}

function isRoadmapInspectionPhase(value: unknown): value is RoadmapInspectionPhase {
  if (
    !isRecordWithKeys(
      value,
      [
        "id",
        "title",
        "goal",
        "doneWhen",
        "order",
        "status",
        "archivedAt",
        "hasBoundSession",
        "latestProgress",
        "latestBlocker",
        "latestVerification",
        "latestReview",
        "hasUserStatusOverride",
      ],
      ["sourcePrompt"],
    )
  ) {
    return false;
  }
  return (
    (!Object.hasOwn(value, "sourcePrompt") || typeof value.sourcePrompt === "string") &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.title) &&
    isNonEmptyString(value.goal) &&
    Array.isArray(value.doneWhen) &&
    value.doneWhen.every(isNonEmptyString) &&
    isNonNegativeInteger(value.order) &&
    isNotesPhaseStatus(value.status) &&
    isNullableTimestamp(value.archivedAt) &&
    typeof value.hasBoundSession === "boolean" &&
    isNullableString(value.latestProgress) &&
    isNullableString(value.latestBlocker) &&
    isInspectionVerification(value.latestVerification) &&
    isInspectionReview(value.latestReview) &&
    typeof value.hasUserStatusOverride === "boolean"
  );
}

function isInspectionVerification(value: unknown): boolean {
  if (value === null) return true;
  // Accept the exact legacy shape, never partially populated provenance or unknown fields.
  if (!isRecord(value)) return false;
  const legacy = Object.keys(value).length === 2;
  const keys = legacy
    ? ["status", "reason"]
    : ["status", "reason", "evidence", "updateId", "timestamp", "progress"];
  if (!isRecordWithExactKeys(value, keys)) return false;
  if (!isNotesVerificationStatus(value.status) || !isNullableString(value.reason)) return false;
  if (legacy) return true;
  return (
    (value.reason === null || value.reason.length <= NOTES_ROADMAP_REASON_MAX_LENGTH) &&
    isValidNotesRoadmapEvidence(value.evidence) &&
    isNonEmptyString(value.updateId) &&
    isIsoTimestamp(value.timestamp) &&
    isNonEmptyString(value.progress) &&
    value.progress.length <= 4_096
  );
}

function isInspectionReview(value: unknown): boolean {
  return (
    value === null ||
    (isRecordWithExactKeys(value, ["reviewer", "decision", "reason"]) &&
      isNotesRoadmapReviewer(value.reviewer) &&
      isNotesReviewDecision(value.decision) &&
      isNullableString(value.reason))
  );
}

function normalizedBoundedString(
  value: unknown,
  maxLength: number,
  path: string,
): RoadmapWorkflowValidationResult<string> {
  if (typeof value !== "string") return invalid(path, "expected a string");
  const normalized = normalizeRoadmapWorkflowText(value);
  const length = Array.from(normalized).length;
  if (length < 1 || length > maxLength) {
    return invalid(path, `expected 1..${maxLength} normalized characters`);
  }
  return { ok: true, value: normalized };
}

function boundedIdentifier(value: unknown, path: string): RoadmapWorkflowValidationResult<string> {
  return normalizedBoundedString(value, 512, path);
}

function invalid<T = never>(path: string, message: string): RoadmapWorkflowValidationResult<T> {
  return { ok: false, error: { path, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordWithExactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => actual.includes(key));
}

/** Requires every `required` key and permits only keys from `required` or `optional`. */
function isRecordWithKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}

function isRecordWithAllowedKeys(
  value: unknown,
  allowed: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const required = ["referenceKey", "provider", "canonicalUrl", "owner", "repo", "relevance"];
  return (
    Object.keys(value).every((key) => allowed.includes(key)) &&
    required.every((key) => key in value)
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isNonEmptyString(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isIsoTimestamp(value);
}

function isCorruptReason(value: unknown): boolean {
  return (
    value === null ||
    value === "malformed-json" ||
    value === "invalid-envelope" ||
    value === "project-key-mismatch"
  );
}

function isDecision(value: unknown): value is "approved" | "rejected" {
  return value === "approved" || value === "rejected";
}
