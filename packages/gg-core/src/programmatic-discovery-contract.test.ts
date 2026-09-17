import { describe, expect, it } from "vitest";
import { isDiscoveryCandidate, isDiscoveryProjection, type DiscoveryCandidate } from "./programmatic-recommendation-contract.js";
import { isProgrammaticAssessment } from "./programmatic-assessment-contract.js";
import { isProgrammaticChatRequest, isProgrammaticChatResponse } from "./programmatic-chat-contract.js";

const assessmentId = "54df729b-2d8c-4a9f-abdc-ae6584a70742";
const candidateId = "ad5bb9ba-4d86-485a-8d74-613fe59b12df";
const candidate: DiscoveryCandidate = {
  assessmentId, candidateId, revision: 1, choice: "missing-capability", outcome: "Check records",
  rationale: "Repeated work", uncertainty: "Sample only",
  workflow: { trigger: "On change", representativeCase: "One record", inputs: ["Records"], currentProcess: ["Manual check"],
    output: "Report", successCheck: "Known invalid record is reported", scope: "Repository", mutationBoundary: "Read-only",
    repeatability: { basis: "observed", explanation: "Repeated files" } },
  evidence: [{ basis: "observed", message: "Records present", source: "Local inspection" }],
  alternatives: [{ kind: "manual", reasonNotSelected: "Repeated work" }], risks: ["Incomplete sample"], details: ["Inspect a proposal"],
  nextStep: { available: true, reason: "Review only; separate approval required" },
};
const assessment = { version: 1, mode: "setup", status: "completed", summary: "Scoped assessment", limitations: [], coverage: [],
  observations: [], deterministic: { status: "not-run", reason: "setup" } };
const request = { version: 1, action: "review-candidate", intent: "review-only", source: "current", assessmentId, candidateId, expectedRevision: 1 };

describe("discovery display and review boundary", () => {
  it("retains legacy assessments and distinguishes absent from empty candidate detail", () => {
    expect(isProgrammaticAssessment(assessment)).toBe(true);
    expect(isProgrammaticAssessment({ ...assessment, discovery: { assessmentId, candidates: [] } })).toBe(true);
    expect(isProgrammaticChatResponse({ version: 1, action: "discover", ok: true, assessment })).toBe(true);
  });
  it.each(["reuse-command", "extend-command", "missing-capability", "manual", "needs-more-evidence"] as const)("accepts proposal-only %s display", (choice) => {
    const item = { ...candidate, choice, alternatives: [], nextStep: { ...candidate.nextStep, available: choice !== "manual" } };
    expect(isDiscoveryCandidate(item)).toBe(true);
    expect(isDiscoveryProjection({ assessmentId, candidates: [item] })).toBe(true);
  });
  it("accepts compact current/history review requests and scanner-independent discovery", () => {
    expect(isProgrammaticChatRequest({ version: 1, action: "discover" })).toBe(true);
    for (const source of ["current", "history"]) {
      expect(isProgrammaticChatRequest({ ...request, source })).toBe(true);
      expect(new TextEncoder().encode(JSON.stringify({ ...request, source })).length).toBeLessThan(2_048);
    }
  });
  it.each(["body", "prompt", "command", "tools", "approved", "receipt", "snapshot", "route"])("rejects browser authority %s at every new boundary", (key) => {
    expect(isProgrammaticChatRequest({ ...request, [key]: "untrusted" })).toBe(false);
    expect(isProgrammaticChatRequest({ version: 1, action: "discover", [key]: "untrusted" })).toBe(false);
    expect(isDiscoveryCandidate({ ...candidate, [key]: "untrusted" })).toBe(false);
    expect(isDiscoveryCandidate({ ...candidate, nextStep: { ...candidate.nextStep, [key]: "untrusted" } })).toBe(false);
    expect(isProgrammaticChatResponse({ version: 1, action: "review-candidate", ok: true,
      candidateReview: { status: "prepared", candidate, summary: "Review only", [key]: "untrusted" } })).toBe(false);
  });
  it("rejects malformed identity, revision, intent, nested data and duplicate candidates", () => {
    for (const patch of [{ assessmentId: "scanner-id" }, { candidateId: "x".repeat(3_000) }, { expectedRevision: 0 },
      { expectedRevision: Number.MAX_SAFE_INTEGER + 1 }, { intent: "run" }, { source: "deterministic" }]) {
      expect(isProgrammaticChatRequest({ ...request, ...patch })).toBe(false);
    }
    expect(isDiscoveryCandidate({ ...candidate, workflow: { ...candidate.workflow, body: "untrusted" } })).toBe(false);
    expect(isDiscoveryCandidate({ ...candidate, outcome: "x".repeat(4_001) })).toBe(false);
    expect(isDiscoveryCandidate({ ...candidate, outcome: "bad\u001btext" })).toBe(false);
    expect(isDiscoveryProjection({ assessmentId, candidates: [candidate, candidate] })).toBe(false);
    expect(isDiscoveryProjection({ assessmentId: candidateId, candidates: [candidate] })).toBe(false);
    expect(isDiscoveryProjection({ assessmentId, candidates: Array(11).fill(candidate) })).toBe(false);
    expect(isDiscoveryCandidate({ ...candidate, choice: "manual", alternatives: [] })).toBe(false);
  });
  it("accepts inert availability across assessment, review and history while rejecting authority and unbounded reasons", () => {
    for (const status of ["available", "unavailable", "reinspection-required"]) {
      const item = { ...candidate, choice: "reuse-command", availability: { status, reason: "Exact host reason" },
        alternatives: [{ kind: "extend-command", reasonNotSelected: "Not suitable", availability: { status, reason: "Compared reason" } }] };
      expect(isDiscoveryCandidate(item)).toBe(true);
      expect(isProgrammaticAssessment({ ...assessment, discovery: { assessmentId, candidates: [item] } })).toBe(true);
      expect(isProgrammaticChatResponse({ version: 1, action: "review-candidate", ok: true,
        candidateReview: { status: "reinspection-required", candidate: item, summary: "Read-only" } })).toBe(true);
      for (const invalid of [{ status: "approved", reason: "No" }, { status, reason: "" }, { status, reason: "x".repeat(4_001) },
        { status, reason: "bad\u001btext" }, ...["body", "receipt", "snapshot", "approved", "command"].map((key) => ({ status, reason: "No", [key]: "authority" }))]) {
        expect(isDiscoveryCandidate({ ...item, availability: invalid })).toBe(false);
        expect(isDiscoveryCandidate({ ...item, alternatives: [{ ...item.alternatives[0], availability: invalid }] })).toBe(false);
      }
    }
  });
  it("caps aggregate display payloads, not only individual fields", () => {
    const large = { ...candidate, details: Array(15).fill("x".repeat(4_000)) };
    expect(isDiscoveryCandidate(large)).toBe(true);
    expect(isDiscoveryCandidate({ ...large, details: Array(17).fill("x".repeat(4_000)) })).toBe(false);
    expect(isDiscoveryProjection({ assessmentId, candidates: [large, { ...large, candidateId: assessmentId }] })).toBe(false);
  });
});
