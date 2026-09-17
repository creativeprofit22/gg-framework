import { randomUUID } from "node:crypto";
import { projectHistoricalDiscovery } from "./discovery-projection.js";
import { z } from "zod";
import { stableJson, sha256 } from "../tauri-package/paths.js";
import type { ProgrammaticAssessment } from "@kenkaiiii/gg-core/programmatic-assessment-contract";
import type { RecommendationSummary, RecommendationDetail } from "@kenkaiiii/gg-core/programmatic-recommendation-contract";
import { deliveredExternalReceipt, type AdvisoryReceipt } from "./advisory.js";
import type { programmaticAssessmentResultV2Schema, programmaticCommandAvailabilityV1Schema } from "./contracts.js";
import {
  recommendationAssessmentV1Schema, recommendationObservationV1Schema, recommendationHistoryV1Schema,
  recommendationDecisionV1Schema, recommendationCorrespondenceV1Schema, recommendationEvidenceV1Schema,
  type RecommendationCandidateV1, type RecommendationHistoryV1, type RecommendationObservationV1,
} from "./recommendation-contracts.js";

// Validate draft fields here; full record refinements run after host IDs are attached below.
const assessmentInput = z.strictObject(recommendationAssessmentV1Schema.shape).omit({ observationIds: true });
const observationInput = z.strictObject(recommendationObservationV1Schema.shape).omit({ id: true, assessmentId: true, candidateId: true });
const capturedInput = z.strictObject({ assessment: assessmentInput, observations: z.array(observationInput).max(10) });
export type CapturedRecommendationAssessment = z.infer<typeof capturedInput>;

