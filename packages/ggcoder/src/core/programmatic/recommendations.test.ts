import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isRecommendationDetail } from "@kenkaiiii/gg-core/programmatic-recommendation-contract";
import type { AdvisoryReceipt } from "./advisory.js";
import { programmaticAssessmentResultV2Schema } from "./contracts.js";
import { captureRecommendationAssessment, recommendationDetail, confirmRecommendationCorrespondence, decideRecommendation, emptyRecommendationHistory, reconcileRecommendations,
  type CapturedRecommendationAssessment } from "./recommendations.js";

const at = "2026-09-16T00:00:00.000Z";
function capture(): CapturedRecommendationAssessment {
  return { assessment: { version: 1, id: randomUUID(), startedAt: at, finishedAt: at, mode: "configured", outcome: "completed", hostCoverage: [] },
    observations: [{ version: 1, outcome: "Review counts", rationale: "Bounded review", uncertainty: "No verification",
      workflow: { trigger: "Counts change", representativeCase: "New entry", inputs: ["Counts"], currentProcess: ["Review counts"], output: "Report",
        successCheck: "Compare entries", affectedSubproject: { scope: "repository-wide" }, mutationBoundary: "Read only",
        repeatability: { basis: "inferred", explanation: "Counts can change" } },
      choice: { kind: "manual", steps: ["Review separately"] }, alternatives: [], evidence: [] }] };
}
function externalCapture(basis: "observed" | "inferred" | "assumed", receipts: AdvisoryReceipt[], revision = "revision-two") {
  const input = capture(), observation = input.observations[0]!;
  const accepted = programmaticAssessmentResultV2Schema.parse({ version: 2, kind: "advisory",
    coverage: { status: "limited", scope: "Fixture", reason: "Bounded inspection" },
    recommendations: [{ ...observation, version: 2, kind: "advisory", evidence: { version: 1, items: [{
      kind: "external-reference", basis, inspectedUrl: "https://example.com/repo", revision,
      location: { path: "src/second.ts" }, claim: "External source",
    }] } }] });
  return captureRecommendationAssessment({ id: input.assessment.id, startedAt: at }, {
    version: 1, mode: "configured", status: "completed", summary: "Fixture", limitations: [], coverage: [], observations: [],
    deterministic: { status: "unavailable", reason: "Fixture" },
  }, accepted, receipts, at);
}
const externalReceipt = (id: string, status: AdvisoryReceipt["status"], revision: string, path: string, retrievedAt = at): AdvisoryReceipt => ({
  id, status, retrievedAt, tool: "research_corpus", toolCallId: id,
  external: { tool: "steroids", toolCallId: id, sourceUri: "https://example.com/repo", revision, path },
});
it.each(["retrieved", "lead", "failed", "cancelled"] as const)("captures the exact delivered external receipt after an earlier %s receipt", (status) => {
  const later = "2026-09-16T00:00:01.000Z";
  const receipts = [externalReceipt("wrong", status, "revision-one", "src/first.ts"),
    externalReceipt("wrong-path", "retrieved", "revision-two", "src/first.ts"),
    externalReceipt("right", "retrieved", "revision-two", "src/second.ts", later)];
  const captured = externalCapture("observed", receipts);
  const expected = { basis: "observed", summary: "External source", retrievedAt: later, status: "delivered",
    freshness: "not-revalidated", external: { url: "https://example.com/repo", revision: "revision-two", location: { path: "src/second.ts" } } };
  expect(captured.observations[0]!.evidence).toEqual([expected]);
  const history = reconcileRecommendations(emptyRecommendationHistory(), captured).history;
  expect(history.observations[0]!.evidence).toEqual([expected]);
  const detail = recommendationDetail(history, history.candidates[0]!.id, 0)!;
  expect(JSON.parse(detail.records[0]!.displayJson).evidence).toEqual([expected]);
  expect(detail.discovery).toMatchObject({ candidateId: history.candidates[0]!.id, revision: 1, choice: "manual",
    nextStep: { available: false }, evidence: [{ basis: "observed", message: "External source", source: "https://example.com/repo" }] });
  expect(JSON.stringify(detail.discovery)).not.toContain("toolCallId");
  expect(JSON.stringify(history)).not.toContain("toolCallId");
  expect(JSON.stringify(history)).not.toContain('"right"');
});
it.each(["assumed", "unmatched"] as const)("does not promote %s external evidence by URL", (mode) => {
  const captured = externalCapture(mode === "assumed" ? "assumed" : "observed",
    [externalReceipt("same-url", "retrieved", "revision-two", "src/second.ts")], mode === "unmatched" ? "missing" : "revision-two");
  expect(captured.observations[0]!.evidence[0]).toMatchObject({ status: "lead", external: { location: { path: "src/second.ts" } } });
  expect(captured.observations[0]!.evidence[0]!.retrievedAt).toBeUndefined();
});
const first = () => reconcileRecommendations(emptyRecommendationHistory(), capture()).history;
const requirement = { version: 1 as const, desiredOutcome: "Count report", capabilityKind: "prompt-only" as const,
  inputs: ["Counts"], outputs: ["Report"], prerequisites: ["Entries"], risks: ["Incomplete evidence"], verificationExpectations: ["Compare entries"] };
