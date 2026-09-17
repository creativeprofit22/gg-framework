// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DiscoveryCandidate, RecommendationSummary } from "@kenkaiiii/gg-core/programmatic-recommendation-contract";
import { initialProgrammaticChatState, programmaticChatReducer, type ProgrammaticChatState } from "./programmatic-chat-state";
import { ProgrammaticChat } from "./ProgrammaticChat";
import { discoveryResponse } from "./programmatic-discovery-state";
import { recommendationHistoryFixture } from "../scripts/recommendation-history-fixture.mjs";

afterEach(cleanup);
it.each(["dismissed", "completed"] as const)("browses real correspondence to an off-page %s candidate without granting authority", (decision) => {
  const { detail, canonical } = recommendationHistoryFixture(decision);
  const canonicalId = canonical.candidate.id;
  expect(detail.candidate).toMatchObject({ decision: "open", canonicalId, observationCount: 1 });
  const before = JSON.stringify({ detail, canonical });
  const props = fixture();
  let state: ProgrammaticChatState = { ...initialProgrammaticChatState("one"), historyReport: {
    version: 1, status: "ready", revision: detail.historyRevision, offset: 50, total: 51, candidates: [detail.candidate],
  } };
  // Mirror AgentPane's id-only history selection path, including an ID outside the loaded page.
  props.onSelectCandidate.mockImplementation((source: "history", id: string) => {
    state = programmaticChatReducer(state, { type: "select-candidate", source, id });
    props.onAction({ version: 1, action: "history-detail", candidateId: id, offset: 0 });
    state = discoveryResponse(state, { version: 1, ok: true, action: "history-detail", detail: id === canonicalId ? canonical : detail });
  });
  const view = render(<ProgrammaticChat {...props} state={state} />);
  fireEvent.click(screen.getByText("Browse recommendation history"));
  expect(screen.getByText("Linked to an earlier candidate · Not a separate outstanding need")).toBeTruthy();
  expect(screen.queryByText("open")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: detail.candidate.outcome }));
  view.rerender(<ProgrammaticChat {...props} state={state} />);
  expect(screen.getByText("1 saved observation. Historical evidence only; not current approval.")).toBeTruthy();
  expect(document.querySelector("b")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "View earlier candidate" }));
  expect(props.onAction).toHaveBeenLastCalledWith({ version: 1, action: "history-detail", candidateId: canonicalId, offset: 0 });
  view.rerender(<ProgrammaticChat {...props} state={state} />);
  expect(screen.getByText(`Recorded decision: ${decision}`)).toBeTruthy();
  expect(state.candidateStale).toBe(true);
  expect(props.onAction.mock.calls.map(([request]) => request.action)).toEqual(["history-detail", "history-detail"]);
  expect(props.onRun).not.toHaveBeenCalled();
  expect(JSON.stringify({ detail, canonical })).toBe(before);
});
it("distinguishes unresolved exact-workflow duplicates in both history and legacy detail", () => {
  const { detail } = recommendationHistoryFixture();
  const props = fixture();
  const state: ProgrammaticChatState = { ...initialProgrammaticChatState("one"), selection: { source: "history", id: detail.candidate.id },
    historyDetail: { ...detail, discovery: undefined }, historyReport: { version: 1, status: "ready", revision: detail.historyRevision,
      offset: 0, total: 2, candidates: [detail.candidate] } };
  render(<ProgrammaticChat {...props} state={state} />);
  fireEvent.click(screen.getByText("Browse recommendation history"));
  expect(screen.getAllByText("Possible duplicate · Same workflow; relationship not confirmed")).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "View earlier candidate" })).toBeNull();
  expect(props.onAction).not.toHaveBeenCalled();
  expect(props.onRun).not.toHaveBeenCalled();
});
it.each([51, 100, 101])("round-trips history pages with %i saved candidates without losing historical context", (total) => {
  const props = fixture();
  const candidates: RecommendationSummary[] = Array.from({ length: total }, (_, index) => ({
    id: `saved-${index}`, revision: 1, outcome: `Saved opportunity ${index}`, decision: "open",
    ambiguity: "none", observationCount: 1,
  }));
  const detail = { version: 1 as const, historyRevision: 1, candidate: candidates[0], offset: 0, total: 1,
    records: [], discovery: candidate };
  let state: ProgrammaticChatState = { ...initialProgrammaticChatState("one"), historyDetail: detail };
  state = programmaticChatReducer(state, { type: "select-candidate", source: "history", id: candidates[0].id });
  const selected = state;
  const view = render(<ProgrammaticChat {...props} state={state} />);
  fireEvent.click(screen.getByText("Browse recommendation history"));
  const showPage = (offset: number) => {
    state = discoveryResponse(state, { version: 1, ok: true, action: "history-report", report: {
      version: 1, status: "ready", revision: 1, total, offset, candidates: candidates.slice(offset, offset + 50),
    } });
    view.rerender(<ProgrammaticChat {...props} state={state} />);
    expect(state.selection).toBe(selected.selection);
    expect(state.historyDetail).toBe(detail);
    expect(state.candidateDetail).toBe(candidate);
    expect(state.candidateStale).toBe(true);
    expect(screen.getByText("Review a new capability · Historical proposal")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Review a new capability" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Previous history" }) as HTMLButtonElement).disabled).toBe(offset === 0);
    expect((screen.getByRole("button", { name: "Next history" }) as HTMLButtonElement).disabled).toBe(offset + 50 >= total);
  };
  const navigate = (direction: "Next" | "Previous", offset: number) => {
    fireEvent.click(screen.getByRole("button", { name: `${direction} history` }));
    expect(props.onAction).toHaveBeenLastCalledWith({ version: 1, action: "history-report", offset });
    showPage(offset);
  };
  showPage(0);
  navigate("Next", 50);
  navigate("Previous", 0);
  if (total === 101) {
    navigate("Next", 50);
    navigate("Next", 100);
    navigate("Previous", 50);
  }
  expect(props.onSelectCandidate).not.toHaveBeenCalled();
  expect(props.onRun).not.toHaveBeenCalled();
});
const candidate: DiscoveryCandidate = { assessmentId: "54df729b-2d8c-4a9f-abdc-ae6584a70742", candidateId: "ad5bb9ba-4d86-485a-8d74-613fe59b12df", revision: 1,
  choice: "missing-capability", outcome: "<img src=x onerror=alert(1)>", rationale: "Repeated records", uncertainty: "Sample only",
  workflow: { trigger: "Records change", representativeCase: "Record", inputs: ["Records"], currentProcess: ["Read records"], output: "Report",
    successCheck: "Known mismatch reported", scope: "Repository", mutationBoundary: "Read only", repeatability: { basis: "inferred", explanation: "Recurring structure" } },
  evidence: [{ basis: "assumed", message: "May recur", source: "Proposal" }], alternatives: [{ kind: "manual", reasonNotSelected: "Repeated effort" }],
  risks: ["Sample incomplete"], details: ["Inspect proposal only"], nextStep: { available: true, reason: "Creation needs separate approval" } };
