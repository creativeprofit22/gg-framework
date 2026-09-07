import {
  isNotesPhaseStatus,
  isNotesReviewDecision,
  isNotesRoadmapReviewer,
  isNotesVerificationStatus,
  NOTES_ROADMAP_PROPOSALS_MAX_ITEMS,
  canonicalReferenceIdentity,
  normalizeCanonicalUrl,
  validateNotesReferenceProjection,
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
export const ROADMAP_DRAFT_REFERENCE_KEYS_MAX_ITEMS = 20;
export const ROADMAP_DRAFT_FEEDBACK_MAX_LENGTH = 4_096;

export interface RoadmapWorkflowValidationError {
  path: string;
  message: string;
}

export type RoadmapWorkflowValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: RoadmapWorkflowValidationError };

export interface RoadmapInspectionVerificationSummary {
  status: NotesVerificationStatus;
  reason: string | null;
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
}

export interface RoadmapPhaseDraftRequest {
  expectedRevision: number;
  summary: string;
  phases: RoadmapProposedPhase[];
  proposedReferences?: RoadmapDraftReferenceProposal[];
}

export interface RoadmapDraftPhase extends Omit<RoadmapProposedPhase, "referenceKeys"> {
  phaseId: string;
  referenceIds: string[];
}

export interface RoadmapPhaseDraft {
  id: string;
  projectKey: string;
  basedOnRevision: number;
  createdAt: string;
  createdBySessionId: string;
  summary: string;
  references: NotesReferenceProjection[];
  phases: RoadmapDraftPhase[];
  status: "pending" | "stale";
}

export type RoadmapPhaseDraftApprovalResult =
  | { status: "created"; revision: number; phaseIds: string[] }
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
const PROPOSED_PHASE_KEYS = [...PROPOSED_PHASE_BASE_KEYS, "referenceKeys"] as const;
const DRAFT_PHASE_BASE_KEYS = ["phaseId", ...PROPOSED_PHASE_BASE_KEYS] as const;
const DRAFT_PHASE_KEYS = [...DRAFT_PHASE_BASE_KEYS, "referenceIds"] as const;
const DRAFT_REQUEST_BASE_KEYS = ["expectedRevision", "summary", "phases"] as const;
const DRAFT_REQUEST_KEYS = [...DRAFT_REQUEST_BASE_KEYS, "proposedReferences"] as const;
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
const DRAFT_KEYS = [...DRAFT_BASE_KEYS.slice(0, 6), "references", "phases", "status"] as const;
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

/** Normalizes wire text before length checks and persistence. */
export function normalizeRoadmapWorkflowText(value: string): string {
  return value.normalize("NFC").replace(/\r\n?/g, "\n").trim();
}

export function validateRoadmapPhaseDraftRequest(
  value: unknown,
): RoadmapWorkflowValidationResult<RoadmapPhaseDraftRequest> {
  if (
    !isRecordWithExactKeys(value, DRAFT_REQUEST_BASE_KEYS) &&
    !isRecordWithExactKeys(value, DRAFT_REQUEST_KEYS)
  ) {
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
    },
  };
}

export function isRoadmapPhaseDraftRequest(value: unknown): value is RoadmapPhaseDraftRequest {
  return validateRoadmapPhaseDraftRequest(value).ok;
}

export function validateRoadmapPhaseDraft(
  value: unknown,
): RoadmapWorkflowValidationResult<RoadmapPhaseDraft> {
  if (!isRecordWithExactKeys(value, DRAFT_BASE_KEYS) && !isRecordWithExactKeys(value, DRAFT_KEYS)) {
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
    if (
      !isRecordWithExactKeys(candidate, DRAFT_PHASE_BASE_KEYS) &&
      !isRecordWithExactKeys(candidate, DRAFT_PHASE_KEYS)
    ) {
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
    phases.push({ phaseId: phaseId.value, ...phase.value, referenceIds: linkedIds.value });
  }
  for (let index = 0; index < references.value.length; index += 1) {
    if (!linkedReferenceIds.has(references.value[index]!.id)) {
      return invalid(`references[${index}].id`, "reference must be linked to a phase");
    }
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
      status: value.status,
    },
  };
}

export function isRoadmapPhaseDraft(value: unknown): value is RoadmapPhaseDraft {
  return validateRoadmapPhaseDraft(value).ok;
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
  if (!Array.isArray(value) || value.length > NOTES_ROADMAP_PROPOSALS_MAX_ITEMS) {
    return invalid(
      "proposedReferences",
      `expected up to ${NOTES_ROADMAP_PROPOSALS_MAX_ITEMS} references`,
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
  if (!Array.isArray(value) || value.length > NOTES_ROADMAP_PROPOSALS_MAX_ITEMS) {
    return invalid("references", `expected up to ${NOTES_ROADMAP_PROPOSALS_MAX_ITEMS} references`);
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
  if (
    !isRecordWithExactKeys(value, PROPOSED_PHASE_BASE_KEYS) &&
    !isRecordWithExactKeys(value, PROPOSED_PHASE_KEYS)
  ) {
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
  return { ok: true, value: { ...phase.value, referenceKeys: referenceKeys.value } };
}

function validateProposedPhaseRecord(
  value: Record<string, unknown>,
  path: string,
): RoadmapWorkflowValidationResult<RoadmapProposedPhase> {
  const title = normalizedBoundedString(
    value.title,
    ROADMAP_PHASE_TITLE_MAX_LENGTH,
    `${path}.title`,
  );
  if (!title.ok) return title;
  const goal = normalizedBoundedString(value.goal, ROADMAP_PHASE_GOAL_MAX_LENGTH, `${path}.goal`);
  if (!goal.ok) return goal;
  const sourcePrompt = normalizedBoundedString(
    value.sourcePrompt,
    ROADMAP_PHASE_SOURCE_PROMPT_MAX_LENGTH,
    `${path}.sourcePrompt`,
  );
  if (!sourcePrompt.ok) return sourcePrompt;
  if (
    !Array.isArray(value.doneWhen) ||
    value.doneWhen.length < 1 ||
    value.doneWhen.length > ROADMAP_PHASE_DONE_WHEN_MAX_ITEMS
  ) {
    return invalid(
      `${path}.doneWhen`,
      `expected 1..${ROADMAP_PHASE_DONE_WHEN_MAX_ITEMS} completion criteria`,
    );
  }
  const seen = new Set<string>();
  const doneWhen: string[] = [];
  for (let index = 0; index < value.doneWhen.length; index += 1) {
    const item = normalizedBoundedString(
      value.doneWhen[index],
      ROADMAP_PHASE_DONE_WHEN_ITEM_MAX_LENGTH,
      `${path}.doneWhen[${index}]`,
    );
    if (!item.ok) return item;
    if (seen.has(item.value)) {
      return invalid(`${path}.doneWhen[${index}]`, "expected a unique completion criterion");
    }
    seen.add(item.value);
    doneWhen.push(item.value);
  }
  return {
    ok: true,
    value: { title: title.value, goal: goal.value, doneWhen, sourcePrompt: sourcePrompt.value },
  };
}

function isRoadmapInspectionPhase(value: unknown): value is RoadmapInspectionPhase {
  if (
    !isRecordWithExactKeys(value, [
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
    ])
  ) {
    return false;
  }
  return (
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
  return (
    value === null ||
    (isRecordWithExactKeys(value, ["status", "reason"]) &&
      isNotesVerificationStatus(value.status) &&
      isNullableString(value.reason))
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