describe("conservative recommendation reconciliation", () => {
  it("keeps large typed history display inert and separate from the retained record", () => {
    const input = capture();
    input.observations[0]!.choice = { kind: "manual", steps: Array(13).fill("x".repeat(4_000)) };
    const history = reconcileRecommendations(emptyRecommendationHistory(), input).history;
    const detail = recommendationDetail(history, history.candidates[0]!.id, 0)!;
    expect(detail.discovery?.details).toHaveLength(13);
    expect(detail.discovery?.nextStep.available).toBe(false);
    expect(isRecommendationDetail(detail)).toBe(true);
    expect(JSON.parse(detail.records[0]!.displayJson).choice.steps).toHaveLength(13);
  });
  it("allocates host UUIDs, replays identical assessment IDs without capacity, rejects changed content", () => {
    const input = capture(), before = emptyRecommendationHistory();
    const result = reconcileRecommendations(before, input);
    expect(before.candidates).toHaveLength(0);
    expect(result.changed).toBe(true);
    expect(result.history.candidates[0]!.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(reconcileRecommendations(result.history, input)).toEqual({ history: result.history, changed: false });
    expect(() => reconcileRecommendations(result.history, { ...input, assessment: { ...input.assessment, focus: "Changed focus" } })).toThrow(/reused/);
    expect(() => reconcileRecommendations(result.history, { ...input, observations: [] })).toThrow(/reused/);
  });
  it("preserves identity and decisions on exact workflow replay with changed evidence, outcome and choice", () => {
    const initial = first(), candidate = initial.candidates[0]!;
    const dismissed = decideRecommendation(initial, { candidateId: candidate.id, expectedRevision: 1, decision: "dismissed" }, at);
    const input = capture();
    input.observations[0]!.outcome = "Paraphrased title";
    input.observations[0]!.choice = { kind: "needs-more-evidence", missingEvidence: ["Read current entries"], nextInspectionSteps: ["Read entries"] };
    input.observations[0]!.evidence.push({ basis: "observed", summary: "A newly delivered summary", retrievedAt: at,
      status: "delivered", freshness: "not-revalidated", location: { path: "src/counts.ts" } });
    const next = reconcileRecommendations(dismissed, input).history;
    expect(next.candidates).toHaveLength(1);
    expect(next.candidates[0]!.id).toBe(candidate.id);
    expect(next.candidates[0]!.revision).toBe(3);
    expect(next.observations).toHaveLength(2);
    expect(next.observations[0]).toEqual(initial.observations[0]);
    expect(next.decisions).toEqual(dismissed.decisions);
  });
  it.each(["trigger", "representativeCase", "output", "successCheck", "mutationBoundary"] as const)("does not semantically merge changed %s", (key) => {
    const history = first(), input = capture(); input.observations[0]!.workflow[key] += " paraphrased";
    input.observations[0]!.evidence = [...history.observations[0]!.evidence];
    expect(reconcileRecommendations(history, input).history.candidates).toHaveLength(2);
  });
  it("keeps changed scope distinct and requires inspected revision-guarded human correspondence", () => {
    const initial = first();
    const decided = decideRecommendation(initial, { candidateId: initial.candidates[0]!.id, expectedRevision: 1, decision: "completed" }, at);
    const input = capture(); input.observations[0]!.workflow.affectedSubproject = { scope: "subproject", path: "packages/a" };
    const separate = reconcileRecommendations(decided, input).history;
    const canonical = separate.candidates.find((c) => c.id === initial.candidates[0]!.id)!;
    const retained = separate.candidates.find((c) => c.id !== canonical.id)!;
    const request = { canonicalId: canonical.id, canonicalRevision: canonical.revision, retainedId: retained.id, retainedRevision: retained.revision };
    expect(() => confirmRecommendationCorrespondence(separate, { ...request, canonicalRevision: 1 }, at)).toThrow(/changed/);
    const joined = confirmRecommendationCorrespondence(separate, request, at);
    expect(joined.candidates).toHaveLength(2);
    expect(joined.observations).toEqual(separate.observations);
    expect(joined.decisions).toEqual(separate.decisions);
    expect(joined.candidates.find((c) => c.id === canonical.id)!.observationIds).toHaveLength(2);
    expect(joined.correspondences[0]!.retainedId).toBe(retained.id);
    const replay = reconcileRecommendations(joined, { ...input, assessment: { ...input.assessment, id: randomUUID() } }).history;
    expect(replay.candidates).toHaveLength(2);
    expect(replay.observations.at(-1)!.candidateId).toBe(canonical.id);
    expect(reconcileRecommendations(replay, input).changed).toBe(false);
    const multiple = capture(); multiple.observations.push(input.observations[0]!);
    const ambiguous = reconcileRecommendations(joined, multiple).history;
    expect(ambiguous.candidates).toHaveLength(4);
    expect(ambiguous.candidates.find((c) => c.id === canonical.id)!.observationIds).toHaveLength(2);
    expect(() => decideRecommendation(joined, { candidateId: retained.id, expectedRevision: retained.revision + 1, decision: "open" }, at)).toThrow(/canonical/);
  });
  it("retains paraphrases only after explicit correspondence and refuses conflicting decisions", () => {
    let history = first(); const canonicalId = history.candidates[0]!.id;
    history = decideRecommendation(history, { candidateId: canonicalId, expectedRevision: 1, decision: "dismissed" }, at);
    const input = capture(); input.observations[0]!.workflow.trigger = "Entries updated";
    history = reconcileRecommendations(history, input).history;
    const retained = history.candidates.find((c) => c.id !== canonicalId)!;
    const request = { canonicalId, canonicalRevision: 2, retainedId: retained.id, retainedRevision: 1 };
    expect(confirmRecommendationCorrespondence(history, request, at).correspondences).toHaveLength(1);
    const conflict = decideRecommendation(history, { candidateId: retained.id, expectedRevision: 1, decision: "completed" }, at);
    expect(() => confirmRecommendationCorrespondence(conflict, { ...request, retainedRevision: 2 }, at)).toThrow(/Conflicting/);
    expect(conflict.correspondences).toEqual([]);
    expect(conflict.candidates).toHaveLength(2);
  });
  it("never auto-collapses duplicate incoming or saved exact workflows", () => {
    const input = capture(); input.observations.push(structuredClone(input.observations[0]!));
    const duplicate = reconcileRecommendations(emptyRecommendationHistory(), input).history;
    expect(duplicate.candidates).toHaveLength(2);
    expect(duplicate.candidates.every((c) => c.ambiguity === "exact-workflow-duplicate")).toBe(true);
    const next = reconcileRecommendations(duplicate, capture()).history;
    expect(next.candidates).toHaveLength(3);
    expect(next.candidates.every((c) => c.ambiguity === "exact-workflow-duplicate")).toBe(true);
    const existing = first();
    const ambiguous = reconcileRecommendations(existing, input).history;
    expect(ambiguous.candidates).toHaveLength(3);
    expect(ambiguous.candidates.find((c) => c.id === existing.candidates[0]!.id)!.ambiguity).toBe("exact-workflow-duplicate");
  });
  it.each(["completed", "incomplete", "cancelled", "unavailable"] as const)("omission during %s does not resolve or change candidates", (outcome) => {
    const initial = first(), candidate = initial.candidates[0]!;
    const history = decideRecommendation(initial, { candidateId: candidate.id, expectedRevision: 1, decision: "completed" }, at);
    const input = capture(); input.assessment.outcome = outcome; input.assessment.focus = "Unrelated focused scope"; input.observations = [];
    const next = reconcileRecommendations(history, input).history;
    expect(next.candidates).toEqual(history.candidates);
    expect(next.decisions).toEqual(history.decisions);
    expect(next.observations).toEqual(history.observations);
    if (outcome !== "completed") expect(() => reconcileRecommendations(history, { ...input, observations: capture().observations })).toThrow(/Incomplete/);
  });
  it("records explicit reopen and separates user completion from referenced verification", () => {
    let history = first(); const id = history.candidates[0]!.id;
    history = decideRecommendation(history, { candidateId: id, expectedRevision: 1, decision: "completed", verificationResultId: randomUUID() }, at);
    expect(history.decisions[0]!.completion).toBe("verification-referenced");
    history = decideRecommendation(history, { candidateId: id, expectedRevision: 2, decision: "open" }, at);
    expect(history.decisions.map((event) => event.decision)).toEqual(["completed", "open"]);
    expect(() => decideRecommendation(history, { candidateId: id, expectedRevision: 2, decision: "dismissed" }, at)).toThrow(/changed/);
  });
  it.each([
    { kind: "reuse-command", reference: { kind: "command", command: { version: 1, name: "check", source: "built-in", invocationKind: "prompt" }, snapshotSha256: "a".repeat(64) } },
    { kind: "extend-command", reference: { kind: "command", command: { version: 1, name: "check", source: "built-in", invocationKind: "prompt" } }, proposedChanges: ["Add report"], requirement },
    { kind: "missing-capability", proposal: requirement }, { kind: "manual", steps: ["Review counts"] },
    { kind: "needs-more-evidence", missingEvidence: ["Read current counts"], nextInspectionSteps: ["Read counts"] },
  ] satisfies CapturedRecommendationAssessment["observations"][number]["choice"][])("stores $kind without approval, execution or automatic completion", (choice) => {
    const input = capture(); input.observations[0]!.choice = choice;
    if (["reuse-command", "extend-command", "missing-capability"].includes(choice.kind))
      input.observations[0]!.alternatives = [{ kind: "manual", reasonNotSelected: "Repeatable report" }];
    const history = reconcileRecommendations(emptyRecommendationHistory(), input).history;
    expect(history.observations[0]!.choice).toEqual(choice);
    expect(history.decisions).toEqual([]);
  });
});
