/** Host projection only. No command body, tool arguments, receipt or approval token. */
export type DiscoveryChoice = "reuse-command" | "extend-command" | "missing-capability" | "manual" | "needs-more-evidence";
/** Display evidence only; available never grants execution authority. */
export interface DiscoveryAvailability {
  status: "available" | "unavailable" | "reinspection-required";
  reason: string;
}
export interface DiscoveryCandidate {
  availability?: DiscoveryAvailability;
  assessmentId: string; candidateId: string; revision: number;
  choice: DiscoveryChoice;
  outcome: string; rationale: string; uncertainty: string;
  workflow: {
    trigger: string; representativeCase: string; inputs: string[]; currentProcess: string[];
    output: string; successCheck: string; scope: string; mutationBoundary: string;
    repeatability: { basis: "observed" | "inferred" | "assumed"; explanation: string };
  };
  evidence: { basis: "observed" | "inferred" | "assumed"; message: string; source: string }[];
  alternatives: { kind: DiscoveryChoice; reasonNotSelected: string; availability?: DiscoveryAvailability }[];
  risks: string[]; details: string[];
  nextStep: { available: boolean; reason: string };
}
export interface DiscoveryProjection { assessmentId: string; candidates: DiscoveryCandidate[] }
export type DiscoveryReviewRequest = {
  action: "review-candidate"; intent: "review-only"; source: "current" | "history";
  assessmentId: string; candidateId: string; expectedRevision: number;
};
export interface DiscoveryReview {
  status: "prepared" | "reinspection-required" | "unsupported";
  candidate: DiscoveryCandidate; summary: string;
}

type Guard = (value: unknown) => boolean;
const oneOf = (...values: unknown[]): Guard => (value) => values.includes(value);
const positive: Guard = (value) => Number.isSafeInteger(value) && (value as number) > 0;
const text: Guard = (value) => typeof value === "string" && value.length <= 4_000 && value.trim().length > 0 &&
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
const choice: Guard = oneOf("reuse-command", "extend-command", "missing-capability", "manual", "needs-more-evidence");
const availability: Guard = (value) => object(value, {
  status: oneOf("available", "unavailable", "reinspection-required"), reason: text,
});
const basis: Guard = oneOf("observed", "inferred", "assumed");
const list = (guard: Guard, max: number): Guard => (value) => Array.isArray(value) && value.length <= max && value.every(guard);
/** Bound the combined projection as well as each field. JSON here is display, never authority. */
export function isDiscoveryCandidate(value: unknown): value is DiscoveryCandidate {
  if (!object(value, {
    assessmentId: uuid, candidateId: uuid, revision: positive, choice,
    outcome: text, rationale: text, uncertainty: text,
    workflow: (workflow) => object(workflow, {
      trigger: text, representativeCase: text, inputs: list(text, 50), currentProcess: list(text, 50),
      output: text, successCheck: text, scope: text, mutationBoundary: text,
      repeatability: (repeatability) => object(repeatability, { basis, explanation: text }),
    }),
    evidence: list((item) => object(item, { basis, message: text, source: text }), 50),
    alternatives: list((item) => object(item, { kind: choice, reasonNotSelected: text }, { availability }), 4),
    risks: list(text, 50), details: list(text, 64),
    nextStep: (step) => object(step, { available: (flag) => typeof flag === "boolean", reason: text }),
  }, { availability })) return false;
  const candidate = value as DiscoveryCandidate;
  return JSON.stringify(candidate).length <= 64_000 &&
    (candidate.choice !== "manual" || !candidate.nextStep.available) &&
    candidate.alternatives.every((item) => item.kind !== candidate.choice) &&
    new Set(candidate.alternatives.map((item) => item.kind)).size === candidate.alternatives.length;
}
export function isDiscoveryProjection(value: unknown): value is DiscoveryProjection {
  if (!object(value, { assessmentId: uuid, candidates: list(isDiscoveryCandidate, 10) })) return false;
  const projection = value as DiscoveryProjection;
  return JSON.stringify(projection).length <= 72_000 &&
    projection.candidates.every((candidate) => candidate.assessmentId === projection.assessmentId) &&
    new Set(projection.candidates.map((candidate) => candidate.candidateId)).size === projection.candidates.length;
}
export function isDiscoveryReviewRequest(value: unknown): value is DiscoveryReviewRequest {
  return object(value, { action: oneOf("review-candidate"), intent: oneOf("review-only"), source: oneOf("current", "history"),
    assessmentId: uuid, candidateId: uuid, expectedRevision: positive });
}
export function isDiscoveryReview(value: unknown): value is DiscoveryReview {
  return object(value, { status: oneOf("prepared", "reinspection-required", "unsupported"), candidate: isDiscoveryCandidate, summary: text });
}
