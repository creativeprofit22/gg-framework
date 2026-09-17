import { expect, it } from "vitest";
import type { ProgrammaticAssessment } from "@kenkaiiii/gg-core/programmatic-assessment-contract";
import type { DiscoveryCandidate } from "@kenkaiiii/gg-core/programmatic-recommendation-contract";
import { initialProgrammaticChatState, programmaticChatReducer, canReviewProgrammaticCandidate, canRunProgrammaticSelection } from "./programmatic-chat-state";

const candidate: DiscoveryCandidate = { assessmentId: "54df729b-2d8c-4a9f-abdc-ae6584a70742", candidateId: "ad5bb9ba-4d86-485a-8d74-613fe59b12df", revision: 1,
  choice: "missing-capability", outcome: "Read records", rationale: "Repeated", uncertainty: "Sample only", workflow: { trigger: "Change", representativeCase: "Record",
    inputs: [], currentProcess: [], output: "Report", successCheck: "Known issue found", scope: "Repository", mutationBoundary: "Read-only",
    repeatability: { basis: "inferred", explanation: "Recurring records" } }, evidence: [], alternatives: [], risks: [], details: [], nextStep: { available: true, reason: "Review only" } };
const assessment: ProgrammaticAssessment = { version: 1, mode: "setup", status: "completed", summary: "Scoped discovery", limitations: [], coverage: [], observations: [],
  discovery: { assessmentId: candidate.assessmentId, candidates: [candidate] }, deterministic: { status: "not-run", reason: "setup" } };
const completion = (value: ProgrammaticAssessment, sequence: number) => ({ type: "assessment" as const, generation: "one", event: {
  conversationId: "chat", sessionId: "session", sequence, phase: "completed" as const, assessment: value } });
