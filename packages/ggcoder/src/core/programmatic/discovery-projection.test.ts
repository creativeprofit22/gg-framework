import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { isDiscoveryProjection } from "@kenkaiiii/gg-core/programmatic-recommendation-contract";
import { programmaticAssessmentResultV2Schema } from "./contracts.js";
import type { RecommendationObservationV1 } from "./recommendation-contracts.js";
import { projectDiscovery, projectHistoricalDiscovery } from "./discovery-projection.js";

const requirement = { version: 1, desiredOutcome: "Check records", capabilityKind: "prompt-only", inputs: ["Records"], outputs: ["Report"],
  prerequisites: ["Readable records"], risks: ["Sample only"], verificationExpectations: ["Invalid record reported"] };
const availability = { status: "unavailable", command: { version: 1, name: "check-records", source: "project-custom", invocationKind: "prompt" }, reason: "Needs inspection" } as const;
const choices = [
  { kind: "manual", steps: ["Read records"] },
  { kind: "needs-more-evidence", missingEvidence: ["Read current examples"], nextInspectionSteps: ["Read records"] },
  { kind: "missing-capability", proposal: requirement },
  { kind: "reuse-command", availability },
  { kind: "extend-command", availability, proposedChanges: ["Add report"], requirement },
];
function accepted(choice: unknown) {
  return programmaticAssessmentResultV2Schema.parse({ version: 2, kind: "advisory", coverage: { status: "limited", scope: "Records", reason: "Sample only" },
    recommendations: [{ version: 2, kind: "advisory", outcome: "Check records", rationale: "Repeated process", uncertainty: "Sample only",
      workflow: { trigger: "Records change", representativeCase: "One record", inputs: ["Records"], currentProcess: ["Read records"], output: "Report",
        successCheck: "Invalid record reported", affectedSubproject: { scope: "repository-wide" }, mutationBoundary: "Read-only",
        repeatability: { basis: "inferred", explanation: "Repeated structure" } }, evidence: { version: 1, items: [] },
      alternatives: (choice as { kind: string }).kind === "manual" ? [] : [{ kind: "manual", reasonNotSelected: "Repeated work" }], choice }] });
}
it.each(choices)("projects $kind without transferring domain authority", (choice) => {
  const result = accepted(choice), id = randomUUID();
  const { projection, records } = projectDiscovery(id, result);
  expect(isDiscoveryProjection(projection)).toBe(true);
  expect(projection.candidates[0]).toMatchObject({ assessmentId: id, revision: 1, choice: choice.kind });
  expect(records[0]!.recommendation).toEqual(result.recommendations[0]);
  expect(records[0]!.recommendation).not.toBe(result.recommendations[0]);
  expect(JSON.stringify(projection)).not.toContain('"command":');
  expect(JSON.stringify(projection)).not.toContain('"receipt":');
  expect(projectDiscovery(id, result).projection.candidates[0]!.candidateId).not.toBe(projection.candidates[0]!.candidateId);
});
it("projects only bounded availability evidence for an available command", () => {
  const result = accepted({ kind: "reuse-command", availability: { status: "available", snapshot: {
    version: 1, command: availability.command, capabilityKind: "prompt-only", ownerSha256: "a".repeat(64), bodySha256: "b".repeat(64), helpers: [],
  } } });
  const candidate = projectDiscovery(randomUUID(), result).projection.candidates[0]!;
  expect(candidate.availability).toEqual({ status: "available", reason: "The command was available when assessed. Review and approval are still needed before running it." });
  expect(candidate.nextStep.available).toBe(true);
  expect(JSON.stringify(candidate)).not.toContain("Sha256");
});
it.each(["available", "unavailable", undefined] as const)("does not restore historical %s availability as current authority", (reportedAvailability) => {
  const recommendation = accepted({ kind: "reuse-command", availability }).recommendations[0]!;
  const observation: RecommendationObservationV1 = { version: 1, id: randomUUID(), assessmentId: randomUUID(), candidateId: randomUUID(),
    workflow: recommendation.workflow, outcome: recommendation.outcome, rationale: recommendation.rationale, uncertainty: recommendation.uncertainty,
    evidence: [], alternatives: [{ kind: "extend-command", reasonNotSelected: "No changes needed", reference: {
      kind: "command", command: availability.command, reportedAvailability: "unavailable", unavailableReason: "Compared command deleted",
    } }], choice: { kind: "reuse-command", reference: { kind: "command", command: availability.command,
      ...(reportedAvailability ? { reportedAvailability } : {}), ...(reportedAvailability === "unavailable" ? { unavailableReason: availability.reason } : {}) } } };
  const candidate = projectHistoricalDiscovery(observation, 1)!;
  expect(candidate.availability).toEqual(reportedAvailability === "unavailable" ? { status: "unavailable", reason: availability.reason }
    : { status: "reinspection-required", reason: "This saved command has not been checked again. Inspect it without making changes before using it." });
  expect(candidate.alternatives[0]!.availability).toEqual({ status: "unavailable", reason: "Compared command deleted" });
  expect(candidate.nextStep.available).toBe(false);
  expect(JSON.stringify(candidate)).not.toContain('"command":');
});
it.each(["missing-capability", "extend-command"])("keeps every prerequisite visible in bounded %s details", (kind) => {
  const prerequisites = Array.from({ length: 50 }, (_, index) => `Requirement ${index + 1}: review external data use before continuing`);
  const proposal = { ...requirement, prerequisites };
  const result = accepted(kind === "missing-capability" ? { kind, proposal } : { kind, availability, proposedChanges: ["Add report"], requirement: proposal });
  const before = structuredClone(result);
  const candidate = projectDiscovery(randomUUID(), result).projection.candidates[0]!;
  for (const prerequisite of prerequisites) expect(candidate.details).toContain(prerequisite);
  expect(candidate.details.length).toBeLessThanOrEqual(64);
  expect(candidate.risks).toEqual(requirement.risks);
  expect(result).toEqual(before);
});

