import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { recommendationAssessmentV1Schema, recommendationCandidateV1Schema, recommendationDecisionV1Schema,
  recommendationEvidenceV1Schema, recommendationHistoryV1Schema, recommendationObservationV1Schema,
  recommendationReferenceV1Schema } from "./recommendation-contracts.js";

const at = "2026-09-16T00:00:00.000Z";
function fixture() {
  const candidateId = randomUUID(), assessmentId = randomUUID(), observationId = randomUUID();
  return {
    version: 1, revision: 1,
    candidates: [{ version: 1, id: candidateId, revision: 1, firstAssessmentId: assessmentId, lastAssessmentId: assessmentId,
      observationIds: [observationId], decisionIds: [], correspondenceIds: [], ambiguity: "none" }],
    assessments: [{ version: 1, id: assessmentId, startedAt: at, finishedAt: at, mode: "configured", outcome: "completed",
      hostCoverage: [], observationIds: [observationId] }],
    observations: [{ version: 1, id: observationId, assessmentId, candidateId, outcome: "Review counts", rationale: "Bounded review",
      uncertainty: "No behavior verification", workflow: { trigger: "Count changes", representativeCase: "A new entry", inputs: ["Counts"],
        currentProcess: ["Review counts"], output: "A report", successCheck: "Compare entries", affectedSubproject: { scope: "repository-wide" },
        mutationBoundary: "Read only", repeatability: { basis: "inferred", explanation: "Entries can change" } },
      choice: { kind: "manual", steps: ["Review in a separate turn"] }, alternatives: [], evidence: [] }],
    decisions: [], correspondences: [],
  };
}