function fixture(item = candidate) {
  const assessment = { version: 1 as const, mode: "setup" as const, status: "completed" as const, summary: "Scoped assessment", coverage: [], limitations: [], observations: [],
    deterministic: { status: "not-run" as const, reason: "setup" as const }, discovery: { assessmentId: item.assessmentId, candidates: [item] } };
  const state = { ...initialProgrammaticChatState("one"), assessment, discovery: assessment.discovery };
  return { state, busy: false, planMode: false, onAction: vi.fn(), onSelect: vi.fn(), onSelectCandidate: vi.fn(), onRun: vi.fn() };
}
it("discovers without scanner setup, selects without submitting, and reviews only with a second explicit action", async () => {
  const props = fixture();
  const view = render(<ProgrammaticChat {...props} />);
  const discover = screen.getByRole("button", { name: "Discover opportunities" });
  discover.focus();
  expect(document.activeElement).toBe(discover);
  fireEvent.click(discover);
  expect(props.onAction).toHaveBeenLastCalledWith({ version: 1, action: "discover" });
  props.onAction.mockClear();
  fireEvent.click(screen.getByRole("button", { name: candidate.outcome }));
  expect(props.onSelectCandidate).toHaveBeenCalledWith("current", candidate.candidateId);
  expect(props.onAction).not.toHaveBeenCalled();
  expect(props.onRun).not.toHaveBeenCalled();
  const selected = programmaticChatReducer(props.state, { type: "select-candidate", source: "current", id: candidate.candidateId });
  view.rerender(<ProgrammaticChat {...props} state={selected} />);
  expect(document.querySelector("img")).toBeNull();
  expect(screen.getByText("Success check: Known mismatch reported")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Review a new capability" }));
  expect(props.onAction).toHaveBeenLastCalledWith({ version: 1, action: "review-candidate", intent: "review-only", source: "current",
    assessmentId: candidate.assessmentId, candidateId: candidate.candidateId, expectedRevision: 1 });
});
it.each(["manual", "needs-more-evidence", "reuse-command", "extend-command", "missing-capability"] as const)("shows honest %s detail and preserves it while refreshing", (choice) => {
  const props = fixture({ ...candidate, choice, alternatives: [], nextStep: { available: choice !== "manual", reason: "Review only" } });
  const selected = programmaticChatReducer(props.state, { type: "select-candidate", source: "current", id: candidate.candidateId });
  const { rerender } = render(<ProgrammaticChat {...props} state={selected} />);
  expect(screen.getByRole("region", { name: "Selected opportunity" })).toBeTruthy();
  const stale = { ...selected, candidateStale: true, discoveryStale: true, assessmentPending: true };
  rerender(<ProgrammaticChat {...props} state={stale} />);
  expect(screen.getByRole("heading", { name: candidate.outcome })).toBeTruthy();
  expect(screen.getByText(/Previous or historical evidence/)).toBeTruthy();
  if (choice === "manual") expect(screen.queryByRole("button", { name: "Keep this manual" })).toBeNull();
  else expect((screen.getByRole("button", { name: /^(Review existing automation|Review an extension|Review a new capability|Inspect missing evidence|Reinspect command \(read-only\))$/ }) as HTMLButtonElement).disabled).toBe(true);
});
it("does not claim existing coverage for legacy reuse without availability", () => {
  const props = fixture({ ...candidate, choice: "reuse-command" });
  render(<ProgrammaticChat {...props} />);
  expect(screen.queryByText("The identified needs have existing automation to review.")).toBeNull();
});
it.each(["reuse-command", "extend-command"] as const)("shows unavailable %s reasons without execution and offers only explicit reinspection", (choice) => {
  const reason = "Command identity/body changed or cannot be safely resolved at submission.";
  const item = { ...candidate, choice, availability: { status: "unavailable" as const, reason } };
  const props = fixture(item);
  const view = render(<ProgrammaticChat {...props} />);
  expect(screen.queryByText("The identified needs have existing automation to review.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: item.outcome }));
  expect(props.onAction).not.toHaveBeenCalled();
  expect(props.onRun).not.toHaveBeenCalled();
  const selected = programmaticChatReducer(props.state, { type: "select-candidate", source: "current", id: item.candidateId });
  view.rerender(<ProgrammaticChat {...props} state={selected} />);
  expect(screen.getByText(reason)).toBeTruthy();
  expect(screen.getByText("Command unavailable")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Reinspect command (read-only)" }));
  expect(props.onAction).toHaveBeenCalledExactlyOnceWith({ version: 1, action: "review-candidate", intent: "review-only", source: "current",
    assessmentId: item.assessmentId, candidateId: item.candidateId, expectedRevision: item.revision });
  expect(props.onRun).not.toHaveBeenCalled();
});
it("only summarizes current all-available reuse, not mixed or stale results", () => {
  const available: DiscoveryCandidate = { ...candidate, choice: "reuse-command", availability: { status: "available", reason: "Available at submission" } };
  const props = fixture(available);
  const { rerender } = render(<ProgrammaticChat {...props} />);
  const summary = "The identified needs have existing automation to review.";
  expect(screen.getByText(summary)).toBeTruthy();
  rerender(<ProgrammaticChat {...props} state={{ ...props.state, discoveryStale: true }} />);
  expect(screen.queryByText(summary)).toBeNull();
  rerender(<ProgrammaticChat {...props} state={{ ...props.state, discovery: { ...props.state.discovery, candidates: [available,
    { ...available, candidateId: candidate.assessmentId, outcome: "Other need", availability: { status: "unavailable", reason: "Deleted" } }] } }} />);
  expect(screen.queryByText(summary)).toBeNull();
});
it.each([undefined, { status: "reinspection-required" as const, reason: "Historical command availability has not been revalidated." },
  { status: "unavailable" as const, reason: "Command was deleted" }])("keeps legacy and historical availability inert: %j", (availability) => {
  const item: DiscoveryCandidate = { ...candidate, choice: "reuse-command", ...(availability ? { availability } : {}) };
  const props = fixture(item);
  const state = { ...props.state, selection: { source: "history" as const, id: item.candidateId }, candidateDetail: item, candidateStale: true };
  render(<ProgrammaticChat {...props} state={state} />);
  expect(screen.queryByText("The identified needs have existing automation to review.")).toBeNull();
  expect(screen.getByText(availability?.reason ?? "Command availability was not recorded. Fresh read-only inspection is required.")).toBeTruthy();
  const button = screen.getByRole("button", { name: "Reinspect command (read-only)" });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(button);
  expect(props.onAction).not.toHaveBeenCalled();
  expect(props.onRun).not.toHaveBeenCalled();
});
it("does not confuse empty completed discovery with legacy detail or disabled native support", () => {
  const props = fixture();
  const empty = { ...props.state, discovery: { ...props.state.discovery, candidates: [] } };
  const { rerender } = render(<ProgrammaticChat {...props} state={empty} />);
  expect(screen.getByText(/No worthwhile need was identified within the inspected scope/)).toBeTruthy();
  rerender(<ProgrammaticChat {...props} state={{ ...props.state, discovery: null }} />);
  expect(screen.getByText(/Candidate detail is unavailable/)).toBeTruthy();
  const unsupported = fixture({ ...candidate, nextStep: { available: false, reason: "Requires application development" } });
  rerender(<ProgrammaticChat {...unsupported} state={programmaticChatReducer(unsupported.state, { type: "select-candidate", source: "current", id: candidate.candidateId })} />);
  expect((screen.getByRole("button", { name: "Review a new capability" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("Requires application development")).toBeTruthy();
});
