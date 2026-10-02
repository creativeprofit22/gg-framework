import { z } from "zod";
import {
  programmaticAssessmentResultV2Schema,
  programmaticAssessmentInputV1Schema,
  programmaticCommandReferenceV1Schema,
  programmaticRecommendationV2Schema,
  programmaticWorkflowV2Schema,
} from "./contracts.js";

/** Independent of detector keys, scanner presence, receipts and execution authority. */
export const RECOMMENDATION_LIMITS = { candidates: 1_000, assessments: 4_096, events: 16_384, bytes: 16 * 1024 * 1024 } as const;
const id = z.string().uuid();
const revision = z.number().int().nonnegative().refine(Number.isSafeInteger);
const text = z.string().min(1).max(4_000).refine((value) =>
  [...value].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127));
const time = z.string().datetime();
const digest = z.string().length(64).regex(/^[a-f0-9]+$/);
const ids = z.array(id).max(RECOMMENDATION_LIMITS.events).refine((values) => new Set(values).size === values.length);
const location = z.strictObject({
  path: programmaticWorkflowV2Schema.shape.affectedSubproject.options[1].shape.path,
  startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional(),
}).refine((value) => value.endLine === undefined || (value.startLine !== undefined && value.endLine >= value.startLine));
const externalUrl = z.string().min(1).max(4_000).refine((value) => {
  try {
    const url = new URL(value);
    return /^https?:\/\//.test(value) && !/[\s\\]/.test(value) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
});

/** Historical attribution only: deliberately not a snapshot/envelope accepted by an executor. */
export const recommendationReferenceV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("command"), command: programmaticCommandReferenceV1Schema, snapshotSha256: digest.optional(),
    reportedAvailability: z.enum(["available", "unavailable"]).optional(), unavailableReason: text.optional() }),
  z.strictObject({ kind: z.literal("creation-review"), resultId: id }),
  z.strictObject({ kind: z.literal("execution-result"), resultId: id }),
]);
export const recommendationEvidenceV1Schema = z.strictObject({
  basis: z.enum(["observed", "inferred", "assumed"]), summary: text,
  retrievedAt: time.optional(), status: z.enum(["delivered", "lead", "failed", "cancelled"]),
  freshness: z.literal("not-revalidated"),
  location: location.optional(),
  external: z.strictObject({ url: externalUrl, revision: z.string().min(1).max(100).optional(), location: location.optional() }).optional(),
  snapshotSha256: digest.optional(),
});
const choiceKind = z.enum(["reuse-command", "extend-command", "missing-capability", "manual", "needs-more-evidence"]);
const source = programmaticRecommendationV2Schema.shape;
const choices = source.choice.options;
// Reuse validated advisory descriptions, but project current availability into inert references.
const choice = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("reuse-command"), reference: recommendationReferenceV1Schema.options[0] }),
  z.strictObject({ kind: z.literal("extend-command"), reference: recommendationReferenceV1Schema.options[0],
    proposedChanges: choices[1].shape.proposedChanges, requirement: choices[1].shape.requirement }),
  choices[2], choices[3], choices[4],
]);
export const recommendationObservationV1Schema = z.strictObject({
  version: z.literal(1), id, assessmentId: id, candidateId: id,
  workflow: programmaticWorkflowV2Schema, outcome: source.outcome, rationale: source.rationale,
  uncertainty: source.uncertainty, choice,
  alternatives: z.array(z.strictObject({ kind: choiceKind, reasonNotSelected: source.outcome,
    reference: recommendationReferenceV1Schema.options[0].optional() })).max(4),
  evidence: z.array(recommendationEvidenceV1Schema).max(50),
}).refine((value) => {
  const positive = ["reuse-command", "extend-command", "missing-capability"].includes(value.choice.kind);
  return (!positive || (value.alternatives.length > 0 && value.workflow.repeatability.basis !== "assumed")) &&
    value.alternatives.every((option) => option.kind !== value.choice.kind) &&
    new Set(value.alternatives.map((option) => option.kind)).size === value.alternatives.length &&
    JSON.stringify(value).length <= 64_000;
}, "invalid or over-budget historical observation");
export const recommendationAssessmentV1Schema = z.strictObject({
  version: z.literal(1), id, startedAt: time, finishedAt: time,
  mode: z.enum(["setup", "configured"]), focus: programmaticAssessmentInputV1Schema.shape.focus,
  outcome: z.enum(["completed", "incomplete", "cancelled", "unavailable"]),
  reportedCoverage: programmaticAssessmentResultV2Schema.shape.coverage.optional(),
  hostCoverage: z.array(z.strictObject({ scope: z.enum(["project", "catalog"]),
    status: z.enum(["inspected", "uninspected", "budget-limited", "unreadable", "unsafe", "nonmatching", "not-applicable"]), summary: text })).max(50),
  configurationSha256: digest.optional(), catalogSha256: digest.optional(),
  observationIds: ids,
}).refine((value) => value.finishedAt >= value.startedAt &&
  (value.outcome === "completed" || value.observationIds.length === 0), "incomplete assessments cannot promote observations");