describe("independent recommendation history contracts", () => {
  it("accepts a bounded cross-referenced history and empty history", () => {
    expect(recommendationHistoryV1Schema.safeParse(fixture()).success).toBe(true);
    expect(recommendationHistoryV1Schema.safeParse({ version: 1, revision: 0, candidates: [], assessments: [], observations: [], decisions: [], correspondences: [] }).success).toBe(true);
  });
  it.each(["detectorKey", "presence", "approval", "route", "receipt", "tools"])("refuses authority or scanner field %s", (field) => {
    const value = fixture();
    expect(recommendationCandidateV1Schema.safeParse({ ...value.candidates[0], [field]: "forged" }).success).toBe(false);
    expect(recommendationObservationV1Schema.safeParse({ ...value.observations[0], [field]: "forged" }).success).toBe(false);
  });
  it("rejects unsupported versions, duplicate IDs, dangling and one-way references", () => {
    const value = fixture();
    expect(recommendationHistoryV1Schema.safeParse({ ...value, version: 2 }).success).toBe(false);
    expect(recommendationHistoryV1Schema.safeParse({ ...value, candidates: [...value.candidates, ...value.candidates] }).success).toBe(false);
    expect(recommendationHistoryV1Schema.safeParse({ ...value, observations: [] }).success).toBe(false);
    expect(recommendationHistoryV1Schema.safeParse({ ...value, candidates: [] }).success).toBe(false);
    expect(recommendationHistoryV1Schema.safeParse({ ...value, assessments: [] }).success).toBe(false);
    expect(recommendationHistoryV1Schema.safeParse({ ...value, decisions: [{ version: 1, id: randomUUID(), candidateId: value.candidates[0]!.id,
      at, actor: "user", source: "host-review", decision: "dismissed" }] }).success).toBe(false);
  });
  it.each(["cancelled", "incomplete", "unavailable"])("does not promote observations for %s", (outcome) => {
    expect(recommendationAssessmentV1Schema.safeParse({ ...fixture().assessments[0], outcome }).success).toBe(false);
    expect(recommendationAssessmentV1Schema.safeParse({ ...fixture().assessments[0], outcome, observationIds: [] }).success).toBe(true);
  });
  it.each(["../secret", "/absolute", "C:/absolute", "src\\file", "src/../file", "src/file:stream"])("rejects unsafe location %s", (path) => {
    expect(recommendationEvidenceV1Schema.safeParse({ basis: "observed", summary: "Read a location", retrievedAt: at,
      status: "delivered", freshness: "not-revalidated", location: { path } }).success).toBe(false);
    expect(recommendationEvidenceV1Schema.safeParse({ basis: "observed", summary: "External location", retrievedAt: at,
      status: "delivered", freshness: "not-revalidated", external: { url: "https://example.com/repo", location: { path } } }).success).toBe(false);
  });
  it.each(["https://user:password@example.com/file", "https://example.com/file?token=secret", "https://example.com/file#token", "file:///tmp/local"])("rejects unsafe attribution %s", (url) => {
    expect(recommendationEvidenceV1Schema.safeParse({ basis: "observed", summary: "Read a source", retrievedAt: at,
      status: "delivered", freshness: "not-revalidated", external: { url } }).success).toBe(false);
  });
  it("retains optional external locations and ranges without changing strict V1 compatibility", () => {
    const legacy = { basis: "observed", summary: "External source", status: "delivered", freshness: "not-revalidated",
      external: { url: "https://example.com/repo", revision: "revision-two" } };
    expect(recommendationEvidenceV1Schema.parse(legacy)).toEqual(legacy);
    const located = { ...legacy, external: { ...legacy.external, location: { path: "src/second.ts", startLine: 2, endLine: 4 } } };
    expect(recommendationEvidenceV1Schema.parse(located)).toEqual(located);
    for (const location of [{ path: "src/second.ts", endLine: 4 }, { path: "src/second.ts", startLine: 5, endLine: 4 }])
      expect(recommendationEvidenceV1Schema.safeParse({ ...legacy, external: { ...legacy.external, location } }).success).toBe(false);
    for (const field of ["receiptId", "toolCallId", "rawBody", "approved"])
      expect(recommendationEvidenceV1Schema.safeParse({ ...legacy, external: { ...legacy.external, [field]: "forged" } }).success).toBe(false);
  });
  it("keeps references inert and completion explicitly user-owned", () => {
    const reference = { kind: "execution-result", resultId: randomUUID() };
    expect(recommendationReferenceV1Schema.safeParse(reference).success).toBe(true);
    expect(recommendationReferenceV1Schema.safeParse({ ...reference, approved: true }).success).toBe(false);
    const decision = { version: 1, id: randomUUID(), candidateId: randomUUID(), at, actor: "user", source: "host-review", decision: "completed" };
    expect(recommendationDecisionV1Schema.safeParse(decision).success).toBe(false);
    expect(recommendationDecisionV1Schema.safeParse({ ...decision, completion: "user-declared" }).success).toBe(true);
    expect(recommendationDecisionV1Schema.safeParse({ ...decision, completion: "verification-referenced", reference }).success).toBe(true);
    expect(recommendationDecisionV1Schema.safeParse({ ...decision, completion: "user-declared", reference }).success).toBe(false);
  });
  it("enforces record, text, integer and UTF-8 budgets", () => {
    const value = fixture();
    expect(recommendationHistoryV1Schema.safeParse({ ...value, candidates: Array(1_001).fill(value.candidates[0]) }).success).toBe(false);
    expect(recommendationHistoryV1Schema.safeParse({ ...value, revision: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
    expect(recommendationObservationV1Schema.safeParse({ ...value.observations[0], outcome: "a".repeat(4_001) }).success).toBe(false);
    const assessments = Array.from({ length: 1_500 }, () => ({ version: 1, id: randomUUID(), startedAt: at, finishedAt: at,
      mode: "configured", outcome: "completed", hostCoverage: [{ scope: "project", status: "inspected", summary: "界".repeat(4_000) }], observationIds: [] }));
    expect(recommendationHistoryV1Schema.safeParse({ version: 1, revision: 1, candidates: [], observations: [], decisions: [], correspondences: [], assessments }).success).toBe(false);
  });
});
