/** Browser-safe history projections. IDs and references never confer execution or receipt authority. */
import { isDiscoveryCandidate, type DiscoveryCandidate } from "./programmatic-discovery-contract.js";
export { isDiscoveryCandidate, isDiscoveryProjection, isDiscoveryReviewRequest, isDiscoveryReview,
  type DiscoveryCandidate, type DiscoveryAvailability, type DiscoveryChoice, type DiscoveryProjection, type DiscoveryReviewRequest, type DiscoveryReview } from "./programmatic-discovery-contract.js";
export type RecommendationSaveStatus =
  | { status: "disabled" | "setup-not-saved" }
  | { status: "saved"; assessmentId: string; historyRevision: number }
  | { status: "unsaved" | "acknowledgement-unknown"; assessmentId: string; reason: string };
export interface RecommendationSummary {
  id: string;
  revision: number;
  outcome: string;
  decision: "open" | "dismissed" | "completed";
  ambiguity: "none" | "exact-workflow-duplicate";
  observationCount: number;
  canonicalId?: string;
}
/** Shared bound and navigation stride for recommendation summary pages. */
export const RECOMMENDATION_HISTORY_PAGE_SIZE = 50;
export interface RecommendationHistoryReport {
  version: 1;
  status: "disabled" | "missing" | "ready" | "recovered" | "unavailable";
  revision: number;
  total: number;
  offset: number;
  candidates: RecommendationSummary[];
  warning?: string;
}
/** Inert display JSON from the validated store; never parse this into an action/request. */
export interface RecommendationDetail {
  version: 1; historyRevision: number; candidate: RecommendationSummary;
  offset: number; total: number;
  records: { id: string; kind: "observation" | "assessment" | "decision" | "correspondence"; displayJson: string }[];
  /** Optional typed display; historical evidence must be freshly inspected before handoff. */
  discovery?: DiscoveryCandidate;
}
export interface RecommendationReview {
  version: 1; reviewId: string; historyRevision: number;
  operation: "open" | "dismissed" | "completed" | "correspondence";
  candidates: RecommendationSummary[];
  details: string[];
  warning: string;
}

/** Compact IDs/revisions only, below the native bridge's 2,048-byte limit. */
export type RecommendationHistoryRequest =
  | { action: "history-report"; offset: number }
  | { action: "history-detail"; candidateId: string; offset: number }
  | { action: "history-inspect-decision"; candidateId: string; expectedRevision: number; decision: "open" | "dismissed" | "completed" }
  | { action: "history-inspect-correspondence"; candidateId: string; expectedRevision: number; otherId: string; otherExpectedRevision: number }
  | { action: "history-apply"; reviewId: string };

type Guard = (value: unknown) => boolean;
const oneOf = (...values: unknown[]): Guard => (value) => values.includes(value);
const integer: Guard = (value) => Number.isSafeInteger(value) && (value as number) >= 0;
const positive: Guard = (value) => integer(value) && (value as number) > 0;
const bounded = (max: number): Guard => (value) => integer(value) && (value as number) <= max;
const text: Guard = (value) => typeof value === "string" && value.length > 0 && value.length <= 4_000 &&
  [...value].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127);
/** Match advisory extension text without loosening other display or authority fields. */
const outcomeText: Guard = (value) => typeof value === "string" && value.length <= 4_000 && value.trim().length > 0 &&
  [...value].every((char) => {
    const code = char.charCodeAt(0);
    return (code >= 32 && (code < 127 || code > 159)) || char === "\n" || char === "\r" || char === "\t";
  });
