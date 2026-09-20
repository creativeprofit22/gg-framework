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
const unavailable = { available: false, reason: "Check this saved suggestion again before using it. Earlier inspections and approvals cannot be reused." };

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
    ? { status: "available", reason: "The command was available when assessed. Review and approval are still needed before running it." }
    : { status: "unavailable", reason: value.availability.reason };
  if (value.reference) return value.reference.reportedAvailability === "unavailable" && value.reference.unavailableReason
    ? { status: "unavailable", reason: value.reference.unavailableReason }
    : { status: "reinspection-required", reason: "This saved command has not been checked again. Inspect it without making changes before using it." };
  return undefined;
}
/** Preserve every detail; the shared display guards reject over-budget candidates rather than truncating review input. */
function details(choice: DiscoveryRecord["recommendation"]["choice"] | RecommendationObservationV1["choice"]): Pick<DiscoveryCandidate, "details" | "risks" | "nextStep" | "availability"> {
  switch (choice.kind) {
    case "manual": return { details: choice.steps, risks: [], nextStep: { available: false, reason: "Follow the manual steps. There is no automatic run for this suggestion." } };
    case "needs-more-evidence": return { details: [...choice.missingEvidence, ...choice.nextInspectionSteps], risks: [],
      nextStep: { available: true, reason: "Inspect the missing evidence without making changes, using your current permissions." } };
    case "missing-capability": return { details: [choice.proposal.desiredOutcome, ...choice.proposal.prerequisites,
      ...choice.proposal.inputs, ...choice.proposal.outputs, ...choice.proposal.verificationExpectations], risks: choice.proposal.risks,
      nextStep: choice.proposal.capabilityKind === "app-backed"
        ? { available: false, reason: "Requires application development. A prompt alone cannot provide this functionality." }
        : { available: true, reason: "Review a proposal without making changes. Creating, checking and running it each need separate review and approval." } };
    case "reuse-command":
    case "extend-command": {
      const availability = "availability" in choice ? choice.availability : undefined;
      const reference = availability?.status === "available" ? availability.snapshot.command
        : availability?.status === "unavailable" ? availability.command : "reference" in choice ? choice.reference.command : undefined;
      const command = reference ? `${reference.source}: /${reference.name}` : "Command requires fresh inspection";
      const appBacked = availability?.status === "available" && availability.snapshot.capabilityKind === "app-backed";
      return { availability: commandAvailability(choice), details: [command, ...(choice.kind === "extend-command" ? [...choice.requirement.prerequisites, ...choice.proposedChanges] : [])],
        risks: choice.kind === "extend-command" ? choice.requirement.risks : [],
        nextStep: appBacked ? { available: false, reason: "Requires supported application integration. This proposal cannot run it." }
          : availability?.status !== "available" ? { available: true, reason: "Recheck the command and project prerequisites without making changes. Nothing is approved to run." }
          : { available: true, reason: choice.kind === "reuse-command" ? "Review the current command and scope. Running it requires separate approval."
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
