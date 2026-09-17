import { randomUUID } from "node:crypto";
import { isDiscoveryCandidate, isDiscoveryProjection, type DiscoveryCandidate, type DiscoveryProjection } from "@kenkaiiii/gg-core/programmatic-recommendation-contract";
import type { z } from "zod";
import type { programmaticAssessmentResultV2Schema } from "./contracts.js";
import type { RecommendationObservationV1 } from "./recommendation-contracts.js";

type Accepted = z.infer<typeof programmaticAssessmentResultV2Schema>;
export interface DiscoveryRecord {
  display: DiscoveryCandidate;
  /** Accepted domain data stays in the backend; never include this in events. */
  recommendation: Accepted["recommendations"][number];
}
const unavailable = { available: false, reason: "Historical evidence requires a fresh scoped inspection; prior receipts and approvals are not restored." };

function sharedDetails(value: DiscoveryRecord["recommendation"] | RecommendationObservationV1) {
  const { outcome, rationale, uncertainty, choice, alternatives } = value;
  const { affectedSubproject, ...workflow } = value.workflow;
  return { outcome, rationale, uncertainty, choice: choice.kind,
    workflow: { ...workflow, scope: affectedSubproject.scope === "repository-wide" ? "Repository-wide" : affectedSubproject.path },
    alternatives: alternatives.map((option) => ({ kind: option.kind, reasonNotSelected: option.reasonNotSelected,
      ...(("availability" in option && option.availability) || ("reference" in option && option.reference)
        ? { availability: commandAvailability(option) } : {}) })) };
}

type CommandChoice = Extract<Accepted["recommendations"][number]["choice"], { kind: "reuse-command" }>;
type HistoricalCommand = Extract<RecommendationObservationV1["choice"], { kind: "reuse-command" }>;
function commandAvailability(value: { availability?: CommandChoice["availability"]; reference?: HistoricalCommand["reference"] }): DiscoveryCandidate["availability"] {
  if (value.availability) return value.availability.status === "available"
    ? { status: "available", reason: "Command was available at assessment submission; execution requires separate review and approval." }
    : { status: "unavailable", reason: value.availability.reason };
  if (value.reference) return value.reference.reportedAvailability === "unavailable" && value.reference.unavailableReason
    ? { status: "unavailable", reason: value.reference.unavailableReason }
    : { status: "reinspection-required", reason: "Historical command availability has not been revalidated. Fresh read-only inspection is required." };
  return undefined;
}
function details(choice: DiscoveryRecord["recommendation"]["choice"] | RecommendationObservationV1["choice"]): Pick<DiscoveryCandidate, "details" | "risks" | "nextStep" | "availability"> {
  switch (choice.kind) {
    case "manual": return { details: choice.steps, risks: [], nextStep: { available: false, reason: "Manual steps only; no execution action is offered." } };
    case "needs-more-evidence": return { details: [...choice.missingEvidence, ...choice.nextInspectionSteps].slice(0, 64), risks: [],
      nextStep: { available: true, reason: "Request scoped read-only inspection under current permissions." } };
    case "missing-capability": return { details: [choice.proposal.desiredOutcome, ...choice.proposal.inputs, ...choice.proposal.outputs,
      ...choice.proposal.prerequisites, ...choice.proposal.verificationExpectations].slice(0, 64), risks: choice.proposal.risks,
      nextStep: choice.proposal.capabilityKind === "app-backed"
        ? { available: false, reason: "Requires application development; a prompt cannot provide this native capability." }
        : { available: true, reason: "Prepare an inspect-only proposal. Creation, verification and execution require separate review and approval." } };
    case "reuse-command":
    case "extend-command": {
      const availability = "availability" in choice ? choice.availability : undefined;
      const reference = availability?.status === "available" ? availability.snapshot.command
        : availability?.status === "unavailable" ? availability.command : "reference" in choice ? choice.reference.command : undefined;
      const command = reference ? `${reference.source}: /${reference.name}` : "Command requires fresh inspection";
      const appBacked = availability?.status === "available" && availability.snapshot.capabilityKind === "app-backed";
      return { availability: commandAvailability(choice), details: [command, ...(choice.kind === "extend-command" ? choice.proposedChanges : [])],
        risks: choice.kind === "extend-command" ? choice.requirement.risks : [],
        nextStep: appBacked ? { available: false, reason: "Application-backed capability requires supported native integration; this proposal cannot execute it." }
          : availability?.status !== "available" ? { available: true, reason: "Request scoped read-only reinspection of the command and project evidence; no execution is authorized." }
          : { available: true, reason: choice.kind === "reuse-command" ? "Review the current canonical command and scope; execution remains separately approved."
            : "Review the base command and proposed changes; opening review does not edit or overwrite it." } };
    }
  }
}
/** Called only for accepted V2 results. No scanner or model-prose fallback. */
export function projectDiscovery(assessmentId: string, accepted: Accepted): { projection: DiscoveryProjection; records: DiscoveryRecord[] } {
  const records = accepted.recommendations.map((recommendation): DiscoveryRecord => ({ recommendation: structuredClone(recommendation), display: {
    assessmentId, candidateId: randomUUID(), revision: 1, ...sharedDetails(recommendation),
    evidence: recommendation.evidence.items.map((item) => ({ basis: item.basis,
      message: "kind" in item ? item.claim : item.message, source: "kind" in item ? item.inspectedUrl : item.source })),
    ...details(recommendation.choice),
  } }));
  const projection = { assessmentId, candidates: records.map(({ display }) => display) };
  if (!isDiscoveryProjection(projection)) throw new Error("Discovery projection exceeds the display boundary.");
  return { projection, records };
}
/** Typed inert history display; no raw JSON parsing by the browser, no receipt recovery. */
export function projectHistoricalDiscovery(observation: RecommendationObservationV1, revision: number): DiscoveryCandidate | undefined {
  const candidate: DiscoveryCandidate = {
    assessmentId: observation.assessmentId, candidateId: observation.candidateId, revision, ...sharedDetails(observation),
    evidence: observation.evidence.map((item) => ({ basis: item.basis, message: item.summary,
      source: item.external?.url ?? item.location?.path ?? "Historical inspection" })),
    ...details(observation.choice), nextStep: unavailable,
  };
  return isDiscoveryCandidate(candidate) ? candidate : undefined;
}