const uuid: Guard = (value) => typeof value === "string" && value.length === 36 &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function object(value: unknown, fields: Record<string, Guard>, optional: Record<string, Guard> = {}): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).every((key) => Object.hasOwn(fields, key) || Object.hasOwn(optional, key)) &&
    Object.entries(fields).every(([key, guard]) => Object.hasOwn(record, key) && guard(record[key])) &&
    Object.entries(optional).every(([key, guard]) => !Object.hasOwn(record, key) || guard(record[key]));
}
export function isRecommendationSaveStatus(value: unknown): value is RecommendationSaveStatus {
  return object(value, { status: oneOf("disabled", "setup-not-saved") }) ||
    object(value, { status: oneOf("saved"), assessmentId: uuid, historyRevision: integer }) ||
    object(value, { status: oneOf("unsaved", "acknowledgement-unknown"), assessmentId: uuid, reason: text });
}
export function isRecommendationSummary(value: unknown): value is RecommendationSummary {
  return object(value, { id: uuid, revision: positive, outcome: outcomeText, decision: oneOf("open", "dismissed", "completed"),
    ambiguity: oneOf("none", "exact-workflow-duplicate"), observationCount: (count) => positive(count) && bounded(16_384)(count) }, { canonicalId: uuid });
}
export function isRecommendationHistoryReport(value: unknown): value is RecommendationHistoryReport {
  if (!object(value, { version: oneOf(1), status: oneOf("disabled", "missing", "ready", "recovered", "unavailable"),
    revision: integer, total: bounded(1_000), offset: bounded(1_000),
    candidates: (items) => Array.isArray(items) && items.length <= RECOMMENDATION_HISTORY_PAGE_SIZE && items.every(isRecommendationSummary) }, { warning: text })) return false;
  const report = value as RecommendationHistoryReport;
  return report.offset <= report.total && report.offset + report.candidates.length <= report.total &&
    new Set(report.candidates.map((item) => item.id)).size === report.candidates.length;
}
const displayJson: Guard = (value) => typeof value === "string" && value.length > 0 && value.length <= 262_144;
export function isRecommendationDetail(value: unknown): value is RecommendationDetail {
  if (!object(value, { version: oneOf(1), historyRevision: integer, candidate: isRecommendationSummary,
    offset: bounded(32_768), total: bounded(32_768), records: (records) => Array.isArray(records) && records.length <= 1 && records.every((record) =>
      object(record, { id: uuid, kind: oneOf("observation", "assessment", "decision", "correspondence"), displayJson })) }, { discovery: isDiscoveryCandidate })) return false;
  const detail = value as RecommendationDetail;
  return detail.offset <= detail.total && detail.offset + detail.records.length <= detail.total;
}
export function isRecommendationReview(value: unknown): value is RecommendationReview {
  if (!object(value, { version: oneOf(1), reviewId: uuid, historyRevision: integer,
    operation: oneOf("open", "dismissed", "completed", "correspondence"),
    candidates: (items) => Array.isArray(items) && items.length > 0 && items.length <= 2 && items.every(isRecommendationSummary),
    details: (items) => Array.isArray(items) && items.length > 0 && items.length <= 2 && items.every(displayJson), warning: text })) return false;
  const review = value as RecommendationReview;
  return review.candidates.length === review.details.length &&
    review.candidates.length === (review.operation === "correspondence" ? 2 : 1) &&
    new Set(review.candidates.map((candidate) => candidate.id)).size === review.candidates.length;
}
export function isRecommendationHistoryRequest(value: unknown): value is RecommendationHistoryRequest {
  if (!value || typeof value !== "object") return false;
  switch ((value as { action?: unknown }).action) {
    case "history-report": return object(value, { action: oneOf("history-report"), offset: bounded(1_000) });
    case "history-detail": return object(value, { action: oneOf("history-detail"), candidateId: uuid, offset: bounded(32_768) });
    case "history-inspect-decision": return object(value, { action: oneOf("history-inspect-decision"), candidateId: uuid,
      expectedRevision: positive, decision: oneOf("open", "dismissed", "completed") });
    case "history-inspect-correspondence": return object(value, { action: oneOf("history-inspect-correspondence"), candidateId: uuid,
      expectedRevision: positive, otherId: uuid, otherExpectedRevision: positive }) &&
      (value as { candidateId: string }).candidateId !== (value as { otherId: string }).otherId;
    case "history-apply": return object(value, { action: oneOf("history-apply"), reviewId: uuid });
    default: return false;
  }
}
