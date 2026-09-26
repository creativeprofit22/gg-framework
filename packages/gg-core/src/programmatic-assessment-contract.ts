import { isValidProgrammaticFocus } from "./slash-command-contract.js";
import { isDiscoveryProjection, isRecommendationSaveStatus, type DiscoveryProjection, type RecommendationSaveStatus } from "./programmatic-recommendation-contract.js";

/** Display only. Hosts project accepted advisory evidence/recommendations; this is
 * not another model-result schema, receipt validator, or approval payload. */
export const PROGRAMMATIC_ASSESSMENT_VERSION = 1 as const;
export const PROGRAMMATIC_ASSESSMENT_TEXT_LIMIT = 4_000;
export const PROGRAMMATIC_ASSESSMENT_ITEM_LIMIT = 50;

export interface ProgrammaticAssessmentCoverage {
  /** Catalog inspection never implies project inspection. */
  scope: "project" | "catalog";
  status: "inspected" | "uninspected" | "budget-limited" | "unreadable" | "unsafe" | "nonmatching" | "not-applicable";
  summary: string;
}
export type ProgrammaticAssessmentDeterministicOutcome =
  | { status: "not-run"; reason: "setup" }
  | { status: "unavailable" | "denied" | "cancelled" | "failed"; reason: string }
  | { status: "succeeded"; enabledCount: number; applicableCount: number };
export interface ProgrammaticAssessmentIdentity {
  conversationId: string;
  sessionId: string;
  sequence: number;
  /** Correlates a desktop request; never an approval capability. */
  requestId?: string;
}
export const isProgrammaticAssessmentRequestId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const identityFields = {
  conversationId: (id: unknown) => typeof id === "string" && id.length > 0 && id.length <= 256,
  sessionId: (id: unknown) => typeof id === "string" && id.length > 0 && id.length <= 256,
  sequence: (seq: unknown) => Number.isSafeInteger(seq) && (seq as number) > 0,
};
export function isProgrammaticAssessmentIdentity(value: unknown): value is ProgrammaticAssessmentIdentity {
  return object(value, identityFields, { requestId: isProgrammaticAssessmentRequestId });
}
export interface ProgrammaticAssessment {
  version: 1;
  /** Host-owned completion receipt, absent on legacy projections. */
  lifecycle?: ProgrammaticAssessmentIdentity;
  mode: "setup" | "configured";
  focus?: string;
  /** Completion is scoped assessment completion, never a universal clean bill. */
  status: "completed" | "incomplete" | "unavailable" | "cancelled";
  summary: string;
  limitations: string[];
  coverage: ProgrammaticAssessmentCoverage[];
  /** Bounded summaries of host-validated advisory evidence. Detailed evidence and
   * recommendations retain their existing advisory schemas in the transcript.
   * Receipt references are display attribution, not proof of delivery/authority. */
  observations: { basis: "observed" | "inferred"; message: string; evidenceSources: string[] }[];
  deterministic: ProgrammaticAssessmentDeterministicOutcome;
  /** Separate from assessment/scanner success; omitted by legacy hosts. */
  history?: RecommendationSaveStatus;
  /** Absence means legacy/unavailable candidate detail, not an empty scoped result. */
  discovery?: DiscoveryProjection;
}

/** Host-owned display lifecycle. Sequence increases within a session; neither
 * event phase conveys proposal ownership or approval authority. */
export type ProgrammaticAssessmentEvent = ProgrammaticAssessmentIdentity &
  ({ phase: "started" } | { phase: "completed"; assessment: ProgrammaticAssessment });

export function isProgrammaticAssessmentEvent(value: unknown): value is ProgrammaticAssessmentEvent {
  const optional = { requestId: isProgrammaticAssessmentRequestId };
  if (object(value, { ...identityFields, phase: oneOf("started") }, optional)) return true;
  if (!object(value, { ...identityFields, phase: oneOf("completed"), assessment: isProgrammaticAssessment }, optional)) return false;
  const event = value as Extract<ProgrammaticAssessmentEvent, { phase: "completed" }>;
  const receipt = event.assessment.lifecycle;
  return !receipt || (receipt.sessionId === event.sessionId && receipt.conversationId === event.conversationId &&
    receipt.sequence === event.sequence && receipt.requestId === event.requestId);
}

type Guard = (value: unknown) => boolean;
const oneOf = (...values: unknown[]): Guard => (value) => values.includes(value);
const text = (max: number): Guard => (value) =>
  typeof value === "string" && value.length <= max && isValidProgrammaticFocus(value);
const count: Guard = (value) => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 64;
const list = (guard: Guard, max = PROGRAMMATIC_ASSESSMENT_ITEM_LIMIT): Guard => (value) =>
  Array.isArray(value) && value.length <= max && value.every(guard);
function object(value: unknown, fields: Record<string, Guard>, optional: Record<string, Guard> = {}): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).every((key) => Object.hasOwn(fields, key) || Object.hasOwn(optional, key)) &&
    Object.entries(fields).every(([key, guard]) => Object.hasOwn(record, key) && guard(record[key])) &&
    Object.entries(optional).every(([key, guard]) => !Object.hasOwn(record, key) || guard(record[key]));
}
const deterministic: Guard = (value) => {
  if (!value || typeof value !== "object") return false;
  switch ((value as { status?: unknown }).status) {
    case "not-run": return object(value, { status: oneOf("not-run"), reason: oneOf("setup") });
    case "succeeded": {
      if (!object(value, { status: oneOf("succeeded"), enabledCount: count, applicableCount: count })) return false;
      const result = value as { enabledCount: number; applicableCount: number };
      return result.applicableCount <= result.enabledCount;
    }
    default: return object(value, {
      status: oneOf("unavailable", "denied", "cancelled", "failed"), reason: text(PROGRAMMATIC_ASSESSMENT_TEXT_LIMIT),
    });
  }
};

/** Strict bounded browser boundary. Does not establish provenance or authorize saving. */
export function isProgrammaticAssessment(value: unknown): value is ProgrammaticAssessment {
  if (!object(value, {
    version: oneOf(PROGRAMMATIC_ASSESSMENT_VERSION), mode: oneOf("setup", "configured"),
    status: oneOf("completed", "incomplete", "unavailable", "cancelled"),
    summary: text(PROGRAMMATIC_ASSESSMENT_TEXT_LIMIT),
    limitations: list(text(PROGRAMMATIC_ASSESSMENT_TEXT_LIMIT)),
    coverage: list((item) => object(item, {
      scope: oneOf("project", "catalog"),
      status: oneOf("inspected", "uninspected", "budget-limited", "unreadable", "unsafe", "nonmatching", "not-applicable"),
      summary: text(PROGRAMMATIC_ASSESSMENT_TEXT_LIMIT),
    })),
    observations: list((item) => object(item, {
      basis: oneOf("observed", "inferred"), message: text(PROGRAMMATIC_ASSESSMENT_TEXT_LIMIT),
      evidenceSources: (sources) => list(text(100))(sources) && (sources as string[]).length > 0 &&
        new Set(sources as string[]).size === (sources as string[]).length,
    })),
    deterministic,
  }, { lifecycle: isProgrammaticAssessmentIdentity, focus: (focus) => typeof focus === "string" && isValidProgrammaticFocus(focus), history: isRecommendationSaveStatus, discovery: isDiscoveryProjection })) return false;
  const assessment = value as ProgrammaticAssessment;
  return (assessment.mode === "setup") === (assessment.deterministic.status === "not-run");
}
