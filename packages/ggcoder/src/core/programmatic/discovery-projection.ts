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
function step(available: boolean, reason: string) { return { available, reason }; }
const unavailable = step(false, "Search again before using this past idea. Earlier reviews and approvals don't carry over.");

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
    ? { status: "available", reason: "The command was there when AI looked. You still review and approve it before it runs." }
    : { status: "unavailable", reason: value.availability.reason };
  if (value.reference) return value.reference.reportedAvailability === "unavailable" && value.reference.unavailableReason
    ? { status: "unavailable", reason: value.reference.unavailableReason }
    : { status: "reinspection-required", reason: "This command hasn't been checked since. Check it again before using it." };
  return undefined;
}
/** Display guards reject oversized candidates; never truncate review input. */
function details(choice: DiscoveryRecord["recommendation"]["choice"] | RecommendationObservationV1["choice"]): Pick<DiscoveryCandidate, "details" | "risks" | "nextStep" | "availability"> {
  switch (choice.kind) {
    case "manual": return { details: choice.steps, risks: [], nextStep: step(false, "Follow the steps by hand. This one doesn't run automatically.") };
    case "needs-more-evidence": return { details: [...choice.missingEvidence, ...choice.nextInspectionSteps], risks: [],
      nextStep: step(true, "Look into what's missing. Nothing will change.") };
    case "missing-capability": return { details: [choice.proposal.desiredOutcome, ...choice.proposal.prerequisites,
      ...choice.proposal.inputs, ...choice.proposal.outputs, ...choice.proposal.verificationExpectations], risks: choice.proposal.risks,
      nextStep: choice.proposal.capabilityKind === "app-backed"
        ? step(false, "This needs a change to the GG app itself. A prompt can't do it.")
        : step(true, "Look over the plan. Nothing changes. Making, testing and running it each need your OK.") };
    case "generate-from-reference": {
      const { generator } = choice;
      const reference = generator.reference.kind === "existing-member"
        ? `Example to copy: ${generator.reference.path} (looked at, not tested)` : "Make one example by hand first";
      return { details: [reference, generator.reference.reason, ...generator.sharedShape, ...generator.varyingInputs, ...generator.members],
        risks: generator.risks,
        nextStep: step(true, "Look over the plan. Nothing changes. Making, testing and running it each need your OK.") };
    }
    case "reuse-command":
    case "extend-command": {
      const availability = "availability" in choice ? choice.availability : undefined;
      const reference = availability?.status === "available" ? availability.snapshot.command
        : availability?.status === "unavailable" ? availability.command : "reference" in choice ? choice.reference.command : undefined;
      const command = reference ? `${reference.source}: /${reference.name}` : "Command needs another check";
      const appBacked = availability?.status === "available" && availability.snapshot.capabilityKind === "app-backed";
      return { availability: commandAvailability(choice), details: [command, ...(choice.kind === "extend-command" ? [...choice.requirement.prerequisites, ...choice.proposedChanges] : [])],
        risks: choice.kind === "extend-command" ? choice.requirement.risks : [],
        nextStep: appBacked ? step(false, "This needs app support GG doesn't have yet. It can't run from here.")
          : availability?.status !== "available" ? step(true, "Check the command and what it needs. Nothing will run.")
          : step(true, choice.kind === "reuse-command" ? "Look over the command and what it covers. Running it needs your OK."
            : "Look over the command and the changes. Opening this doesn't edit it.") };
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
      source: item.external?.url ?? item.location?.path ?? "Earlier check" })),
    ...details(observation.choice), nextStep: unavailable,
  };
  return isDiscoveryCandidate(candidate) ? candidate : undefined;
}