export const recommendationDecisionV1Schema = z.strictObject({
  version: z.literal(1), id, candidateId: id, at: time,
  decision: z.enum(["open", "dismissed", "completed"]),
  actor: z.literal("user"), source: z.literal("host-review"),
  completion: z.enum(["user-declared", "verification-referenced"]).optional(),
  reference: recommendationReferenceV1Schema.options[2].optional(),
}).refine((value) => value.decision === "completed"
  ? value.completion !== undefined && (value.completion === "verification-referenced") === (value.reference !== undefined)
  : value.completion === undefined && value.reference === undefined, "completion provenance must be explicit");
export const recommendationCorrespondenceV1Schema = z.strictObject({
  version: z.literal(1), id, at: time, actor: z.literal("user"), source: z.literal("host-review"),
  canonicalId: id, retainedId: id, canonicalRevision: revision, retainedRevision: revision,
  observationIds: ids,
}).refine((value) => value.canonicalId !== value.retainedId);
export const recommendationCandidateV1Schema = z.strictObject({
  version: z.literal(1), id, revision: revision.refine((value) => value > 0),
  firstAssessmentId: id, lastAssessmentId: id,
  observationIds: ids.refine((values) => values.length > 0), decisionIds: ids, correspondenceIds: ids,
  ambiguity: z.enum(["none", "exact-workflow-duplicate"]),
});
export const recommendationHistoryV1Schema = z.strictObject({
  version: z.literal(1), revision,
  candidates: z.array(recommendationCandidateV1Schema).max(RECOMMENDATION_LIMITS.candidates),
  assessments: z.array(recommendationAssessmentV1Schema).max(RECOMMENDATION_LIMITS.assessments),
  observations: z.array(recommendationObservationV1Schema).max(RECOMMENDATION_LIMITS.events),
  decisions: z.array(recommendationDecisionV1Schema).max(RECOMMENDATION_LIMITS.events),
  correspondences: z.array(recommendationCorrespondenceV1Schema).max(RECOMMENDATION_LIMITS.events),
}).superRefine((value, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: "custom", message });
  if (value.observations.length + value.decisions.length + value.correspondences.length > RECOMMENDATION_LIMITS.events)
    invalid("history event capacity exceeded");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > RECOMMENDATION_LIMITS.bytes) invalid("history byte capacity exceeded");
  const all = [...value.candidates, ...value.assessments, ...value.observations, ...value.decisions, ...value.correspondences];
  if (new Set(all.map((record) => record.id)).size !== all.length) invalid("duplicate record ID");
  if (value.candidates.some((candidate, index) => index > 0 && value.candidates[index - 1]!.id >= candidate.id)) invalid("candidate IDs must be sorted");
  const candidates = new Map(value.candidates.map((record) => [record.id, record]));
  const assessments = new Map(value.assessments.map((record) => [record.id, record]));
  const observations = new Map(value.observations.map((record) => [record.id, record]));
  const decisions = new Map(value.decisions.map((record) => [record.id, record]));
  const correspondences = new Map(value.correspondences.map((record) => [record.id, record]));
  const observationOrder = new Map(value.observations.map((record, index) => [record.id, index]));
  const decisionOrder = new Map(value.decisions.map((record, index) => [record.id, index]));
  const ordered = (ids: string[], order: Map<string, number>) => ids.every((id, index) => order.has(id) &&
    (index === 0 || order.get(ids[index - 1]!)! < order.get(id)!));
  for (const candidate of value.candidates) {
    if (!assessments.has(candidate.firstAssessmentId) || !assessments.has(candidate.lastAssessmentId)) invalid("dangling candidate assessment");
    if (!ordered(candidate.observationIds, observationOrder) || !ordered(candidate.decisionIds, decisionOrder) ||
      observations.get(candidate.observationIds[0]!)?.assessmentId !== candidate.firstAssessmentId ||
      observations.get(candidate.observationIds.at(-1)!)?.assessmentId !== candidate.lastAssessmentId)
      invalid("candidate observation/decision chronology mismatch");
    for (const observationId of candidate.observationIds) {
      const observation = observations.get(observationId);
      if (!observation || (observation.candidateId !== candidate.id && !candidate.correspondenceIds.some((linkId) => {
        const link = correspondences.get(linkId);
        return link?.canonicalId === candidate.id && link.retainedId === observation.candidateId && link.observationIds.includes(observationId);
      }))) invalid("dangling or unconfirmed candidate observation");
    }
    const first = observations.get(candidate.observationIds[0]!);
    const last = observations.get(candidate.observationIds.at(-1)!);
    if (first?.assessmentId !== candidate.firstAssessmentId || last?.assessmentId !== candidate.lastAssessmentId) invalid("candidate assessment endpoints disagree");
    if (candidate.decisionIds.some((decisionId) => decisions.get(decisionId)?.candidateId !== candidate.id)) invalid("dangling candidate decision");
    if (candidate.correspondenceIds.some((linkId) => {
      const link = correspondences.get(linkId);
      return !link || (link.canonicalId !== candidate.id && link.retainedId !== candidate.id);
    })) invalid("dangling candidate correspondence");
  }
  for (const assessment of value.assessments)
    if (assessment.observationIds.some((observationId) => observations.get(observationId)?.assessmentId !== assessment.id)) invalid("dangling assessment observation");
  for (const observation of value.observations)
    if (!candidates.get(observation.candidateId)?.observationIds.includes(observation.id) ||
      !assessments.get(observation.assessmentId)?.observationIds.includes(observation.id)) invalid("orphan observation");
  for (const decision of value.decisions)
    if (!candidates.get(decision.candidateId)?.decisionIds.includes(decision.id)) invalid("orphan decision");
  const retained = new Set<string>();
  for (const link of value.correspondences) {
    const canonical = candidates.get(link.canonicalId), secondary = candidates.get(link.retainedId);
    if (!canonical?.correspondenceIds.includes(link.id) || !secondary?.correspondenceIds.includes(link.id) ||
      link.canonicalRevision >= (canonical?.revision ?? 0) || link.retainedRevision >= (secondary?.revision ?? 0) ||
      !link.observationIds.length || link.observationIds.length !== secondary?.observationIds.length ||
      link.observationIds.some((observationId) => observations.get(observationId)?.candidateId !== link.retainedId || !canonical.observationIds.includes(observationId)) ||
      retained.has(link.retainedId) || value.correspondences.some((other) => other.retainedId === link.canonicalId || other.canonicalId === link.retainedId)) invalid("invalid correspondence graph");
    retained.add(link.retainedId);
  }
});
export type RecommendationReferenceV1 = z.infer<typeof recommendationReferenceV1Schema>;
export type RecommendationObservationV1 = z.infer<typeof recommendationObservationV1Schema>;
export type RecommendationAssessmentV1 = z.infer<typeof recommendationAssessmentV1Schema>;
export type RecommendationDecisionV1 = z.infer<typeof recommendationDecisionV1Schema>;
export type RecommendationCandidateV1 = z.infer<typeof recommendationCandidateV1Schema>;
export type RecommendationHistoryV1 = z.infer<typeof recommendationHistoryV1Schema>;