/** Projection, not receipt transfer. No raw output, command bodies or reusable authority. */
export function captureRecommendationAssessment(host: { id: string; startedAt: string },
  display: ProgrammaticAssessment, accepted: z.infer<typeof programmaticAssessmentResultV2Schema> | undefined,
  receipts: AdvisoryReceipt[], finishedAt = new Date().toISOString()): CapturedRecommendationAssessment {
  const deliveredLocal = receipts.filter((receipt) => !receipt.external && (receipt.location || receipt.locations?.length) && receipt.status === "retrieved").length;
  const deliveredCatalog = receipts.filter((receipt) => receipt.tool === "command_information" && receipt.status === "retrieved").length;
  const failed = receipts.filter((receipt) => receipt.status === "failed" || receipt.status === "cancelled").length;
  const input: CapturedRecommendationAssessment = {
    assessment: { version: 1, ...host, finishedAt, mode: display.mode, focus: display.focus,
      outcome: display.status, reportedCoverage: accepted?.coverage,
      hostCoverage: [
        { scope: "project", status: deliveredLocal ? "inspected" : "uninspected",
          summary: `${deliveredLocal} delivered local receipts; ${failed} failed/cancelled retrievals. Delivery does not establish complete project coverage or semantic support.` },
        { scope: "catalog", status: deliveredCatalog ? "inspected" : "uninspected",
          summary: `${deliveredCatalog} delivered command-information receipts. This does not establish complete catalog coverage.` },
      ],
    }, observations: [],
  };
  const reference = (availability: z.infer<typeof programmaticCommandAvailabilityV1Schema>) => availability.status === "available"
    ? { kind: "command" as const, command: availability.snapshot.command, reportedAvailability: availability.status,
      snapshotSha256: sha256(stableJson(availability.snapshot)) }
    : { kind: "command" as const, command: availability.command, reportedAvailability: availability.status, unavailableReason: availability.reason };
  if (accepted && display.status === "completed") for (const item of accepted.recommendations) {
    const choice = item.choice.kind === "reuse-command" ? { kind: item.choice.kind, reference: reference(item.choice.availability) }
      : item.choice.kind === "extend-command" ? { kind: item.choice.kind, reference: reference(item.choice.availability),
        proposedChanges: item.choice.proposedChanges, requirement: item.choice.requirement } : item.choice;
    const evidence = item.evidence.items.map((evidence) => {
      const external = "kind" in evidence;
      const receipt = external
        ? evidence.basis === "assumed" ? undefined : deliveredExternalReceipt(receipts, evidence)
        : receipts.find((receipt) => receipt.id === evidence.source);
      let attribution: z.infer<typeof recommendationEvidenceV1Schema>["external"];
      const sourceUri = external ? evidence.inspectedUrl : receipt?.external?.sourceUri;
      if (sourceUri) {
        try { const url = new URL(sourceUri); url.username = ""; url.password = ""; url.search = ""; url.hash = "";
          const revision = receipt?.external?.revision ?? (external ? evidence.revision : undefined);
          attribution = { url: url.href, ...(revision ? { revision } : {}),
            ...(external && evidence.location ? { location: evidence.location } : {}) }; } catch { /* No durable URL for this citation. */ }
      }
      const metadata = { basis: evidence.basis, summary: Array.from(external ? evidence.claim : evidence.message).map((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char).join("").trim(),
        retrievedAt: receipt?.retrievedAt, status: receipt?.status === "retrieved" ? "delivered" : receipt?.status ?? "lead",
        freshness: "not-revalidated", ...(!external && evidence.location ? { location: evidence.location } : {}),
        ...(attribution ? { external: attribution } : {}),
      };
      return recommendationEvidenceV1Schema.parse(metadata);
    });
    input.observations.push({ version: 1, workflow: item.workflow, outcome: item.outcome, rationale: item.rationale,
      uncertainty: item.uncertainty, choice, alternatives: item.alternatives.map((alternative) => ({
        kind: alternative.kind, reasonNotSelected: alternative.reasonNotSelected,
        ...(alternative.availability ? { reference: reference(alternative.availability) } : {}),
      })), evidence });
  }
  return capturedInput.parse(input);
}

export function emptyRecommendationHistory(): RecommendationHistoryV1 {
  return { version: 1, revision: 0, candidates: [], assessments: [], observations: [], decisions: [], correspondences: [] };
}
/** Entire validated structured workflow, exact and case-sensitive; no semantic equivalence. */
function workflowKey(workflow: RecommendationObservationV1["workflow"]): string { return stableJson(workflow); }
function draft(observation: RecommendationObservationV1): CapturedRecommendationAssessment["observations"][number] {
  const { id: _id, candidateId: _candidateId, assessmentId: _assessmentId, ...content } = observation;
  return content;
}
function canonicalCandidates(history: RecommendationHistoryV1): RecommendationCandidateV1[] {
  const retained = new Set(history.correspondences.map((event) => event.retainedId));
  return history.candidates.filter((candidate) => !retained.has(candidate.id));
}

/** No I/O. Only host-captured inputs enter here; every returned document is revalidated. */
export function reconcileRecommendations(
  previous: RecommendationHistoryV1,
  captured: CapturedRecommendationAssessment,
  uuid: () => string = randomUUID,
): { history: RecommendationHistoryV1; changed: boolean } {
  const history = recommendationHistoryV1Schema.parse(previous);
  const input = capturedInput.parse(captured);
  if (input.assessment.outcome !== "completed" && input.observations.length)
    throw new Error("Incomplete assessments cannot promote observations.");
  const existing = history.assessments.find((assessment) => assessment.id === input.assessment.id);
  if (existing) {
    const { observationIds, ...assessment } = existing;
    const observations = observationIds.map((id) => draft(history.observations.find((observation) => observation.id === id)!));
    if (stableJson({ assessment, observations }) !== stableJson(input)) throw new Error("Assessment ID reused with different captured content.");
    return { history, changed: false };
  }
  const observationsById = new Map(history.observations.map((observation) => [observation.id, observation]));
  const saved = new Map<string, RecommendationCandidateV1[]>();
  for (const candidate of canonicalCandidates(history)) {
    // All explicitly confirmed workflow spellings remain replayable on the canonical candidate.
    const keys = new Set(candidate.observationIds.map((id) => workflowKey(observationsById.get(id)!.workflow)));
    for (const key of keys) saved.set(key, [...(saved.get(key) ?? []), candidate]);
  }
  const counts = new Map<string, number>();
  for (const observation of input.observations) {
    const key = workflowKey(observation.workflow);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const candidateMatchCounts = new Map<string, number>();
  for (const content of input.observations) for (const match of saved.get(workflowKey(content.workflow)) ?? [])
    candidateMatchCounts.set(match.id, (candidateMatchCounts.get(match.id) ?? 0) + 1);
  const assessment = recommendationAssessmentV1Schema.parse({ ...input.assessment, observationIds: [] });
  const touchedAmbiguity = new Set<string>();
  for (const content of input.observations) {
    const key = workflowKey(content.workflow), matches = saved.get(key) ?? [];
    const ambiguous = counts.get(key)! > 1 || matches.length > 1 || matches.some((match) => candidateMatchCounts.get(match.id)! > 1);
    let candidate = !ambiguous && matches.length === 1 ? matches[0] : undefined;
    if (ambiguous) for (const match of matches) {
      if (match.ambiguity !== "exact-workflow-duplicate" && !touchedAmbiguity.has(match.id)) {
        match.ambiguity = "exact-workflow-duplicate"; match.revision++; touchedAmbiguity.add(match.id);
      }
    }
    if (!candidate) {
      candidate = { version: 1, id: uuid(), revision: 1, firstAssessmentId: assessment.id, lastAssessmentId: assessment.id,
        observationIds: [], decisionIds: [], correspondenceIds: [], ambiguity: ambiguous ? "exact-workflow-duplicate" : "none" };
      history.candidates.push(candidate);
    } else { candidate.revision++; candidate.lastAssessmentId = assessment.id; }
    const observation = recommendationObservationV1Schema.parse({ ...content, id: uuid(), assessmentId: assessment.id, candidateId: candidate.id });
    candidate.observationIds.push(observation.id); assessment.observationIds.push(observation.id); history.observations.push(observation);
  }
  history.assessments.push(assessment); history.revision++;
  history.candidates.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { history: recommendationHistoryV1Schema.parse(history), changed: true };
}

function reviewedCandidate(history: RecommendationHistoryV1, id: string, expectedRevision: number): RecommendationCandidateV1 {
  const candidate = history.candidates.find((entry) => entry.id === id);
  if (!candidate || candidate.revision !== expectedRevision) throw new Error("Candidate changed; inspect again.");
  if (history.correspondences.some((event) => event.retainedId === id)) throw new Error("Inspect the canonical candidate instead.");
  return candidate;
}
export function recommendationSummary(history: RecommendationHistoryV1, candidate: RecommendationCandidateV1): RecommendationSummary {
  const latest = history.observations.find((observation) => observation.id === candidate.observationIds.at(-1))!;
  const canonicalId = history.correspondences.find((event) => event.retainedId === candidate.id)?.canonicalId;
  return { id: candidate.id, revision: candidate.revision, outcome: latest.outcome,
    decision: latestDecision(history, candidate)?.decision ?? "open", ambiguity: candidate.ambiguity,
    observationCount: candidate.observationIds.length, ...(canonicalId ? { canonicalId } : {}) };
}
export function recommendationDetail(history: RecommendationHistoryV1, candidateId: string, offset: number): RecommendationDetail | null {
  const candidate = history.candidates.find((candidate) => candidate.id === candidateId);
  if (!candidate) return null;
  const observationIds = new Set(candidate.observationIds), decisionIds = new Set(candidate.decisionIds), correspondenceIds = new Set(candidate.correspondenceIds);
  const observations = history.observations.filter((observation) => observationIds.has(observation.id));
  const assessmentIds = new Set(observations.map((observation) => observation.assessmentId));
  const records = [
    ...observations.map((record) => ({ record, kind: "observation" as const })),
    ...history.assessments.filter((record) => assessmentIds.has(record.id)).map((record) => ({ record, kind: "assessment" as const })),
    ...history.decisions.filter((record) => decisionIds.has(record.id)).map((record) => ({ record, kind: "decision" as const })),
    ...history.correspondences.filter((record) => correspondenceIds.has(record.id)).map((record) => ({ record, kind: "correspondence" as const })),
  ];
  const start = Math.min(offset, records.length);
  const latest = observations.find((observation) => observation.id === candidate.observationIds.at(-1));
  const discovery = latest && projectHistoricalDiscovery(latest, candidate.revision);
  return { version: 1, historyRevision: history.revision, candidate: recommendationSummary(history, candidate),
    ...(discovery ? { discovery } : {}),
    offset: start, total: records.length, records: records.slice(start, start + 1).map(({ record, kind }) => ({ id: record.id, kind, displayJson: JSON.stringify(record) })) };
}

function latestDecision(history: RecommendationHistoryV1, candidate: RecommendationCandidateV1) {
  const last = candidate.decisionIds.at(-1);
  return last ? history.decisions.find((decision) => decision.id === last)! : undefined;
}
/** Called only after host review; this function does not manufacture review authorization. */
export function decideRecommendation(previous: RecommendationHistoryV1, request: {
  candidateId: string; expectedRevision: number; decision: "open" | "dismissed" | "completed";
  verificationResultId?: string;
}, at: string, uuid: () => string = randomUUID): RecommendationHistoryV1 {
  const history = recommendationHistoryV1Schema.parse(previous);
  const candidate = reviewedCandidate(history, request.candidateId, request.expectedRevision);
  const event = recommendationDecisionV1Schema.parse({ version: 1, id: uuid(), candidateId: candidate.id, at,
    decision: request.decision, actor: "user", source: "host-review",
    ...(request.decision === "completed" ? { completion: request.verificationResultId ? "verification-referenced" : "user-declared" } : {}),
    ...(request.verificationResultId ? { reference: { kind: "execution-result", resultId: request.verificationResultId } } : {}),
  });
  candidate.decisionIds.push(event.id); candidate.revision++; history.revision++; history.decisions.push(event);
  return recommendationHistoryV1Schema.parse(history);
}

/** Retain both records and immutable observation origins. Never transfer execution approvals. */
export function confirmRecommendationCorrespondence(previous: RecommendationHistoryV1, request: {
  canonicalId: string; canonicalRevision: number; retainedId: string; retainedRevision: number;
}, at: string, uuid: () => string = randomUUID): RecommendationHistoryV1 {
  const history = recommendationHistoryV1Schema.parse(previous);
  const canonical = reviewedCandidate(history, request.canonicalId, request.canonicalRevision);
  const retained = reviewedCandidate(history, request.retainedId, request.retainedRevision);
  if (canonical.id === retained.id) throw new Error("Correspondence requires two distinct inspected candidates.");
  if (history.correspondences.some((event) => event.canonicalId === retained.id)) throw new Error("Correspondence chains require separate review; retain the existing canonical record.");
  const earlier = history.assessments.findIndex((assessment) => assessment.id === canonical.firstAssessmentId);
  const later = history.assessments.findIndex((assessment) => assessment.id === retained.firstAssessmentId);
  if (earlier > later) throw new Error("The earlier candidate must remain canonical.");
  const left = latestDecision(history, canonical), right = latestDecision(history, retained);
  // An untouched later candidate does not conflict with an earlier explicit decision.
  if (right && (!left || left.decision !== right.decision || left.completion !== right.completion || stableJson(left.reference ?? null) !== stableJson(right.reference ?? null)))
    throw new Error("Conflicting decisions; candidates remain distinct.");
  const event = recommendationCorrespondenceV1Schema.parse({ version: 1, id: uuid(), at, actor: "user", source: "host-review",
    canonicalId: canonical.id, retainedId: retained.id, canonicalRevision: canonical.revision, retainedRevision: retained.revision,
    observationIds: [...retained.observationIds] });
  for (const observationId of retained.observationIds) if (!canonical.observationIds.includes(observationId)) canonical.observationIds.push(observationId);
  // Preserve chronology even if correspondence is reviewed after newer canonical observations.
  const order = new Map(history.observations.map((observation, index) => [observation.id, index]));
  canonical.observationIds.sort((a, b) => order.get(a)! - order.get(b)!);
  canonical.lastAssessmentId = history.observations.find((o) => o.id === canonical.observationIds.at(-1))!.assessmentId;
  canonical.correspondenceIds.push(event.id); retained.correspondenceIds.push(event.id);
  canonical.revision++; retained.revision++; history.revision++; history.correspondences.push(event);
  return recommendationHistoryV1Schema.parse(history);
}
