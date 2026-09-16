import { describe, expect, it } from "vitest";
import { isProgrammaticAssessment, isProgrammaticAssessmentEvent, type ProgrammaticAssessment } from "./programmatic-assessment-contract.js";

const assessment: ProgrammaticAssessment = {
  version: 1, mode: "configured", status: "completed", summary: "Scoped workflow assessment, not a clean bill of health.",
  limitations: ["Only delivered evidence was assessed."],
  coverage: [{ scope: "project", status: "inspected", summary: "Read WORKFLOW." }],
  observations: [{ basis: "inferred", message: "Dispatch needs reconciliation.", evidenceSources: ["receipt-1"] }],
  deterministic: { status: "succeeded", enabledCount: 0, applicableCount: 0 },
};

describe("bounded assessment display contract", () => {
  it("validates host lifecycle identity and rejects authority or recommendations on events", () => {
    const identity = { conversationId: "chat", sessionId: "session", sequence: 1 };
    const started = { ...identity, phase: "started" };
    const completed = { ...identity, phase: "completed", assessment };
    expect(isProgrammaticAssessmentEvent(started)).toBe(true);
    expect(isProgrammaticAssessmentEvent(completed)).toBe(true);
    for (const invalid of [
      { ...started, assessment }, { ...completed, proposalHandle: "a".repeat(64) },
      { ...completed, recommendations: [] }, { ...completed, assessment: { ...assessment, approved: true } },
      { ...completed, sequence: 0 }, { ...completed, sequence: 1.5 },
      { ...completed, conversationId: "" }, { ...completed, sessionId: "x".repeat(257) },
    ]) expect(isProgrammaticAssessmentEvent(invalid)).toBe(false);
  });
  it.each(["completed", "incomplete", "unavailable", "cancelled"] as const)("keeps %s independent of scanner outcomes", (status) => {
    for (const deterministic of [
      { status: "succeeded", enabledCount: 0, applicableCount: 0 },
      ...["unavailable", "denied", "cancelled", "failed"].map((status) => ({ status, reason: "Independent scanner limitation." })),
    ]) expect(isProgrammaticAssessment({ ...assessment, status, deterministic })).toBe(true);
    expect(isProgrammaticAssessment({ ...assessment, mode: "setup", status, deterministic: { status: "not-run", reason: "setup" } })).toBe(true);
  });
  it.each(["inspected", "uninspected", "budget-limited", "unreadable", "unsafe", "nonmatching", "not-applicable"])("distinguishes %s project and catalog coverage", (status) => {
    for (const scope of ["project", "catalog"]) {
      expect(isProgrammaticAssessment({ ...assessment, coverage: [{ scope, status, summary: "Scoped evidence." }] })).toBe(true);
    }
  });
  it("accepts exact bounds and existing validated focus without requiring recommendations", () => {
    expect(isProgrammaticAssessment({ ...assessment, focus: "x".repeat(4000), summary: "x".repeat(4000),
      limitations: Array(50).fill("Limited"), coverage: Array(50).fill(assessment.coverage[0]),
      observations: Array(50).fill({ ...assessment.observations[0], evidenceSources: Array.from({ length: 50 }, (_, i) => `${i}`.padEnd(100, "x")) }),
      deterministic: { status: "succeeded", enabledCount: 64, applicableCount: 64 },
    })).toBe(true);
    expect(isProgrammaticAssessment({ ...assessment, observations: [], coverage: [] })).toBe(true);
  });
  it.each([
    null, [], {}, { ...assessment, version: 2 }, { ...assessment, status: "success" },
    { ...assessment, mode: "model-selected" }, { ...assessment, proposalHandle: "a".repeat(64) },
    { ...assessment, recommendations: [] }, { ...assessment, focus: " " },
    { ...assessment, focus: "x".repeat(4001) }, { ...assessment, focus: "bad\u007f" },
    { ...assessment, focus: undefined }, { ...assessment, summary: "x".repeat(4001) },
    { ...assessment, summary: "bad\u0000" }, { ...assessment, limitations: Array(51).fill("x") },
    { ...assessment, limitations: ["x".repeat(4001)] }, { ...assessment, coverage: Array(51).fill(assessment.coverage[0]) },
    { ...assessment, observations: Array(51).fill(assessment.observations[0]) },
    { ...assessment, mode: "setup" },
    { ...assessment, deterministic: { status: "not-run", reason: "setup" } },
  ])("rejects malformed, oversized or authority-bearing envelopes %#", (value) => {
    expect(isProgrammaticAssessment(value)).toBe(false);
  });
  it.each([
    { status: "succeeded" }, { status: "succeeded", enabledCount: 0, applicableCount: 1 },
    ...[-1, 0.5, 65, NaN, Infinity].map((enabledCount) => ({ status: "succeeded", enabledCount, applicableCount: 0 })),
    { status: "succeeded", enabledCount: 1, applicableCount: -1 },
    { status: "succeeded", enabledCount: 0, applicableCount: 0, reason: "Advice submitted" },
    { status: "failed", reason: "" }, { status: "denied", reason: "x".repeat(4001) },
    { status: "failed", reason: "Failed", enabledCount: 1 }, { status: "complete", reason: "Done" },
  ])("rejects invalid deterministic outcome %#", (deterministic) => {
    expect(isProgrammaticAssessment({ ...assessment, deterministic })).toBe(false);
  });
  it.each([
    { scope: "all", status: "inspected", summary: "All" },
    { scope: "project", status: "complete", summary: "All" },
    { scope: "catalog", status: "inspected", summary: "All", projectCovered: true },
    { scope: "project", status: "unsafe", summary: "x".repeat(4001) },
  ])("rejects invalid coverage %#", (coverage) => {
    expect(isProgrammaticAssessment({ ...assessment, coverage: [coverage] })).toBe(false);
  });
  it.each([
    { evidenceSources: [] }, { evidenceSources: ["same", "same"] }, { evidenceSources: ["x".repeat(101)] },
    { evidenceSources: Array.from({ length: 51 }, (_, i) => `${i}`) }, { evidenceSources: ["bad\u0080"] },
    { basis: "verified" }, { message: "x".repeat(4001) }, { run: true }, { proposal: {} },
  ])("rejects invalid or unauthenticated observation display %#", (patch) => {
    expect(isProgrammaticAssessment({ ...assessment, observations: [{ ...assessment.observations[0], ...patch }] })).toBe(false);
  });
});
