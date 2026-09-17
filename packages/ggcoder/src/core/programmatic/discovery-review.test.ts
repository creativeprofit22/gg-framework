import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import type { DiscoveryCandidate } from "@kenkaiiii/gg-core/programmatic-recommendation-contract";
import { DiscoveryReviewBoundary } from "./discovery-review.js";

const requirement = { version: 1 as const, desiredOutcome: "Check records", capabilityKind: "prompt-only" as const, inputs: [], outputs: [], prerequisites: [], risks: [], verificationExpectations: [] };
const candidate: DiscoveryCandidate = { assessmentId: randomUUID(), candidateId: randomUUID(), revision: 1, choice: "missing-capability", outcome: "Check records",
  rationale: "Repeated work", uncertainty: "One sample", workflow: { trigger: "Change", representativeCase: "Record", inputs: [], currentProcess: [], output: "Report",
    successCheck: "Known issue reported", scope: "Repository", mutationBoundary: "Read-only", repeatability: { basis: "inferred", explanation: "Repeated records" } },
  evidence: [], alternatives: [], risks: [], details: [], nextStep: { available: true, reason: "Review only" } };
const boundary = () => new DiscoveryReviewBoundary(candidate, new Set(["WORKFLOW"]), { kind: "missing-capability", proposal: requirement });
function inspect(review: DiscoveryReviewBoundary) {
  review.observe(process.cwd(), "read", { file_path: "WORKFLOW" }, "1\tRecords", "local");
  review.observe(process.cwd(), "command_information", { action: "list" }, '{"entries":[]}', "catalog");
}
it.each(["create", "inspect-verification", "apply-verification", "run"])("denies %s before and after fresh inspection", (action) => {
  const review = boundary();
  expect(() => review.claim("programmatic_command", { action }, false)).toThrow();
  inspect(review);
  expect(review.reinspected).toBe(true);
  expect(() => review.claim("programmatic_command", { action }, false)).toThrow();
  expect(() => review.claim("programmatic_command", { action: "inspect" }, false)).not.toThrow();
});
it.each(["bash", "write", "edit", "tasks", "programmatic_scan", "programmatic_profile", "tool_search", "programmatic_advisory_result", "web_fetch"])("never grants %s in review", (name) => {
  const review = boundary(); inspect(review);
  expect(review.allows(name)).toBe(false);
  expect(() => review.claim(name, {}, false)).toThrow();
});
it("requires relevant local evidence and catalog, refuses failed reads and external replacements", () => {
  const review = boundary();
  review.observe(process.cwd(), "read", { file_path: "OTHER" }, "1\tOther", "unrelated");
  review.observe(process.cwd(), "command_information", { action: "list" }, '{"entries":[]}', "catalog");
  expect(review.reinspected).toBe(false);
  review.observe(process.cwd(), "read", { file_path: "WORKFLOW" }, "Error: permission denied", "denied");
  expect(review.reinspected).toBe(false);
  expect(() => review.claim("programmatic_command", { action: "inspect" }, false)).toThrow();
  inspect(review);
  expect(() => review.claim("read", {}, true)).toThrow();
  review.close();
  expect(review.reinspected).toBe(false);
  expect(() => review.claim("read", {}, false)).toThrow();
});
it.each(["reuse-command", "extend-command"] as const)("requires the same current canonical snapshot for %s", (kind) => {
  const snapshot = { version: 1 as const, command: { version: 1 as const, name: "check", source: "project-custom" as const, invocationKind: "prompt" as const },
    capabilityKind: "prompt-only" as const, ownerSha256: "a".repeat(64), bodySha256: "b".repeat(64), helpers: [] };
  const availability = { status: "available" as const, snapshot };
  const choice = kind === "reuse-command" ? { kind, availability } : { kind, availability, proposedChanges: ["Report"], requirement };
  const review = new DiscoveryReviewBoundary({ ...candidate, choice: kind }, new Set(["WORKFLOW"]), choice);
  inspect(review);
  expect(review.reinspected).toBe(false);
  review.observe(process.cwd(), "command_information", {}, JSON.stringify({ status: "prompt", command: snapshot.command, snapshot: { ...snapshot, bodySha256: "c".repeat(64) } }), "stale");
  expect(review.reinspected).toBe(false);
  review.observe(process.cwd(), "command_information", {}, JSON.stringify({ status: "prompt", command: snapshot.command, snapshot }), "current");
  expect(review.reinspected).toBe(true);
  expect(review.prepared).toBe(true);
  expect(() => review.claim("programmatic_command", { action: "inspect" }, false)).toThrow();
  review.observe(process.cwd(), "command_information", { action: "inspect" }, '{"status":"unavailable"}', "unavailable");
  expect(review.prepared).toBe(false);
  review.observe(process.cwd(), "command_information", {}, JSON.stringify({ status: "prompt", command: snapshot.command, snapshot }), "restored");
  expect(review.prepared).toBe(true);
  review.claim("command_information", { action: "inspect" }, false);
  expect(review.prepared).toBe(false); // A thrown lookup has no result to observe.
  review.observe(process.cwd(), "command_information", {}, "Error: failed", "failed");
  expect(review.prepared).toBe(false);
});
it("separates fresh reads from owner-backed proposal completion and revokes stale evidence", () => {
  let current = true;
  const review = new DiscoveryReviewBoundary(candidate, new Set(["WORKFLOW"]), { kind: "missing-capability", proposal: requirement },
    (text) => text === "owner-valid-proposal" ? () => current : undefined);
  inspect(review);
  expect(review.reinspected).toBe(true);
  expect(review.prepared).toBe(false);
  for (const output of ['{"status":"review-required"}', '{"status":"unavailable"}', '{"status":"unsupported"}', 'invalid', '{"status":"proposal","handle":"forged","preview":"incomplete"}']) {
    review.observe(process.cwd(), "programmatic_command", { action: "inspect" }, output, "invalid");
    expect(review.prepared).toBe(false);
  }
  review.observe(process.cwd(), "programmatic_command", { action: "inspect" }, "owner-valid-proposal", "valid");
  expect(review.prepared).toBe(true);
  current = false;
  expect(review.prepared).toBe(false);
  current = true;
  review.claim("programmatic_command", { action: "inspect" }, false);
  expect(review.prepared).toBe(false);
  review.close();
  expect(review.prepared).toBe(false);
});
it("bounds tool calls and makes closure final", () => {
  const review = boundary();
  for (let index = 0; index < 64; index++) review.claim("read", {}, false);
  expect(() => review.claim("read", {}, false)).toThrow();
  review.close();
  inspect(review);
  expect(review.reinspected).toBe(false);
});