it.each([
  { kind: "extend-command", availability, requirement: { ...requirement, prerequisites: Array.from({ length: 50 }, (_, i) => `Prerequisite ${i}`) },
    proposedChanges: [...Array.from({ length: 49 }, (_, i) => `Change ${i}`), "Require explicit approval before exporting customer records"] },
  { kind: "missing-capability", proposal: { ...requirement, prerequisites: Array.from({ length: 50 }, (_, i) => `Prerequisite ${i}`), inputs: Array.from({ length: 50 }, (_, i) => `Input ${i}`) } },
  { kind: "needs-more-evidence", missingEvidence: Array.from({ length: 50 }, (_, i) => `Evidence ${i}`), nextInspectionSteps: Array.from({ length: 50 }, (_, i) => `Inspection ${i}`) },
])("rejects over-budget $kind without truncating accepted or historical data", (choice) => {
  const result = accepted(choice), before = structuredClone(result);
  expect(() => projectDiscovery(randomUUID(), result)).toThrow("display boundary");
  expect(result).toEqual(before);
  const recommendation = result.recommendations[0]!;
  const historicalChoice = recommendation.choice.kind === "extend-command"
    ? { kind: recommendation.choice.kind, requirement: recommendation.choice.requirement, proposedChanges: recommendation.choice.proposedChanges,
      reference: { kind: "command" as const, command: availability.command } }
    : recommendation.choice;
  if (historicalChoice.kind === "reuse-command") throw new Error("Unexpected fixture");
  const observation: RecommendationObservationV1 = { ...recommendation, version: 1, id: randomUUID(), assessmentId: randomUUID(), candidateId: randomUUID(),
    evidence: [], alternatives: [{ kind: "manual", reasonNotSelected: "Repeated work" }], choice: historicalChoice };
  const historicalBefore = structuredClone(observation);
  expect(projectHistoricalDiscovery(observation, 1)).toBeUndefined();
  expect(observation).toEqual(historicalBefore);
});

it("keeps unsupported native proposals non-executable", () => {
  const { projection } = projectDiscovery(randomUUID(), accepted({ kind: "missing-capability", proposal: { ...requirement, capabilityKind: "app-backed" } }));
  expect(projection.candidates[0]!.nextStep).toMatchObject({ available: false });
  expect(projection.candidates[0]!.nextStep.reason).toContain("application development");
});
