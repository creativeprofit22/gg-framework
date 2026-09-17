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
  expect(candidate.availability).toEqual({ status: "available", reason: "Command was available at assessment submission; execution requires separate review and approval." });
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
    : { status: "reinspection-required", reason: "Historical command availability has not been revalidated. Fresh read-only inspection is required." });
  expect(candidate.alternatives[0]!.availability).toEqual({ status: "unavailable", reason: "Compared command deleted" });
  expect(candidate.nextStep.available).toBe(false);
  expect(JSON.stringify(candidate)).not.toContain('"command":');
});
it("keeps unsupported native proposals non-executable", () => {
  const { projection } = projectDiscovery(randomUUID(), accepted({ kind: "missing-capability", proposal: { ...requirement, capabilityKind: "app-backed" } }));
  expect(projection.candidates[0]!.nextStep).toMatchObject({ available: false });
  expect(projection.candidates[0]!.nextStep.reason).toContain("application development");
});
