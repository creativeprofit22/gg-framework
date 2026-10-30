// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
  isRecommendationDetail,
  isRecommendationHistoryReport,
  type DiscoveryCandidate,
  type RecommendationSummary,
} from "@kenkaiiii/gg-core/programmatic-recommendation-contract";
import {
  initialProgrammaticChatState,
  programmaticChatReducer,
  type ProgrammaticChatState,
} from "./programmatic-chat-state";
import { ProgrammaticChat } from "./ProgrammaticChat";
import { assessmentDisplay, discoveryResponse } from "./programmatic-discovery-state";
import { isProgrammaticAssessment } from "@kenkaiiii/gg-core/programmatic-assessment-contract";
import { emptyDiscoveryAssessment } from "./programmatic-empty-discovery.fixture";
import {
  areaAssessment,
  docsFind,
  finishSearch,
  liveAreas,
  progress,
  startSearch,
} from "./programmatic-area.fixture";
import { recommendationHistoryFixture } from "../scripts/recommendation-history-fixture.mjs";

afterEach(cleanup);
it.each(["saved", "acknowledgement-unknown"] as const)(
  "qualifies cached history after %s and reloads only read-only views",
  (status) => {
    const { detail } = recommendationHistoryFixture();
    const props = fixture();
    const report = {
      version: 1 as const,
      status: "ready" as const,
      revision: detail.historyRevision,
      offset: 0,
      total: 1,
      candidates: [detail.candidate],
    };
    expect(isRecommendationDetail(detail)).toBe(true);
    expect(isRecommendationHistoryReport(report)).toBe(true);
    const loaded = {
      ...props.state,
      historyReport: report,
      historyDetail: detail,
      selection: { source: "history" as const, id: detail.candidate.id },
      candidateDetail: detail.discovery ?? null,
      candidateStale: true,
    };
    const state = programmaticChatReducer(loaded, {
      type: "assessment",
      generation: "one",
      event: {
        sessionId: "session",
        conversationId: "chat",
        sequence: 1,
        phase: "completed",
        assessment: {
          version: 1,
          mode: "configured",
          status: "completed",
          summary: "Assessment completed",
          limitations: [],
          observations: [],
          coverage: [],
          deterministic: { status: "succeeded", enabledCount: 1, applicableCount: 1 },
          history:
            status === "saved"
              ? {
                  status,
                  assessmentId: candidate.assessmentId,
                  historyRevision: detail.historyRevision + 1,
                }
              : {
                  status,
                  assessmentId: candidate.assessmentId,
                  reason: "Save acknowledgement lost",
                },
        },
      },
    });
    const view = render(<ProgrammaticChat {...props} state={state} />);
    openPastIdeas();
    expect(screen.getByText(/This list may be out of date/)).toBeTruthy();
    expect(screen.getByText(/This past idea may be out of date/)).toBeTruthy();
    expect(props.onAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reload past ideas" }));
    fireEvent.click(screen.getByRole("button", { name: "Reload this idea" }));
    expect(props.onAction.mock.calls.map(([request]) => request)).toEqual([
      { version: 1, action: "history-report", offset: 0 },
      {
        version: 1,
        action: "history-detail",
        candidateId: detail.candidate.id,
        offset: detail.offset,
      },
    ]);
    expect(props.onRun).not.toHaveBeenCalled();
    expect(props.onSelectCandidate).not.toHaveBeenCalled();
    view.rerender(<ProgrammaticChat {...props} state={state} busy />);
    expect(
      (screen.getByRole("button", { name: "Reload past ideas" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Reload this idea",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  },
);
it.each(["dismissed", "completed"] as const)(
  "browses real correspondence to an off-page %s candidate without granting authority",
  (decision) => {
    const { detail, canonical } = recommendationHistoryFixture(decision);
    const canonicalId = canonical.candidate.id;
    expect(detail.candidate).toMatchObject({ decision: "open", canonicalId, observationCount: 1 });
    const before = JSON.stringify({ detail, canonical });
    const props = fixture();
    let state: ProgrammaticChatState = {
      ...initialProgrammaticChatState("one"),
      historyReport: {
        version: 1,
        status: "ready",
        revision: detail.historyRevision,
        offset: 50,
        total: 51,
        candidates: [detail.candidate],
      },
    };
    // Mirror AgentPane's id-only history selection path, including an ID outside the loaded page.
    props.onSelectCandidate.mockImplementation((source: "history", id: string) => {
      state = programmaticChatReducer(state, { type: "select-candidate", source, id });
      props.onAction({ version: 1, action: "history-detail", candidateId: id, offset: 0 });
      state = discoveryResponse(state, {
        version: 1,
        ok: true,
        action: "history-detail",
        detail: id === canonicalId ? canonical : detail,
      });
    });
    const view = render(<ProgrammaticChat {...props} state={state} />);
    openPastIdeas();
    expect(
      screen.getByText("Same as an earlier idea. See the earlier one for its status."),
    ).toBeTruthy();
    expect(screen.queryByText("open")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: detail.candidate.outcome }));
    view.rerender(<ProgrammaticChat {...props} state={state} />);
    expect(screen.getByText("Found in 1 search")).toBeTruthy();
    expect(screen.queryByText(/record, not an approval/)).toBeNull();
    expect(document.querySelector("b")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open the earlier idea" }));
    expect(props.onAction).toHaveBeenLastCalledWith({
      version: 1,
      action: "history-detail",
      candidateId: canonicalId,
      offset: 0,
    });
    view.rerender(<ProgrammaticChat {...props} state={state} />);
    expect(
      screen.getByText(
        decision === "completed" ? "Done: you handled this" : "Dismissed: you said no",
      ),
    ).toBeTruthy();
    expect(state.candidateStale).toBe(true);
    expect(props.onAction.mock.calls.map(([request]) => request.action)).toEqual([
      "history-detail",
      "history-detail",
    ]);
    expect(props.onRun).not.toHaveBeenCalled();
    expect(JSON.stringify({ detail, canonical })).toBe(before);
  },
);
/** Opens the header's Past ideas region; a past-idea selection has already opened it. */
function openPastIdeas() {
  const link = screen.getByRole("button", { name: "Past ideas" });
  if (link.getAttribute("aria-expanded") !== "true") fireEvent.click(link);
  const region = document.getElementById(link.getAttribute("aria-controls")!);
  expect(region?.hidden).toBe(false);
}
/** Shows one Opportunities step, as a user clicking its tab would. */
function openStep(label: "Quick checks" | "Find ideas" | "Review") {
  fireEvent.click(screen.getByRole("tab", { name: new RegExp(`^\\d\\s*${label}`) }));
}
it("distinguishes unresolved exact-workflow duplicates in both history and legacy detail", () => {
  const { detail } = recommendationHistoryFixture();
  const props = fixture();
  const state: ProgrammaticChatState = {
    ...initialProgrammaticChatState("one"),
    selection: { source: "history", id: detail.candidate.id },
    historyDetail: { ...detail, discovery: undefined },
    historyReport: {
      version: 1,
      status: "ready",
      revision: detail.historyRevision,
      offset: 0,
      total: 2,
      candidates: [detail.candidate],
    },
  };
  render(<ProgrammaticChat {...props} state={state} />);
  openPastIdeas();
  expect(screen.getAllByText("May repeat another idea.")).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "Open the earlier idea" })).toBeNull();
  expect(props.onAction).not.toHaveBeenCalled();
  expect(props.onRun).not.toHaveBeenCalled();
});
it.each([51, 100, 101])(
  "round-trips history pages with %i saved candidates without losing historical context",
  (total) => {
    const props = fixture();
    const candidates: RecommendationSummary[] = Array.from({ length: total }, (_, index) => ({
      id: `saved-${index}`,
      revision: 1,
      outcome: `Saved opportunity ${index}`,
      decision: "open",
      ambiguity: "none",
      observationCount: 1,
    }));
    const detail = {
      version: 1 as const,
      historyRevision: 1,
      candidate: candidates[0],
      offset: 0,
      total: 1,
      records: [],
      discovery: candidate,
    };
    let state: ProgrammaticChatState = {
      ...initialProgrammaticChatState("one"),
      historyDetail: detail,
    };
    state = programmaticChatReducer(state, {
      type: "select-candidate",
      source: "history",
      id: candidates[0].id,
    });
    const selected = state;
    const view = render(<ProgrammaticChat {...props} state={state} />);
    openPastIdeas();
    const showPage = (offset: number) => {
      state = discoveryResponse(state, {
        version: 1,
        ok: true,
        action: "history-report",
        report: {
          version: 1,
          status: "ready",
          revision: 1,
          total,
          offset,
          candidates: candidates.slice(offset, offset + 50),
        },
      });
      view.rerender(<ProgrammaticChat {...props} state={state} />);
      expect(state.selection).toBe(selected.selection);
      expect(state.historyDetail).toBe(detail);
      expect(state.candidateDetail).toBe(candidate);
      expect(state.candidateStale).toBe(true);
      const pastIdea = screen.getByRole("region", { name: "Selected idea" });
      expect(within(pastIdea).getByText("Needs a new command")).toBeTruthy();
      expect(within(pastIdea).getByText("Past idea")).toBeTruthy();
      expect(
        (screen.getByRole("button", { name: "Review this idea" }) as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(
        (screen.getByRole("button", { name: "Previous page" }) as HTMLButtonElement).disabled,
      ).toBe(offset === 0);
      expect(
        (screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement).disabled,
      ).toBe(offset + 50 >= total);
    };
    const navigate = (direction: "Next" | "Previous", offset: number) => {
      fireEvent.click(screen.getByRole("button", { name: `${direction} page` }));
      expect(props.onAction).toHaveBeenLastCalledWith({
        version: 1,
        action: "history-report",
        offset,
      });
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
  },
);
const candidate: DiscoveryCandidate = {
  assessmentId: "54df729b-2d8c-4a9f-abdc-ae6584a70742",
  candidateId: "ad5bb9ba-4d86-485a-8d74-613fe59b12df",
  revision: 1,
  choice: "missing-capability",
  outcome: "<img src=x onerror=alert(1)>",
  rationale: "Repeated records",
  uncertainty: "Sample only",
  workflow: {
    trigger: "Records change",
    representativeCase: "Record",
    inputs: ["Records"],
    currentProcess: ["Read records"],
    output: "Report",
    successCheck: "Known mismatch reported",
    scope: "Repository",
    mutationBoundary: "Read only",
    repeatability: { basis: "inferred", explanation: "Recurring structure" },
  },
  evidence: [{ basis: "assumed", message: "May recur", source: "Proposal" }],
  alternatives: [{ kind: "manual", reasonNotSelected: "Repeated effort" }],
  risks: ["Sample incomplete"],
  details: ["Inspect proposal only"],
  nextStep: { available: true, reason: "Creation needs separate approval" },
};
it("shows one complete task explanation and visible consequences before review", () => {
  const item = {
    ...candidate,
    outcome: "Check release notes against shipped changes",
    rationale:
      "Compare release notes with recent changes so missing user-facing fixes can be reviewed before release.",
    risks: ["The comparison may send selected project text to the configured provider."],
  };
  const props = fixture(item);
  const state = programmaticChatReducer(props.state, {
    type: "select-candidate",
    source: "current",
    id: item.candidateId,
  });
  render(<ProgrammaticChat {...props} state={state} />);
  expect(screen.getAllByText(item.rationale)).toHaveLength(1);
  expect(screen.getByText(item.risks[0]).closest("details")).toBeNull();
  // Readout rows: a term, then its value, outside the folded details.
  const readout = (term: string) => screen.getByText(term, { selector: "dt" }).nextElementSibling!;
  expect(readout("Your part").textContent).toBe(
    "Your call. Review the idea if you want this command made.",
  );
  expect(readout("Where?").textContent).toBe(item.workflow.scope);
  expect(readout("Where?").closest("details")).toBeNull();
  expect(readout("What would change?").textContent).toBe(item.workflow.mutationBoundary);
  expect(readout("What we're not sure about").textContent).toBe(item.uncertainty);
  expect(readout("What could go wrong?").textContent).toBe(item.risks[0]);
  // Pressing Review is explained before it is pressed.
  expect(
    screen.getByText("AI explains the exact change first. Nothing is changed or run."),
  ).toBeTruthy();
  expect(screen.getByText(item.details[0]).closest("details")).toBeNull();
  // The idea list stays visible; the selected card opens in place.
  expect(screen.getByRole("button", { name: item.outcome }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(screen.getAllByText("Needs a new command")).toHaveLength(1);
  const selectedRegion = screen.getByRole("region", { name: "Selected idea" });
  expect(within(selectedRegion).getByRole("heading", { name: item.outcome })).toBeTruthy();
  const technical = within(selectedRegion).getByText("More details").closest("details")!;
  expect(technical.open).toBe(false);
  expect(
    within(technical).getByText(`How to tell it worked: ${item.workflow.successCheck}`),
  ).toBeTruthy();
  // Receipt sources stay out of the readable list, inside a collapsed Technical details.
  const finding = within(technical).getByText(/^Assumed: May recur$/);
  expect(finding.textContent).not.toContain(item.evidence[0].source);
  const source = within(technical).getByText(item.evidence[0].source);
  expect(source.closest("details")!.querySelector("summary")!.textContent).toBe(
    "Technical details",
  );
  expect(source.closest("details")!.open).toBe(false);
  expect(props.onAction).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Review this idea" }));
  expect(props.onAction).toHaveBeenCalledExactlyOnceWith({
    version: 1,
    action: "review-candidate",
    intent: "review-only",
    source: "current",
    assessmentId: item.assessmentId,
    candidateId: item.candidateId,
    expectedRevision: item.revision,
  });
  expect(props.onRun).not.toHaveBeenCalled();
});

it("offers explicit fresh discovery for stale suggestions without retrying automatically", () => {
  const props = fixture();
  const selected = programmaticChatReducer(props.state, {
    type: "select-candidate",
    source: "current",
    id: candidate.candidateId,
  });
  render(
    <ProgrammaticChat
      {...props}
      state={{ ...selected, candidateStale: true, discoveryStale: true }}
    />,
  );
  expect(props.onAction).not.toHaveBeenCalled();
  expect(
    (screen.getByRole("button", { name: "Review this idea" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Search again" }));
  expect(props.onAction).toHaveBeenCalledExactlyOnceWith({ version: 1, action: "discover" });
});

function fixture(item = candidate) {
  const assessment = {
    version: 1 as const,
    mode: "setup" as const,
    status: "completed" as const,
    summary: "Scoped assessment",
    coverage: [],
    limitations: [],
    observations: [],
    deterministic: { status: "not-run" as const, reason: "setup" as const },
    discovery: { assessmentId: item.assessmentId, candidates: [item] },
  };
  const state = {
    ...initialProgrammaticChatState("one"),
    assessment,
    discovery: assessment.discovery,
  };
  return {
    state,
    busy: false,
    planMode: false,
    onAction: vi.fn(),
    onSelect: vi.fn(),
    onSelectCandidate: vi.fn(),
    onRun: vi.fn(),
  };
}
it.each(["prepared", "reinspection-required"] as const)(
  "retains and renders the returned %s summary through the response reducer",
  (status) => {
    const props = fixture();
    const selected = programmaticChatReducer(props.state, {
      type: "select-candidate",
      source: "current",
      id: candidate.candidateId,
    });
    const started = programmaticChatReducer(selected, {
      type: "start",
      generation: selected.generation,
      epoch: selected.epoch,
      operation: "review-candidate",
    });
    const candidateReview = {
      status,
      candidate,
      summary: `Host returned ${status}: <b>read only</b>.`,
    };
    const response = {
      version: 1 as const,
      action: "review-candidate" as const,
      ok: true as const,
      candidateReview,
    };
    const action = {
      type: "response" as const,
      generation: started.generation,
      epoch: started.epoch,
      response,
    };
    expect(programmaticChatReducer(started, { ...action, epoch: started.epoch - 1 })).toBe(started);
    expect(programmaticChatReducer(started, { ...action, generation: "retired-pane" })).toBe(
      started,
    );
    const settled = programmaticChatReducer(started, action);
    expect(settled.candidateReview).toEqual(candidateReview);
    expect(settled.selection).toEqual(selected.selection);
    render(<ProgrammaticChat {...props} state={settled} />);
    expect(
      within(screen.getByRole("region", { name: "Selected idea" })).getByText(
        candidateReview.summary,
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Different host result")).toBeNull();
    expect(document.querySelector('[aria-label="Selected idea"] b')).toBeNull();
    expect(props.onAction).not.toHaveBeenCalled();
    expect(props.onRun).not.toHaveBeenCalled();
  },
);

it("discovers without scanner setup, selects without submitting, and reviews only with a second explicit action", async () => {
  const props = fixture();
  const view = render(<ProgrammaticChat {...props} />);
  // Checks aren't saved, so step 1 is Next; Find ideas works from step 2 anyway.
  openStep("Find ideas");
  const discover = within(screen.getByRole("tabpanel")).getByRole("button", { name: "Find ideas" });
  discover.focus();
  expect(document.activeElement).toBe(discover);
  fireEvent.click(discover);
  expect(props.onAction).toHaveBeenLastCalledWith({ version: 1, action: "discover" });
  props.onAction.mockClear();
  openStep("Review");
  fireEvent.click(screen.getByRole("button", { name: candidate.outcome }));
  expect(props.onSelectCandidate).toHaveBeenCalledWith("current", candidate.candidateId);
  expect(props.onAction).not.toHaveBeenCalled();
  expect(props.onRun).not.toHaveBeenCalled();
  const selected = programmaticChatReducer(props.state, {
    type: "select-candidate",
    source: "current",
    id: candidate.candidateId,
  });
  view.rerender(<ProgrammaticChat {...props} state={selected} />);
  expect(document.querySelector("img")).toBeNull();
  expect(screen.getByText("How to tell it worked: Known mismatch reported")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Review this idea" }));
  expect(props.onAction).toHaveBeenLastCalledWith({
    version: 1,
    action: "review-candidate",
    intent: "review-only",
    source: "current",
    assessmentId: candidate.assessmentId,
    candidateId: candidate.candidateId,
    expectedRevision: 1,
  });
});
it.each([
  "manual",
  "needs-more-evidence",
  "reuse-command",
  "extend-command",
  "missing-capability",
  "generate-from-reference",
] as const)("shows honest %s detail and preserves it while refreshing", (choice) => {
  const props = fixture({
    ...candidate,
    choice,
    alternatives: [],
    nextStep: { available: choice !== "manual", reason: "Review only" },
  });
  const selected = programmaticChatReducer(props.state, {
    type: "select-candidate",
    source: "current",
    id: candidate.candidateId,
  });
  const { rerender } = render(<ProgrammaticChat {...props} state={selected} />);
  expect(screen.getByRole("region", { name: "Selected idea" })).toBeTruthy();
  const reviewName =
    choice === "generate-from-reference"
      ? "Review this idea"
      : choice === "reuse-command" || choice === "extend-command"
        ? "Check the command again"
        : "Review this idea";
  if (choice === "manual") {
    expect(screen.queryByRole("button", { name: reviewName })).toBeNull();
  } else {
    fireEvent.click(screen.getByRole("button", { name: reviewName }));
    expect(props.onAction).toHaveBeenCalledExactlyOnceWith({
      version: 1,
      action: "review-candidate",
      intent: "review-only",
      source: "current",
      assessmentId: candidate.assessmentId,
      candidateId: candidate.candidateId,
      expectedRevision: candidate.revision,
    });
  }
  expect(props.onRun).not.toHaveBeenCalled();
  const stale = {
    ...selected,
    candidateStale: true,
    discoveryStale: true,
    assessmentPending: true,
  };
  rerender(<ProgrammaticChat {...props} state={stale} />);
  expect(screen.getByRole("heading", { name: candidate.outcome })).toBeTruthy();
  expect(screen.getByText(/This idea is from an earlier search/)).toBeTruthy();
  if (choice === "manual") {
    expect(screen.queryByRole("button", { name: "Review this idea" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Check the command again" })).toBeNull();
  } else
    expect(
      (
        screen.getByRole("button", {
          name: reviewName,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
});
it("shows a generator suggestion in plain words and selecting it starts nothing", () => {
  const item: DiscoveryCandidate = {
    ...candidate,
    outcome: "Add new regions from one reference configuration",
    choice: "generate-from-reference",
    details: [
      "Example to copy: config/regions/us-east (looked at, not tested)",
      "config/regions/ap-south",
    ],
    nextStep: {
      available: true,
      reason:
        "Look over the plan. Nothing changes. Making, testing and running it each need your OK.",
    },
  };
  const props = fixture(item);
  const view = render(<ProgrammaticChat {...props} />);
  openStep("Review");
  fireEvent.click(screen.getByRole("button", { name: item.outcome }));
  expect(props.onSelectCandidate).toHaveBeenCalledExactlyOnceWith("current", item.candidateId);
  expect(props.onAction).not.toHaveBeenCalled();
  expect(props.onRun).not.toHaveBeenCalled();
  const selected = programmaticChatReducer(props.state, {
    type: "select-candidate",
    source: "current",
    id: item.candidateId,
  });
  view.rerender(<ProgrammaticChat {...props} state={selected} />);
  expect(screen.getAllByText("Build one then copy it").length).toBeGreaterThan(0);
  expect(screen.queryByText("Make one, copy the rest")).toBeNull();
  expect(screen.getByRole("button", { name: "Review this idea" })).toBeTruthy();
  expect(props.onAction).not.toHaveBeenCalled();
  expect(props.onRun).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toMatch(/fingerprint|digest|lifecycle/i);
});
it("retains user selection and focus through unrelated rerenders without automatic actions", () => {
  const props = fixture();
  const view = render(<ProgrammaticChat {...props} />);
  expect(props.onAction).not.toHaveBeenCalled();
  openStep("Review");
  fireEvent.click(screen.getByRole("button", { name: candidate.outcome }));
  expect(props.onSelectCandidate).toHaveBeenCalledExactlyOnceWith("current", candidate.candidateId);
  const selected = programmaticChatReducer(props.state, {
    type: "select-candidate",
    source: "current",
    id: candidate.candidateId,
  });
  view.rerender(<ProgrammaticChat {...props} state={selected} />);
  const target = document.querySelector("[data-programmatic-selection]");
  expect(document.activeElement).toBe(target);
  expect(screen.getByRole("button", { name: candidate.outcome }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  view.rerender(
    <ProgrammaticChat {...props} state={{ ...selected, notice: "Unrelated update" }} />,
  );
  expect(document.querySelector("[data-programmatic-selection]")).toBe(target);
  expect(document.activeElement).toBe(target);
  expect(screen.getAllByText(candidate.rationale)).toHaveLength(1);
  expect(props.onSelectCandidate).toHaveBeenCalledTimes(1);
  expect(props.onAction).not.toHaveBeenCalled();
  expect(props.onRun).not.toHaveBeenCalled();
});

it("keeps uncertain discovery inert with an explicit retry and original error details", () => {
  const props = fixture();
  const selected = programmaticChatReducer(props.state, {
    type: "select-candidate",
    source: "current",
    id: candidate.candidateId,
  });
  const error = "Transport failed <b>not confirmed</b>";
  render(
    <ProgrammaticChat
      {...props}
      state={{
        ...selected,
        assessmentUncertain: true,
        discoveryStale: true,
        candidateStale: true,
        error,
      }}
    />,
  );
  expect(screen.getByText(/We couldn't tell if the search finished/)).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toBe(
    "That didn't finish. Choose Try again when nothing else is running.",
  );
  const summary = screen.getByText("Error details");
  expect(summary.closest("details")!.open).toBe(false);
  fireEvent.click(summary);
  expect(screen.getByText(error)).toBeTruthy();
  expect(document.querySelector("b")).toBeNull();
  const review = screen.getByRole("button", { name: "Review this idea" }) as HTMLButtonElement;
  expect(review.disabled).toBe(true);
  fireEvent.click(review);
  expect(props.onAction).not.toHaveBeenCalled();
  expect(props.onRun).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Search again" }));
  expect(props.onAction).toHaveBeenCalledExactlyOnceWith({ version: 1, action: "discover" });
});

it("does not claim existing coverage for legacy reuse without availability", () => {
  const props = fixture({ ...candidate, choice: "reuse-command" });
  render(<ProgrammaticChat {...props} />);
  expect(screen.queryByText("You already have commands for everything found.")).toBeNull();
});
it.each(["reuse-command", "extend-command"] as const)(
  "shows unavailable %s reasons without execution and offers only explicit reinspection",
  (choice) => {
    const reason = "Command identity/body changed or cannot be safely resolved at submission.";
    const item = { ...candidate, choice, availability: { status: "unavailable" as const, reason } };
    const props = fixture(item);
    const view = render(<ProgrammaticChat {...props} />);
    expect(screen.queryByText("You already have commands for everything found.")).toBeNull();
    openStep("Review");
    fireEvent.click(screen.getByRole("button", { name: item.outcome }));
    expect(props.onAction).not.toHaveBeenCalled();
    expect(props.onRun).not.toHaveBeenCalled();
    const selected = programmaticChatReducer(props.state, {
      type: "select-candidate",
      source: "current",
      id: item.candidateId,
    });
    view.rerender(<ProgrammaticChat {...props} state={selected} />);
    expect(screen.getByText(reason)).toBeTruthy();
    expect(screen.getByText("Command not found")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check the command again" }));
    expect(props.onAction).toHaveBeenCalledExactlyOnceWith({
      version: 1,
      action: "review-candidate",
      intent: "review-only",
      source: "current",
      assessmentId: item.assessmentId,
      candidateId: item.candidateId,
      expectedRevision: item.revision,
    });
    expect(props.onRun).not.toHaveBeenCalled();
  },
);
it("only summarizes current all-available reuse, not mixed or stale results", () => {
  const available: DiscoveryCandidate = {
    ...candidate,
    choice: "reuse-command",
    availability: { status: "available", reason: "Available at submission" },
  };
  const props = fixture(available);
  const { rerender } = render(<ProgrammaticChat {...props} />);
  const summary = "You already have commands for everything found.";
  expect(screen.getByText(summary)).toBeTruthy();
  rerender(<ProgrammaticChat {...props} state={{ ...props.state, discoveryStale: true }} />);
  expect(screen.queryByText(summary)).toBeNull();
  rerender(
    <ProgrammaticChat
      {...props}
      state={{
        ...props.state,
        discovery: {
          ...props.state.discovery,
          candidates: [
            available,
            {
              ...available,
              candidateId: candidate.assessmentId,
              outcome: "Other need",
              availability: { status: "unavailable", reason: "Deleted" },
            },
          ],
        },
      }}
    />,
  );
  expect(screen.queryByText(summary)).toBeNull();
});
it.each([
  undefined,
  {
    status: "reinspection-required" as const,
    reason: "Historical command availability has not been revalidated.",
  },
  { status: "unavailable" as const, reason: "Command was deleted" },
])("keeps legacy and historical availability inert: %j", (availability) => {
  const item: DiscoveryCandidate = {
    ...candidate,
    choice: "reuse-command",
    ...(availability ? { availability } : {}),
  };
  const props = fixture(item);
  const state = {
    ...props.state,
    selection: { source: "history" as const, id: item.candidateId },
    candidateDetail: item,
    candidateStale: true,
  };
  render(<ProgrammaticChat {...props} state={state} />);
  expect(screen.queryByText("You already have commands for everything found.")).toBeNull();
  expect(
    screen.getByText(
      availability?.reason ?? "We don't know if this command still exists. Check it again.",
    ),
  ).toBeTruthy();
  const button = screen.getByRole("button", { name: "Check the command again" });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(button);
  expect(props.onAction).not.toHaveBeenCalled();
  expect(props.onRun).not.toHaveBeenCalled();
});
it.each([false, true])(
  "shows neutral empty results with visible host evidence (inspected=%s)",
  (inspected) => {
    const props = fixture();
    const assessment = emptyDiscoveryAssessment(inspected);
    expect(isProgrammaticAssessment(assessment)).toBe(true);
    const state = { ...props.state, ...assessmentDisplay(props.state, assessment) };
    render(<ProgrammaticChat {...props} state={state} />);
    expect(screen.getByText(/No ideas this time/)).toBeTruthy();
    expect(screen.queryByText(/No worthwhile need was identified/)).toBeNull();
    const assessmentRegion = screen.getByRole("region", { name: "Idea search" });
    const coverage = within(assessmentRegion).getByText("Details").closest("details");
    expect(coverage?.open).toBe(false);
    fireEvent.click(within(assessmentRegion).getByText("Details"));
    expect(coverage?.open).toBe(true);
    expect(
      within(coverage!).getByText(
        `Your project: ${inspected ? "Checked" : "Not checked"} — ${assessment.coverage[1].summary}`,
      ),
    ).toBeTruthy();
    expect(screen.getByText(assessment.limitations[0])).toBeTruthy();
    expect(props.onAction).not.toHaveBeenCalled();
    expect(props.onRun).not.toHaveBeenCalled();
  },
);
it.each(["incomplete", "cancelled", "refreshing"] as const)(
  "does not present retained empty results as current after %s",
  (status) => {
    const props = fixture();
    const assessment = emptyDiscoveryAssessment(true);
    expect(isProgrammaticAssessment(assessment)).toBe(true);
    const current = { ...props.state, ...assessmentDisplay(props.state, assessment) };
    const interrupted = { ...assessment };
    delete interrupted.discovery;
    const state =
      status === "refreshing"
        ? programmaticChatReducer(current, {
            type: "assessment",
            generation: "one",
            event: {
              sessionId: "session",
              conversationId: "chat",
              sequence: 1,
              phase: "started",
            },
          })
        : { ...current, ...assessmentDisplay(current, { ...interrupted, status }) };
    expect(isProgrammaticAssessment(state.assessment)).toBe(true);
    render(<ProgrammaticChat {...props} state={state} />);
    expect(screen.queryByText(/No ideas this time/)).toBeNull();
    expect(screen.queryByText(/No worthwhile need was identified/)).toBeNull();
    expect(screen.getByText(/These ideas are from an earlier search/)).toBeTruthy();
    expect(
      screen.getByText(
        `Idea search: ${status === "refreshing" ? "Done" : status === "cancelled" ? "Stopped" : "Not finished"}`,
      ),
    ).toBeTruthy();
  },
);
it("does not confuse empty completed discovery with legacy detail or disabled native support", () => {
  const props = fixture();
  const empty = { ...props.state, discovery: { ...props.state.discovery, candidates: [] } };
  const { rerender } = render(<ProgrammaticChat {...props} state={empty} />);
  expect(screen.getByText(/No ideas this time/)).toBeTruthy();
  rerender(<ProgrammaticChat {...props} state={{ ...props.state, discovery: null }} />);
  expect(screen.getByText(/Ideas from this search can't be shown/)).toBeTruthy();
  const unsupported = fixture({
    ...candidate,
    nextStep: { available: false, reason: "This needs a change to the GG app itself" },
  });
  rerender(
    <ProgrammaticChat
      {...unsupported}
      state={programmaticChatReducer(unsupported.state, {
        type: "select-candidate",
        source: "current",
        id: candidate.candidateId,
      })}
    />,
  );
  expect(
    (screen.getByRole("button", { name: "Review this idea" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(
    screen.getByText("Why you can't review it: This needs a change to the GG app itself"),
  ).toBeTruthy();
});

it("shows early finds as plain Still checking cards until the final ideas replace them", () => {
  const props = fixture();
  let state = progress(startSearch(props.state), "areas", liveAreas("reading", "waiting"));
  const { rerender } = render(<ProgrammaticChat {...props} state={state} />);
  openStep("Review");
  const early = () => screen.queryByRole("region", { name: "Early finds" });
  const section = early()!;
  expect(within(section).getByText(docsFind.need)).toBeTruthy();
  expect(within(section).getByText("Still checking")).toBeTruthy();
  expect(within(section).getByText(docsFind.where)).toBeTruthy();
  expect(within(section).getByText(docsFind.unsure)).toBeTruthy();
  expect(within(section).getByText(/These become ideas you can review/)).toBeTruthy();
  // Never reviewable: nothing inside can be pressed or selected.
  expect(within(section).queryByRole("button")).toBeNull();
  expect(section.querySelector("a, input, [tabindex]")).toBeNull();
  // The coverage line waits for the finished search.
  expect(screen.queryByText(/areas fully/)).toBeNull();
  state = finishSearch(state, areaAssessment("completed", [candidate]));
  rerender(<ProgrammaticChat {...props} state={state} />);
  expect(early()).toBeNull();
  expect(screen.getByText(candidate.outcome)).toBeTruthy();
  expect(screen.getByText("Read 1 of 3 areas fully. 1 read partly. 1 not read.")).toBeTruthy();
  expect(props.onAction).not.toHaveBeenCalled();
});

it("keeps early finds labelled Stopped before checking after Stop, and hides them after an empty finish", () => {
  const props = fixture();
  const running = progress(startSearch(props.state), "areas", liveAreas("reading", "waiting"));
  const stopped = finishSearch(
    progress(running, "areas", liveAreas("stopped", "stopped")),
    areaAssessment("cancelled", null),
  );
  const { rerender } = render(<ProgrammaticChat {...props} state={stopped} />);
  openStep("Review");
  const section = screen.getByRole("region", { name: "Early finds" });
  expect(within(section).getByText(/Stopped before checking/)).toBeTruthy();
  expect(within(section).getByText(docsFind.need)).toBeTruthy();
  expect(within(section).queryByRole("button")).toBeNull();
  const empty = finishSearch(running, areaAssessment("completed", []));
  rerender(<ProgrammaticChat {...props} state={empty} />);
  expect(screen.queryByRole("region", { name: "Early finds" })).toBeNull();
  expect(props.onAction).not.toHaveBeenCalled();
});