function selected() {
  let state = programmaticChatReducer(initialProgrammaticChatState("one"), completion(assessment, 1));
  state = programmaticChatReducer(state, { type: "select", id: "scanner" });
  return programmaticChatReducer(state, { type: "select-candidate", source: "current", id: candidate.candidateId });
}
it("keeps candidate identity independent from scanner selection and execution", () => {
  const state = selected();
  expect(state.selection).toEqual({ source: "current", id: candidate.candidateId });
  expect(state.selectedId).toBe("scanner");
  expect(canReviewProgrammaticCandidate(state)).toBe(true);
  expect(canRunProgrammaticSelection(state)).toBe(false);
  expect(programmaticChatReducer(state, { type: "select", id: "scanner" }).candidateDetail).toBe(candidate);
});
it.each(["cancelled", "unavailable", "incomplete", "completed"] as const)("preserves previous candidate through refresh ending %s", (status) => {
  const original = selected();
  const started = programmaticChatReducer(original, { type: "assessment", generation: "one", event: {
    conversationId: "chat", sessionId: "session", sequence: 2, phase: "started" } });
  expect(started.assessment).toBe(assessment);
  expect(started.assessmentRetained).toBe(true);
  expect(started.candidateDetail).toBe(candidate);
  expect(canReviewProgrammaticCandidate(started)).toBe(false);
  const next = programmaticChatReducer(started, completion({ ...assessment, status, discovery: { assessmentId: candidate.assessmentId, candidates: [] } }, 2));
  expect(next.assessmentRetained).toBe(false);
  expect(next.candidateDetail).toBe(candidate);
  expect(next.selection).toEqual(original.selection);
  expect(next.candidateStale).toBe(true);
  expect(canReviewProgrammaticCandidate(next)).toBe(false);
  expect(programmaticChatReducer(next, completion(assessment, 1))).toBe(next);
  expect(programmaticChatReducer(next, { type: "reset", generation: "two" }).candidateDetail).toBeNull();
});
it.each(["cancelled", "unavailable", "incomplete", "completed"] as const)("accepts a current %s response without discovery independently of retained candidates", (status) => {
  const started = programmaticChatReducer(selected(), { type: "start", generation: "one", epoch: 1, operation: "discover" });
  expect(started.assessmentRetained).toBe(true);
  const current = { ...assessment, status, summary: "Current response", discovery: undefined };
  const result = programmaticChatReducer(started, { type: "response", generation: "one", epoch: 1,
    response: { version: 1, action: "discover", ok: true, assessment: current } });
  expect(result.assessment).toBe(current);
  expect(result.assessmentRetained).toBe(false);
  expect(result.discoveryStale).toBe(true);
  expect(result.candidateDetail).toBe(candidate);
  expect(result.candidateStale).toBe(true);
  expect(canReviewProgrammaticCandidate(result)).toBe(false);
});
it("does not turn a selected historical display or delayed review response into current authority", () => {
  const state = programmaticChatReducer(selected(), { type: "select-candidate", source: "history", id: candidate.candidateId });
  expect(canReviewProgrammaticCandidate(state)).toBe(false);
  const late = programmaticChatReducer(state, { type: "response", generation: "one", epoch: state.epoch,
    response: { version: 1, action: "review-candidate", ok: true, candidateReview: { status: "prepared", candidate, summary: "Old review" } } });
  expect(late.selection?.source).toBe("history");
  expect(late.candidateReview).toBeNull();
});
it("does not revive previous evidence from a delayed response while a newer assessment is starting", () => {
  let state = programmaticChatReducer(selected(), { type: "start", generation: "one", epoch: 1, operation: "discover" });
  state = programmaticChatReducer(state, { type: "assessment", generation: "one", event: {
    conversationId: "chat", sessionId: "session", sequence: 2, phase: "started" } });
  state = programmaticChatReducer(state, { type: "response", generation: "one", epoch: 1,
    response: { version: 1, action: "discover", ok: true, assessment } });
  expect(state.discoveryStale).toBe(true);
  expect(state.candidateStale).toBe(true);
  expect(canReviewProgrammaticCandidate(state)).toBe(false);
});
const request = { requestId: "request-1", conversationId: "chat", sessionId: "session" };
it("recovers a successful current receipt when its completed event was dropped", () => {
  let state = programmaticChatReducer(selected(), { type: "start", generation: "one", epoch: 1, operation: "discover", assessmentRequest: request });
  state = programmaticChatReducer(state, { type: "assessment", generation: "one", event: {
    ...request, sequence: 2, phase: "started" } });
  // Deliberately omit completed(2). The original HTTP request is the only completion.
  const returned = { ...assessment, lifecycle: { ...request, sequence: 2 } };
  state = programmaticChatReducer(state, { type: "response", generation: "one", epoch: 1,
    response: { version: 1, action: "discover", ok: true, assessment: returned } });
  expect(state.assessmentPending).toBe(false);
  expect(state.discoveryStale).toBe(false);
  expect(state.candidateDetail).toBe(candidate);
  expect(canReviewProgrammaticCandidate(state)).toBe(true);
});
function pendingRequest() {
  const started = programmaticChatReducer(selected(), { type: "start", generation: "one", epoch: 1,
    operation: "discover", assessmentRequest: request });
  return programmaticChatReducer(started, { type: "assessment", generation: "one", event: { ...request, sequence: 2, phase: "started" } });
}
const receipt = (lifecycle = { ...request, sequence: 2 }, status: ProgrammaticAssessment["status"] = "completed") => ({
  type: "response" as const, generation: "one", epoch: 1,
  response: { version: 1 as const, action: "discover" as const, ok: true as const, assessment: { ...assessment, status, lifecycle } },
});
it.each(["started", "completed"] as const)("does not replace a genuinely newer %s assessment with an older receipt", (phase) => {
  const state = programmaticChatReducer(pendingRequest(), { type: "assessment", generation: "one", event: phase === "started"
    ? { ...request, requestId: "newer", sequence: 3, phase }
    : { ...request, requestId: "newer", sequence: 3, phase, assessment: { ...assessment, summary: "Newer" } } });
  const result = programmaticChatReducer(state, receipt());
  expect(result.assessment).toBe(state.assessment);
  expect(result.assessmentPending).toBe(state.assessmentPending);
  expect(result.assessmentSequence).toBe(3);
});
it.each([{ sessionId: "other" }, { conversationId: "other" }, { requestId: "other" }])("rejects mismatched receipt owner %j", (patch) => {
  const state = pendingRequest();
  const result = programmaticChatReducer(state, receipt({ ...request, sequence: 2, ...patch }));
  expect(result.assessmentPending).toBe(true);
  expect(result.discoveryStale).toBe(true);
  expect(canReviewProgrammaticCandidate(result)).toBe(false);
});
it.each(["cancelled", "unavailable", "incomplete"] as const)("settles matching %s receipts without reviving previous detail", (status) => {
  const result = programmaticChatReducer(pendingRequest(), receipt(undefined, status));
  expect(result.assessmentPending).toBe(false);
  expect(result.candidateDetail).toBe(candidate);
  expect(result.candidateStale).toBe(true);
  expect(canReviewProgrammaticCandidate(result)).toBe(false);
});
it("rejects old generations and epochs and does not regress an accepted completion", () => {
  const state = pendingRequest();
  expect(programmaticChatReducer(state, { ...receipt(), epoch: 0 })).toBe(state);
  expect(programmaticChatReducer(state, { ...receipt(), generation: "retired" })).toBe(state);
  const reset = programmaticChatReducer(state, { type: "reset", generation: "two" });
  expect(programmaticChatReducer(reset, receipt())).toBe(reset);
  const settled = programmaticChatReducer(state, receipt());
  const lateStart = programmaticChatReducer(settled, { type: "assessment", generation: "one", event: { ...request, sequence: 2, phase: "started" } });
  expect(lateStart).toBe(settled);
});
it("marks matching transport loss as unknown and still accepts a late completion", () => {
  const state = pendingRequest();
  const failed = programmaticChatReducer(state, { type: "error", generation: "one", epoch: 1, error: "Cancelled transport", reconcile: false });
  expect(failed.assessmentPending).toBe(false);
  expect(failed.assessmentUncertain).toBe(true);
  expect(failed.candidateDetail).toBe(candidate);
  expect(canReviewProgrammaticCandidate(failed)).toBe(false);
  const completed = programmaticChatReducer(failed, { type: "assessment", generation: "one",
    event: { ...request, sequence: 2, phase: "completed", assessment } });
  expect(completed.assessmentUncertain).toBe(false);
  expect(canReviewProgrammaticCandidate(completed)).toBe(true);
});
it("does not clear another operation's pending state on transport loss", () => {
  const state = programmaticChatReducer(pendingRequest(), { type: "assessment", generation: "one",
    event: { ...request, requestId: "newer", sequence: 3, phase: "started" } });
  const failed = programmaticChatReducer(state, { type: "error", generation: "one", epoch: 1, error: "Lost", reconcile: false });
  expect(failed.assessmentPending).toBe(true);
  expect(failed.assessmentUncertain).toBe(false);
});
it("keeps selected context and disables handoff on unknown acknowledgement without replaying work", () => {
  const state = selected();
  const started = programmaticChatReducer(state, { type: "start", generation: "one", epoch: 1, operation: "review-candidate" });
  const failed = programmaticChatReducer(started, { type: "error", generation: "one", epoch: 1, error: "Response lost", reconcile: true });
  expect(failed.candidateDetail).toBe(candidate);
  expect(failed.operation).toBeNull();
  expect(canReviewProgrammaticCandidate(failed)).toBe(false);
});
