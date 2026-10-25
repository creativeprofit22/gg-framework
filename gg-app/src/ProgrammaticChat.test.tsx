// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProgrammaticAssessment } from "@kenkaiiii/gg-core/programmatic-assessment-contract";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ProgrammaticChat, ProgrammaticExecutionEvidenceView } from "./ProgrammaticChat";
import {
  initialProgrammaticChatState,
  programmaticChatReducer,
  type ProgrammaticChatState,
} from "./programmatic-chat-state";
const hash = "a".repeat(64);
const savedConfiguration = {
  status: "current" as const,
  currentFingerprint: hash,
  refreshAvailable: false,
  baselineUnavailable: false,
  diagnostic: null,
  drift: null,
};
const assessmentLabels = {
  completed: "Done",
  incomplete: "Not finished",
  cancelled: "Stopped",
  unavailable: "Not available",
};
const checkLabels = {
  succeeded: "Done",
  "not-run": "Not run",
  failed: "Failed",
  denied: "Not allowed",
  cancelled: "Stopped",
  unavailable: "Not available",
};
function openSavedResults() {
  const summary = screen.queryByText(/Show all results \(\d+\)/);
  if (summary && !summary.closest("details")!.open) fireEvent.click(summary);
}
/** Shows one Opportunities step, as a user clicking its tab would. */
function openStep(label: "Quick checks" | "Find ideas" | "Review") {
  fireEvent.click(screen.getByRole("tab", { name: new RegExp(`^\\d\\s*${label}`) }));
}
/** Queries inside the step on screen; hidden steps are not accessible. */
const shownStep = () => within(screen.getByRole("tabpanel"));
const selectedStep = () =>
  screen.getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "true")
    ?.textContent;
function openAssessmentDetails() {
  const region = screen.getByRole("region", { name: "Idea search" });
  const summary = within(region).getByText("Details");
  if (!summary.closest("details")!.open) fireEvent.click(summary);
}
describe.each([false, true])("assessment refresh (transport interrupted: %s)", (interrupted) => {
  it.each(["incomplete", "cancelled", "unavailable", "completed"] as const)(
    "shows delivered %s assessment as current while retaining stale candidate detail",
    (status) => {
      const candidate = {
        assessmentId: "old",
        candidateId: "candidate",
        revision: 1,
        choice: "missing-capability" as const,
        outcome: "Read records",
        rationale: "Repeated",
        uncertainty: "Sample only",
        workflow: {
          trigger: "Change",
          representativeCase: "Record",
          inputs: [],
          currentProcess: [],
          output: "Report",
          successCheck: "Known issue found",
          scope: "Repository",
          mutationBoundary: "Read-only",
          repeatability: { basis: "inferred" as const, explanation: "Recurring records" },
        },
        evidence: [],
        alternatives: [],
        risks: [],
        details: [],
        nextStep: { available: true, reason: "Review only" },
      };
      const assessment: ProgrammaticAssessment = {
        version: 1,
        mode: "setup",
        status: "completed",
        summary: "Old assessment",
        limitations: [],
        coverage: [],
        observations: [],
        deterministic: { status: "not-run", reason: "setup" },
        discovery: { assessmentId: candidate.assessmentId, candidates: [candidate] },
      };
      const identity = {
        sessionId: "session",
        conversationId: "chat",
        requestId: "refresh",
        sequence: 2,
      };
      let state = programmaticChatReducer(initialProgrammaticChatState("one"), {
        type: "assessment",
        generation: "one",
        event: { ...identity, sequence: 1, phase: "completed", assessment },
      });
      state = programmaticChatReducer(state, {
        type: "select-candidate",
        source: "current",
        id: candidate.candidateId,
      });
      const { props, rerender } = fixture(state);
      const show = () => rerender(<ProgrammaticChat {...props} state={state} />);
      state = programmaticChatReducer(state, {
        type: "start",
        generation: "one",
        epoch: 1,
        operation: "discover",
        assessmentRequest: identity,
      });
      show();
      expect(screen.getByText(/This is an older search, kept for reference/)).toBeTruthy();
      state = programmaticChatReducer(state, {
        type: "assessment",
        generation: "one",
        event: { ...identity, phase: "started" },
      });
      show();
      expect(screen.getByText("Old assessment")).toBeTruthy();
      expect(screen.getByText(/This is an older search, kept for reference/)).toBeTruthy();
      if (interrupted) {
        state = programmaticChatReducer(state, {
          type: "error",
          generation: "one",
          epoch: 1,
          error: "Transport lost",
          reconcile: false,
        });
        show();
        expect(screen.getByText(/This is an older search, kept for reference/)).toBeTruthy();
      }
      const current = {
        ...assessment,
        status,
        summary: `Current ${status} assessment`,
        discovery: undefined,
      };
      state = programmaticChatReducer(state, {
        type: "assessment",
        generation: "one",
        event: { ...identity, phase: "completed", assessment: current },
      });
      state = programmaticChatReducer(state, {
        type: "response",
        generation: "one",
        epoch: 1,
        response: { version: 1, action: "discover", ok: true, assessment: current },
      });
      show();
      expect(
        screen.getByRole("heading", { name: `Idea search: ${assessmentLabels[status]}` }),
      ).toBeTruthy();
      expect(screen.getByText(current.summary)).toBeTruthy();
      expect(screen.queryByText(/This is an older search, kept for reference/)).toBeNull();
      expect(screen.getByText(/This idea is from an earlier search/)).toBeTruthy();
      expect(screen.getByText("How to tell it worked: Known issue found")).toBeTruthy();
      expect(
        (screen.getByRole("button", { name: "Review this idea" }) as HTMLButtonElement).disabled,
      ).toBe(true);
    },
  );
});
afterEach(cleanup);
it("renders execution evidence as inert text, not markup or clickable citations", () => {
  const message = "<b>Specialist claim</b> [citation](https://example.invalid)";
  const { container } = render(
    <ProgrammaticExecutionEvidenceView
      items={[
        {
          basis: "assumed",
          source: "programmatic-execution",
          code: "test",
          severity: "error",
          message,
        },
      ]}
    />,
  );
  expect(screen.getByText(message)).toBeTruthy();
  expect(screen.getByText("Assumed")).toBeTruthy();
  expect(screen.getByText("Error:")).toBeTruthy();
  expect(container.querySelector("b, a, script, iframe, img")).toBeNull();
});
function fixture(overrides: Partial<ProgrammaticChatState> = {}) {
  const summary = {
    id: hash,
    expectedOutput: "Review app packaging",
    state: "discovered" as const,
    presence: "present" as const,
    mutationPaths: [],
    actions: {
      run: { available: true, reason: "Can run." },
      dismiss: { available: true, reason: "Can dismiss." },
    },
    route: {
      available: true,
      command: "research" as const,
      reason: "Available",
      machineLocal: true,
    },
  };
  const state: ProgrammaticChatState = {
    ...initialProgrammaticChatState("one"),
    report: {
      status: "current",
      reason: "Current",
      scan: { available: true, reason: "Approved configuration is current." },
      snapshot: hash,
      fingerprint: hash,
      offset: 0,
      total: 1,
      rows: [summary],
    },
    selectedId: hash,
    detailSnapshot: hash,
    detail: {
      summary,
      trigger: "Manifest change",
      verification: "Read report",
      risks: [],
      evidence: [
        { basis: "observed", message: "Manifest exists", location: { path: "src/package.json" } },
      ],
      evidenceTruncated: false,
    },
    ...overrides,
  };
  const props = {
    state,
    busy: false,
    planMode: false,
    onAction: vi.fn(),
    onSelect: vi.fn(),
    onRun: vi.fn(),
  };
  return { props, ...render(<ProgrammaticChat {...props} />) };
}
it("keeps current setup compact and opens settings without saving or scanning", () => {
  const { props } = fixture({
    configuration: {
      status: "current",
      currentFingerprint: hash,
      refreshAvailable: false,
      baselineUnavailable: false,
      diagnostic: null,
      drift: null,
    },
  });
  expect(
    screen.queryByText(
      "Pick which checks to save. Discovery is available separately, without setup.",
    ),
  ).toBeNull();
  expect(props.onAction).not.toHaveBeenCalled();
  // Saved checks are done, so the setup button lives on step 1, not on the header key.
  openStep("Quick checks");
  fireEvent.click(shownStep().getByRole("button", { name: "Show suggested checks" }));
  expect(props.onAction).toHaveBeenCalledExactlyOnceWith({ version: 1, action: "inspect-setup" });
  expect(props.onRun).not.toHaveBeenCalled();
});

it("shows exact optional history consent without adding candidate actions", () => {
  const { props } = fixture({
    proposalApprovable: true,
    proposal: {
      handle: hash,
      operation: "history-upgrade",
      fingerprint: hash,
      profileJson: '{"version":1,"scanners":[]}',
      routes: [],
      exclusions: [],
      configurationInputs: [],
      historyPolicy: { version: 1, enabled: true },
      expectedRecoveryDigest: null,
      configuration: {
        status: "current",
        currentFingerprint: hash,
        refreshAvailable: false,
        baselineUnavailable: false,
        diagnostic: null,
        drift: null,
      },
    },
  });
  expect(screen.getByText(/Ideas from future searches will be saved/)).toBeTruthy();
  expect(screen.getByText(/Choose Not now to keep your checks/)).toBeTruthy();
  expect(screen.getByLabelText("Exact history policy to save").textContent).toContain(
    '"enabled": true',
  );
  fireEvent.click(screen.getByRole("button", { name: "Save checks" }));
  expect(props.onAction).toHaveBeenCalledWith({
    version: 1,
    action: "approve-setup",
    proposalHandle: hash,
  });
});

describe("bounded project assessment (presentation only; no native IPC)", () => {
  const assessmentId = "12345678-1234-4234-8234-123456789abc";
  const reason = "<b>History storage unavailable</b> [details](https://example.invalid)";
  const cases: { history: ProgrammaticAssessment["history"]; label: string | null }[] = [
    {
      history: { status: "saved", assessmentId, historyRevision: 1 },
      label: "Past ideas: saved",
    },
    { history: { status: "disabled" }, label: "Past ideas: off" },
    {
      history: { status: "setup-not-saved" },
      label: "Past ideas: not saved during setup",
    },
    {
      history: { status: "unsaved", assessmentId, reason },
      label: "Past ideas: not saved",
    },
    {
      history: { status: "acknowledgement-unknown", assessmentId, reason },
      label: "Past ideas: not sure it saved",
    },
    { history: undefined, label: null },
  ];
  it.each(cases)(
    "shows independent history status $history.status without changing deterministic selection",
    ({ history, label }) => {
      const { props, rerender } = fixture();
      const assessment: ProgrammaticAssessment = {
        version: 1,
        mode: history?.status === "setup-not-saved" ? "setup" : "configured",
        status: "completed",
        summary: "Assessment finished.",
        limitations: [],
        coverage: [],
        observations: [],
        deterministic:
          history?.status === "setup-not-saved"
            ? { status: "not-run", reason: "setup" }
            : { status: "succeeded", enabledCount: 1, applicableCount: 1 },
        ...(history ? { history } : {}),
      };
      const state = programmaticChatReducer(props.state, {
        type: "assessment",
        generation: "one",
        event: {
          conversationId: "chat",
          sessionId: "session",
          sequence: 1,
          phase: "completed",
          assessment,
        },
      });
      rerender(<ProgrammaticChat {...props} state={state} />);
      expect(screen.getByRole("heading", { name: "Idea search: Done" })).toBeTruthy();
      openAssessmentDetails();
      openSavedResults();
      expect(
        screen.getByRole("heading", {
          name: `Checks: ${checkLabels[assessment.deterministic.status]}`,
        }),
      ).toBeTruthy();
      expect(state.report).toBe(props.state.report);
      expect(state.detail).toBe(props.state.detail);
      expect(state.selectedId).toBe(hash);
      expect(
        screen.getByRole("button", { name: /Review app packaging/ }).getAttribute("aria-pressed"),
      ).toBe("true");
      const section = screen.queryByRole("region", { name: "Past ideas" });
      if (label) {
        expect(section).not.toBeNull();
        expect(within(section!).getByRole("heading", { name: label })).toBeTruthy();
        expect(section!.closest("details")!.open).toBe(true);
        expect(section!.querySelector("button, a, b, script, iframe, img")).toBeNull();
      } else expect(section).toBeNull();
      if (history && "reason" in history) {
        expect(within(section!).getByText(reason).textContent).toBe(reason);
      }
      if (history?.status === "acknowledgement-unknown") {
        expect(
          screen.getByText(
            "We're not sure these ideas were saved. Open Past ideas to check. Don't search again just to save them.",
          ),
        ).toBeTruthy();
        expect(section!.textContent).not.toMatch(/rolled back|not saved/i);
      }
      expect(props.onAction).not.toHaveBeenCalled();
      expect(props.onRun).not.toHaveBeenCalled();
    },
  );
  it.each(["completed", "incomplete", "unavailable", "cancelled"] as const)(
    "separates %s assessment from zero deterministic coverage without execution controls",
    (status) => {
      const { container } = fixture({
        report: null,
        detail: null,
        selectedId: null,
        assessment: {
          version: 1,
          mode: "configured",
          status,
          summary: "Documentation suggests missing workflow guidance.",
          limitations: ["Unfamiliar source was not inspected."],
          coverage: [
            { scope: "project", status: "budget-limited", summary: "Only documentation was read." },
          ],
          observations: [
            {
              basis: "inferred",
              message: "Transcript-only detailed observation",
              evidenceSources: ["receipt"],
            },
          ],
          deterministic: { status: "succeeded", enabledCount: 0, applicableCount: 0 },
        },
      });
      expect(
        screen.getByRole("heading", { name: `Idea search: ${assessmentLabels[status]}` }),
      ).toBeTruthy();
      expect(screen.getByText("Documentation suggests missing workflow guidance.")).toBeTruthy();
      expect(screen.getByText("Unfamiliar source was not inspected.")).toBeTruthy();
      openAssessmentDetails();
      expect(screen.getByText(/Your project: Partly checked/)).toBeTruthy();
      expect(screen.getByText(/0 checks set up, 0 applied/)).toBeTruthy();
      expect(screen.getByText(/None of your checks applied/)).toBeTruthy();
      expect(
        screen.getByText("Unfamiliar source was not inspected.").closest("details"),
      ).toBeNull();
      expect(screen.queryByText(/not a clean bill of health/)).toBeNull();
      expect(screen.queryByText("Transcript-only detailed observation")).toBeNull();
      expect(screen.queryByRole("button", { name: /Run|Review and run/ })).toBeNull();
      expect(screen.queryByRole("navigation", { name: "Opportunity sections" })).toBeNull();
      expect(container.querySelectorAll("a")).toHaveLength(0);
    },
  );
  it.each(["failed", "denied", "cancelled", "unavailable"] as const)(
    "does not hide %s scanner outcome behind completed advice",
    (status) => {
      fixture({
        assessment: {
          version: 1,
          mode: "configured",
          status: "completed",
          summary: "Limited advice is available.",
          limitations: [],
          coverage: [],
          observations: [],
          deterministic: { status, reason: "Checks did not complete." },
        },
      });
      openAssessmentDetails();
      expect(screen.getByRole("heading", { name: `Checks: ${checkLabels[status]}` })).toBeTruthy();
      expect(screen.getByText("Checks did not complete.")).toBeTruthy();
    },
  );
});

describe("opportunities tabs", () => {
  it("follows results that load after opening until the user picks a step", () => {
    const { props, rerender } = fixture();
    const loaded = { ...props.state, detail: null, selectedId: null, selection: null };
    rerender(<ProgrammaticChat {...props} state={{ ...loaded, report: null }} />);
    expect(selectedStep()).toMatch(/^1\s*Quick checks/);
    // Saved checks arrive later: the shown step moves on to the new Next step.
    const saved = {
      ...loaded,
      report: { ...loaded.report!, configuration: savedConfiguration },
    };
    rerender(<ProgrammaticChat {...props} state={saved} />);
    expect(selectedStep()).toMatch(/^2\s*Find ideas/);
    // A check result selection opens Review.
    rerender(<ProgrammaticChat {...props} state={{ ...saved, selectedId: hash }} />);
    expect(selectedStep()).toMatch(/^3\s*Review/);
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
    openStep("Quick checks");
    rerender(
      <ProgrammaticChat
        {...props}
        state={{ ...saved, selectedId: hash, notice: "Unrelated update" }}
      />,
    );
    expect(selectedStep()).toMatch(/^1\s*Quick checks/);
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
    // A new selection takes the step back to Review.
    rerender(<ProgrammaticChat {...props} state={{ ...saved, selectedId: "b".repeat(64) }} />);
    expect(selectedStep()).toMatch(/^3\s*Review/);
    expect(props.onAction).not.toHaveBeenCalled();
  });
  it("moves between steps with arrows, Home and End without changing which step is Next", () => {
    fixture({ selectedId: null, detail: null });
    const tabs = screen.getAllByRole("tab");
    // Steps are native buttons, so Enter and Space activate them like a click.
    for (const tab of tabs) expect(tab.tagName).toBe("BUTTON");
    const press = (from: number, key: string, to: number) => {
      fireEvent.keyDown(tabs[from]!, { key });
      expect(document.activeElement).toBe(tabs[to]);
      expect(tabs[to]!.getAttribute("aria-selected")).toBe("true");
    };
    tabs[0]!.focus();
    press(0, "ArrowRight", 1);
    press(1, "End", 2);
    press(2, "ArrowRight", 0);
    press(0, "ArrowLeft", 2);
    press(2, "Home", 0);
    expect(tabs.map((tab) => tab.getAttribute("aria-current"))).toEqual(["step", null, null]);
    fireEvent.click(tabs[2]!);
    expect(shownStep().getByRole("region", { name: "Ready to run" })).toBeTruthy();
    expect(tabs.map((tab) => tab.getAttribute("aria-current"))).toEqual(["step", null, null]);
  });
  it("marks the shown step busy only while results load, and words drifted checks", () => {
    const { props, rerender } = fixture({ selectedId: null, detail: null });
    expect(screen.getByRole("tabpanel").hasAttribute("aria-busy")).toBe(false);
    rerender(<ProgrammaticChat {...props} state={{ ...props.state, operation: "report" }} />);
    expect(screen.getByRole("tabpanel").getAttribute("aria-busy")).toBe("true");
    expect(document.querySelector(".opp-status")!.textContent).toBe("Loading…");
    rerender(
      <ProgrammaticChat
        {...props}
        state={{
          ...props.state,
          configuration: {
            ...savedConfiguration,
            status: "refresh-required",
            currentFingerprint: "b".repeat(64),
            refreshAvailable: true,
          },
        }}
      />,
    );
    expect(screen.getByRole("tabpanel").hasAttribute("aria-busy")).toBe(false);
    expect(document.querySelector(".opp-meta")!.textContent).toContain("Checks need updating");
  });
  it("points the header key at the Next step's action", () => {
    const key = () => document.querySelector<HTMLButtonElement>(".inst-key")!;
    const { props, rerender } = fixture({ selectedId: null, detail: null });
    // Brand-new: step 1 is Next, so the key shows the suggested checks.
    expect(key().textContent).toBe("Show suggested checks");
    fireEvent.click(key());
    expect(props.onAction).toHaveBeenLastCalledWith({ version: 1, action: "inspect-setup" });
    // An approvable setup review: the key saves it.
    const proposal = {
      handle: hash,
      operation: "initial" as const,
      configuration: { ...savedConfiguration, status: "missing" as const },
      fingerprint: hash,
      profileJson: "exact profile",
      routes: [],
      exclusions: [],
      configurationInputs: [],
    };
    rerender(
      <ProgrammaticChat
        {...props}
        state={{ ...props.state, proposal, proposalApprovable: true }}
      />,
    );
    expect(key().textContent).toBe("Save checks");
    fireEvent.click(key());
    expect(props.onAction).toHaveBeenLastCalledWith({
      version: 1,
      action: "approve-setup",
      proposalHandle: hash,
    });
    // Checks saved, no search yet: the key finds ideas.
    const saved = {
      ...props.state,
      report: { ...props.state.report!, configuration: savedConfiguration },
    };
    rerender(<ProgrammaticChat {...props} state={saved} />);
    expect(key().textContent).toBe("Find ideas");
    fireEvent.click(key());
    expect(props.onAction).toHaveBeenLastCalledWith({ version: 1, action: "discover" });
    // Plan mode and errors leave the steps alone and only disable the key.
    rerender(<ProgrammaticChat {...props} state={saved} planMode />);
    expect(key().disabled).toBe(true);
    expect(selectedStep()).toMatch(/^2\s*Find ideas/);
    rerender(<ProgrammaticChat {...props} state={{ ...saved, reconcile: true, error: "x" }} />);
    expect(key().disabled).toBe(true);
    expect(selectedStep()).toMatch(/^2\s*Find ideas/);
    // Ideas found: Review is Next and shown, so the key is a quiet Search again.
    const found = programmaticChatReducer(saved, {
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
          summary: "Search finished.",
          limitations: [],
          coverage: [],
          observations: [],
          deterministic: { status: "succeeded", enabledCount: 1, applicableCount: 1 },
          discovery: { assessmentId: "found", candidates: [] },
        },
      },
    });
    rerender(<ProgrammaticChat {...props} state={found} />);
    expect(selectedStep()).toMatch(/^3\s*Review/);
    expect(key().textContent).toBe("Search again");
    expect(key().hasAttribute("data-quiet")).toBe(true);
    // From another step the key opens Review and moves focus to its first group.
    openStep("Quick checks");
    expect(key().textContent).toBe("Open review");
    const calls = props.onAction.mock.calls.length;
    fireEvent.click(key());
    expect(props.onAction).toHaveBeenCalledTimes(calls);
    expect(selectedStep()).toMatch(/^3\s*Review/);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Ready to run" }));
  });
  it("lights step 1 again with Update checks after project files change, ending a skip", () => {
    // Skip under a known setup, so only the later drift may end it.
    const { props, rerender } = fixture({
      selectedId: null,
      detail: null,
      configuration: { ...savedConfiguration, status: "missing" },
    });
    fireEvent.click(shownStep().getByRole("button", { name: "Skip for now" }));
    expect(selectedStep()).toMatch(/^2\s*Find ideas/);
    expect(document.querySelector(".inst-key")!.textContent).toBe("Find ideas");
    const changed = {
      ...props.state,
      configuration: {
        ...savedConfiguration,
        status: "refresh-required" as const,
        currentFingerprint: "b".repeat(64),
        refreshAvailable: true,
      },
    };
    rerender(<ProgrammaticChat {...props} state={changed} />);
    const [checks] = screen.getAllByRole("tab");
    expect(checks!.getAttribute("aria-current")).toBe("step");
    expect(checks!.textContent).toBe("1 Quick checks → Next");
    expect(document.querySelector(".inst-key")!.textContent).toBe("Update checks");
    expect(props.onAction).not.toHaveBeenCalled();
  });
  it("opens Past ideas from the header, loads it once and returns focus on Close or Escape", () => {
    const { props, rerender } = fixture();
    const link = screen.getByRole("button", { name: "Past ideas" });
    const region = () => screen.queryByRole("region", { name: "Past ideas" });
    expect(link.getAttribute("aria-expanded")).toBe("false");
    expect(region()).toBeNull();
    fireEvent.click(link);
    expect(link.getAttribute("aria-expanded")).toBe("true");
    expect(link.getAttribute("aria-controls")).toBe(region()!.id);
    expect(props.onAction).toHaveBeenCalledExactlyOnceWith({
      version: 1,
      action: "history-report",
      offset: 0,
    });
    const loaded = {
      ...props.state,
      historyReport: {
        version: 1 as const,
        status: "ready" as const,
        revision: 1,
        offset: 0,
        total: 0,
        candidates: [],
      },
    };
    rerender(<ProgrammaticChat {...props} state={loaded} />);
    fireEvent.click(within(region()!).getByRole("button", { name: "Close" }));
    expect(region()).toBeNull();
    expect(document.activeElement).toBe(link);
    // Already loaded and current: opening again reads nothing new.
    fireEvent.click(link);
    expect(props.onAction).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(within(region()!).getByRole("button", { name: "Close" }), {
      key: "Escape",
    });
    expect(region()).toBeNull();
    expect(document.activeElement).toBe(link);
    // The shown step was never changed by Past ideas.
    expect(selectedStep()).toMatch(/^3\s*Review/);
  });
  it("loads Past ideas once the lock clears when opened while busy", () => {
    const { props, rerender } = fixture();
    rerender(<ProgrammaticChat {...props} busy />);
    fireEvent.click(screen.getByRole("button", { name: "Past ideas" }));
    expect(screen.queryByRole("region", { name: "Past ideas" })).not.toBeNull();
    expect(props.onAction).not.toHaveBeenCalled();
    rerender(<ProgrammaticChat {...props} busy={false} />);
    expect(props.onAction).toHaveBeenCalledExactlyOnceWith({
      version: 1,
      action: "history-report",
      offset: 0,
    });
    rerender(<ProgrammaticChat {...props} busy={false} />);
    expect(props.onAction).toHaveBeenCalledTimes(1);
  });
});

describe("embedded opportunity review", () => {
  it.each([true, false])(
    "keeps inspection available while another pane owns a run (owner visible: %s)",
    (ownerVisible) => {
      const { props, rerender } = fixture();
      const blocked = { available: false, reason: "An opportunity is running in this project." };
      const summary = {
        ...props.state.detail!.summary,
        actions: { run: blocked, dismiss: blocked },
      };
      const owner = {
        ...summary,
        id: "b".repeat(64),
        state: "running" as const,
        expectedOutput: "Other pane's run",
      };
      const report = {
        ...props.state.report!,
        total: 51,
        scan: blocked,
        rows: ownerVisible ? [summary, owner] : [summary],
      };
      const state = { ...props.state, report, detail: { ...props.state.detail!, summary } };
      rerender(<ProgrammaticChat {...props} state={state} />);
      for (const name of ["Review and run", "Dismiss", "Check again"]) {
        const button = screen.getByRole("button", { name }) as HTMLButtonElement;
        expect(button.disabled).toBe(true);
        expect(button.title).toBe(blocked.reason);
        fireEvent.click(button);
      }
      expect(props.onRun).not.toHaveBeenCalled();
      expect(props.onAction).not.toHaveBeenCalled();
      openSavedResults();
      for (const name of ["Show suggested checks", "Next page", /Review app packaging/])
        expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(false);
      expect(screen.queryByRole("button", { name: "Refresh results" })).toBeNull();
      openSavedResults();
      fireEvent.click(screen.getByRole("button", { name: /Review app packaging/ }));
      expect(props.onSelect).toHaveBeenCalledWith(hash);
      fireEvent.click(screen.getByText("Why this came up"));
      expect(screen.getByText("Manifest exists")).toBeTruthy();
      let fresh = programmaticChatReducer(state, {
        type: "response",
        generation: "one",
        epoch: 0,
        response: {
          version: 1,
          action: "report",
          ok: true,
          report: { ...props.state.report!, snapshot: "c".repeat(64) },
        },
      });
      rerender(<ProgrammaticChat {...props} state={fresh} />);
      expect(
        (screen.getByRole("button", { name: "Review and run" }) as HTMLButtonElement).disabled,
      ).toBe(true);
      fresh = programmaticChatReducer(fresh, {
        type: "response",
        generation: "one",
        epoch: 0,
        response: {
          version: 1,
          action: "detail",
          ok: true,
          snapshot: "c".repeat(64),
          detail: props.state.detail,
        },
      });
      rerender(<ProgrammaticChat {...props} state={fresh} />);
      for (const name of ["Review and run", "Dismiss", "Check again"])
        expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(false);
    },
  );
  it("keeps Previous reachable for an empty recovered tail and never renders an inverted range", () => {
    const { props, rerender } = fixture();
    const state = {
      ...props.state,
      report: {
        ...props.state.report!,
        status: "recovered" as const,
        offset: 1,
        total: 1,
        rows: [],
      },
    };
    rerender(<ProgrammaticChat {...props} state={state} />);
    expect(screen.queryByText("2–1 of 1")).toBeNull();
    expect(screen.getByText("No results on this page (1 total).")).toBeTruthy();
    const previous = screen.getByRole("button", { name: "Previous page" });
    expect((previous as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(previous);
    expect(props.onAction).toHaveBeenCalledExactlyOnceWith({
      version: 1,
      action: "report",
      offset: 0,
    });
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onRun).not.toHaveBeenCalled();
  });

  it.each([
    { oldOffset: 50, total: 1, offset: 0 },
    { oldOffset: 50, total: 0, offset: 0 },
    { oldOffset: 100, total: 51, offset: 50 },
  ])(
    "keeps selection while a page at $oldOffset recovers to $total records",
    ({ oldOffset, total, offset }) => {
      const { props, rerender } = fixture();
      const selected = props.state.detail!;
      let state: ProgrammaticChatState = {
        ...props.state,
        report: { ...props.state.report!, offset: oldOffset, total: 151 },
      };
      rerender(<ProgrammaticChat {...props} state={state} />);
      // Results reload by themselves; there is no manual refresh control.
      expect(screen.queryByRole("button", { name: "Refresh results" })).toBeNull();
      const survivor = {
        ...selected.summary,
        id: "b".repeat(64),
        expectedOutput: "Surviving opportunity",
      };
      state = programmaticChatReducer(state, {
        type: "response",
        generation: "one",
        epoch: 0,
        response: {
          version: 1,
          action: "report",
          ok: true,
          report: {
            ...state.report!,
            status: "recovered",
            snapshot: "c".repeat(64),
            offset,
            total,
            rows: total ? [survivor] : [],
          },
        },
      });
      expect(state.selectedId).toBe(hash);
      expect(state.detail).toBe(selected);
      state = programmaticChatReducer(state, {
        type: "response",
        generation: "one",
        epoch: 0,
        response: {
          version: 1,
          action: "detail",
          ok: true,
          snapshot: "c".repeat(64),
          detail: null,
        },
      });
      rerender(<ProgrammaticChat {...props} state={state} />);
      expect(state.selectedId).toBe(hash);
      expect(screen.getByText(/Pick another one/)).toBeTruthy();
      openSavedResults();
      if (total)
        expect(
          screen
            .getByRole("button", { name: /Surviving opportunity/ })
            .getAttribute("aria-pressed"),
        ).toBe("false");
      else expect(screen.getByText(/No results yet/)).toBeTruthy();
      if (total > 50) {
        expect(screen.getByText("51–51 of 51")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
        expect(props.onAction).toHaveBeenLastCalledWith({
          version: 1,
          action: "report",
          offset: 0,
        });
      } else expect(screen.queryByRole("navigation", { name: "Result pages" })).toBeNull();
      expect(props.onAction.mock.calls.every(([request]) => request.action === "report")).toBe(
        true,
      );
      expect(props.onSelect).not.toHaveBeenCalled();
      expect(props.onRun).not.toHaveBeenCalled();
    },
  );
  it("enables only explicitly approved refresh scans while keeping execution blocked", () => {
    const { props, rerender } = fixture();
    const stale = {
      ...props.state,
      report: {
        ...props.state.report!,
        status: "stale" as const,
        scan: { available: false, reason: "Approve current setup." },
      },
    };
    rerender(<ProgrammaticChat {...props} state={stale} />);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(props.onAction).not.toHaveBeenCalled();
    const approved = {
      ...stale,
      report: {
        ...stale.report,
        scan: { available: true, reason: "Approved configuration is current." },
      },
    };
    rerender(<ProgrammaticChat {...props} state={approved} />);
    expect(
      (screen.getByRole("button", { name: "Check again" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (screen.getByRole("button", { name: "Review and run" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(props.onAction).toHaveBeenCalledExactlyOnceWith({ version: 1, action: "scan" });
    for (const locks of [
      { busy: true },
      { planMode: true },
      { state: { ...approved, reconcile: true } },
      { state: { ...approved, operation: "scan" as const } },
    ]) {
      rerender(<ProgrammaticChat {...props} state={approved} {...locks} />);
      expect(
        (screen.getByRole("button", { name: "Check again" }) as HTMLButtonElement).disabled,
      ).toBe(true);
    }
  });
  it("retains selected ID and detail through scan acknowledgement and fresh hydration", () => {
    const { props, rerender } = fixture();
    const detail = props.state.detail!;
    let state = {
      ...props.state,
      report: { ...props.state.report!, status: "stale" as const },
    } as ProgrammaticChatState;
    state = programmaticChatReducer(state, {
      type: "start",
      generation: "one",
      epoch: 1,
      operation: "scan",
    });
    state = programmaticChatReducer(state, {
      type: "response",
      generation: "one",
      epoch: 1,
      response: { version: 1, action: "scan", ok: true, changed: true },
    });
    expect(state.selectedId).toBe(hash);
    expect(state.detail).toBe(detail);
    const snapshot = "b".repeat(64);
    state = programmaticChatReducer(state, {
      type: "response",
      generation: "one",
      epoch: 1,
      response: {
        version: 1,
        action: "report",
        ok: true,
        report: { ...props.state.report!, snapshot },
      },
    });
    rerender(<ProgrammaticChat {...props} state={state} />);
    expect(
      (screen.getByRole("button", { name: "Review and run" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    state = programmaticChatReducer(state, {
      type: "response",
      generation: "one",
      epoch: 1,
      response: { version: 1, action: "detail", ok: true, snapshot, detail },
    });
    rerender(<ProgrammaticChat {...props} state={state} />);
    expect(state.selectedId).toBe(hash);
    expect(state.detail).toBe(detail);
    expect(
      (screen.getByRole("button", { name: "Review and run" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
  it("keeps selection separate from run, exposes evidence and one-record dismissal", () => {
    const { props } = fixture();
    openSavedResults();
    fireEvent.click(screen.getByRole("button", { name: /Review app packaging/ }));
    expect(props.onSelect).toHaveBeenCalledWith(hash);
    expect(props.onRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Why this came up"));
    expect(screen.getByText("src/package.json")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review and run" }));
    expect(props.onRun).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(props.onAction).toHaveBeenCalledWith({
      version: 1,
      action: "dismiss",
      id: hash,
      snapshot: hash,
    });
  });
  it("shows exact refresh reasons, retains old detail and requires explicit refresh approval", () => {
    const configuration = {
      status: "refresh-required" as const,
      currentFingerprint: "b".repeat(64),
      refreshAvailable: true,
      baselineUnavailable: false,
      diagnostic: null,
      drift: {
        files: [
          { path: "package.json", kind: "modified" as const, before: hash, after: "b".repeat(64) },
        ],
        policy: null,
        schema: null,
        exclusions: null,
      },
    };
    const { props, rerender } = fixture();
    const report = {
      ...props.state.report!,
      status: "stale" as const,
      scan: { available: false, reason: "Configuration changed" },
      configuration,
    };
    rerender(<ProgrammaticChat {...props} state={{ ...props.state, report }} />);
    expect(screen.getByText("Why setup needs updating")).toBeTruthy();
    expect(screen.getByText("package.json")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Check again" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Update checks" }));
    expect(props.onAction).toHaveBeenCalledWith({ version: 1, action: "inspect-setup" });
    expect(screen.queryByRole("button", { name: "Save checks" })).toBeNull();
    rerender(
      <ProgrammaticChat
        {...props}
        state={{
          ...props.state,
          report,
          proposalApprovable: true,
          proposal: {
            handle: hash,
            operation: "refresh",
            configuration,
            fingerprint: "b".repeat(64),
            profileJson: "exact refresh",
            routes: [],
            exclusions: [],
            configurationInputs: [],
          },
        }}
      />,
    );
    fireEvent.click(shownStep().getByRole("button", { name: "Save checks" }));
    expect(props.onAction).toHaveBeenLastCalledWith({
      version: 1,
      action: "approve-setup",
      proposalHandle: hash,
    });
  });
  it("blocks cached scan and run after inspection finds drift, without blocking dismissal", () => {
    const { props, rerender } = fixture();
    const configuration = {
      status: "refresh-required" as const,
      currentFingerprint: "b".repeat(64),
      refreshAvailable: true,
      baselineUnavailable: false,
      diagnostic: null,
      drift: {
        files: [
          { path: "package.json", kind: "modified" as const, before: hash, after: "b".repeat(64) },
        ],
        policy: null,
        schema: null,
        exclusions: null,
      },
    };
    const state = programmaticChatReducer(props.state, {
      type: "response",
      generation: "one",
      epoch: 0,
      response: {
        version: 1,
        action: "inspect-setup",
        ok: true,
        proposal: {
          handle: hash,
          operation: "refresh",
          configuration,
          fingerprint: "b".repeat(64),
          profileJson: "exact refresh",
          routes: [],
          exclusions: [],
          configurationInputs: [],
        },
      },
    });
    rerender(<ProgrammaticChat {...props} state={state} />);
    // The open setup review shows step 1; saved results stay on Review.
    expect(shownStep().getByRole("region", { name: "Check setup" })).toBeTruthy();
    openStep("Review");
    for (const name of ["Check again", "Review and run"]) {
      const button = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(props.onRun).not.toHaveBeenCalled();
    expect(props.onAction).not.toHaveBeenCalled();
    expect(screen.getByText("package.json").parentElement?.textContent).toBe(
      "Changed: package.json",
    );
    expect(screen.getByLabelText("Exact settings to save").textContent).toBe("exact refresh");
    expect(state.detail).toBe(props.state.detail);
    expect(state.report).toBe(props.state.report);
    expect(state.selectedId).toBe(hash);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(props.onAction).toHaveBeenCalledExactlyOnceWith({
      version: 1,
      action: "dismiss",
      id: hash,
      snapshot: hash,
    });
  });
  it("reviews unreadable setup without reviving a historical proposal or execution permissions", () => {
    const { props, rerender } = fixture({
      proposalApprovable: true,
      proposal: {
        handle: hash,
        operation: "initial",
        fingerprint: hash,
        profileJson: "historical settings",
        configuration: {
          status: "missing",
          currentFingerprint: hash,
          refreshAvailable: false,
          baselineUnavailable: false,
          diagnostic: null,
          drift: null,
        },
        routes: [],
        exclusions: [],
        configurationInputs: [],
      },
    });
    let state = programmaticChatReducer(props.state, {
      type: "response",
      generation: "one",
      epoch: 0,
      response: {
        version: 1,
        action: "report",
        ok: true,
        report: {
          ...props.state.report!,
          configuration: {
            status: "unreadable",
            currentFingerprint: null,
            refreshAvailable: false,
            baselineUnavailable: false,
            diagnostic: "Saved settings cannot be read.",
            drift: null,
          },
        },
      },
    });
    rerender(<ProgrammaticChat {...props} state={state} />);
    const review = shownStep().getByRole("button", { name: "Show suggested checks" });
    expect((review as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(review);
    expect(props.onAction).toHaveBeenCalledExactlyOnceWith({ version: 1, action: "inspect-setup" });
    state = programmaticChatReducer(state, {
      type: "start",
      generation: "one",
      epoch: 1,
      operation: "inspect-setup",
    });
    rerender(<ProgrammaticChat {...props} state={state} />);
    expect((review as HTMLButtonElement).disabled).toBe(true);
    const error =
      "The setup could not be safely reviewed. No settings were saved; approval is unavailable.";
    state = programmaticChatReducer(state, {
      type: "response",
      generation: "one",
      epoch: 1,
      response: {
        version: 1,
        action: "inspect-setup",
        ok: false,
        reconcile: false,
        error,
        assessment: {
          version: 1,
          mode: "setup",
          status: "incomplete",
          summary: "Safe project evidence remains available.",
          limitations: [],
          coverage: [],
          observations: [],
          deterministic: { status: "not-run", reason: "setup" },
        },
      },
    });
    rerender(<ProgrammaticChat {...props} state={state} />);
    // Setup review is deterministic; a legacy AI result on its failure is not shown.
    expect(screen.queryByText("Safe project evidence remains available.")).toBeNull();
    expect(state.assessment).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe(
      "That didn't finish. Choose Try again when nothing else is running.",
    );
    const errorDetails = screen.getByText("Error details");
    expect(errorDetails.closest("details")!.open).toBe(false);
    fireEvent.click(errorDetails);
    expect(screen.getByText(error)).toBeTruthy();
    expect(state.proposal).toBe(props.state.proposal);
    expect(state.proposalApprovable).toBe(false);
    const blocked = (button: HTMLElement) => {
      expect((button as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(button);
    };
    blocked(shownStep().getByRole("button", { name: "Save checks" }));
    openStep("Review");
    for (const name of ["Check again", "Review and run"])
      blocked(screen.getByRole("button", { name }));
    openStep("Quick checks");
    expect(props.onAction).toHaveBeenCalledTimes(1);
    expect(props.onRun).not.toHaveBeenCalled();
    rerender(<ProgrammaticChat {...props} state={state} busy />);
    expect((review as HTMLButtonElement).disabled).toBe(true);
    rerender(<ProgrammaticChat {...props} state={state} planMode />);
    expect((review as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(review);
    expect(props.onAction).toHaveBeenCalledTimes(1);
    expect(
      (shownStep().getByRole("button", { name: "Save checks" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
  it.each([
    [
      "inventory",
      "This project is too large to check: it has more than 10,000 files.",
      "This project can't be checked right now.",
    ],
    [
      "stored",
      "Stored setup or configuration is unreadable.",
      "Your saved checks can't be read, so they can't run.",
    ],
  ] as const)(
    "explains a %s failure without misattributing its cause",
    (failure, diagnostic, message) => {
      const { props, rerender } = fixture();
      const state = programmaticChatReducer(props.state, {
        type: "response",
        generation: "one",
        epoch: 0,
        response: {
          version: 1,
          action: "report",
          ok: true,
          report: {
            ...props.state.report!,
            configuration: {
              status: "unreadable",
              currentFingerprint: null,
              refreshAvailable: false,
              baselineUnavailable: false,
              diagnostic,
              failure,
              drift: null,
            },
          },
        },
      });
      rerender(<ProgrammaticChat {...props} state={state} />);
      expect(screen.getByText(message)).toBeTruthy();
      if (failure === "inventory")
        expect(screen.queryByText(/saved setup can't be read/)).toBeNull();
      fireEvent.click(screen.getByText("Setup error details"));
      expect(screen.getByText(diagnostic)).toBeTruthy();
    },
  );
  it.each(["refresh-required", "unreadable", "missing"] as const)(
    "marks a retained current review historical after a %s report",
    (status) => {
      const { props, rerender } = fixture();
      const currentConfiguration = {
        status: "current" as const,
        currentFingerprint: hash,
        refreshAvailable: false,
        baselineUnavailable: false,
        diagnostic: null,
        drift: null,
      };
      let state = programmaticChatReducer(props.state, {
        type: "response",
        generation: "one",
        epoch: 0,
        response: {
          version: 1,
          action: "inspect-setup",
          ok: true,
          proposal: {
            operation: "current",
            handle: null,
            fingerprint: hash,
            profileJson: "previous exact settings",
            routes: [],
            exclusions: [],
            configurationInputs: [],
            configuration: currentConfiguration,
          },
        },
      });
      const configuration = {
        ...currentConfiguration,
        status,
        currentFingerprint: "b".repeat(64),
        refreshAvailable: status === "refresh-required",
        diagnostic: status === "unreadable" ? "Cannot read package.json" : null,
        drift:
          status === "refresh-required"
            ? {
                files: [
                  {
                    path: "package.json",
                    kind: "modified" as const,
                    before: hash,
                    after: "b".repeat(64),
                  },
                ],
                policy: null,
                schema: null,
                exclusions: null,
              }
            : null,
      };
      state = programmaticChatReducer(state, {
        type: "response",
        generation: "one",
        epoch: 0,
        response: {
          version: 1,
          action: "report",
          ok: true,
          report: {
            ...props.state.report!,
            configuration,
            status: "stale",
            scan: { available: false, reason: "Setup changed" },
          },
        },
      });
      rerender(<ProgrammaticChat {...props} state={state} />);
      expect(screen.queryByText("Checks are up to date")).toBeNull();
      expect(screen.queryByText(/No regeneration or approval is needed/)).toBeNull();
      expect(screen.getByRole("heading", { name: "Older suggested checks" })).toBeTruthy();
      expect(screen.getByLabelText("Exact settings to save").textContent).toBe(
        "previous exact settings",
      );
      openStep("Review");
      expect(screen.getByRole("heading", { name: "Review app packaging" })).toBeTruthy();
      if (status === "refresh-required")
        expect(screen.getByText("package.json").parentElement?.textContent).toBe(
          "Changed: package.json",
        );
      for (const name of ["Check again", "Review and run"])
        expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole("button", { name: "Dismiss" }) as HTMLButtonElement).disabled).toBe(
        false,
      );
      // A reverted configuration is current, but the old report is not a new permission grant.
      state = programmaticChatReducer(state, {
        type: "response",
        generation: "one",
        epoch: 0,
        response: {
          version: 1,
          action: "inspect-setup",
          ok: true,
          proposal: { ...state.proposal!, configuration: currentConfiguration },
        },
      });
      rerender(<ProgrammaticChat {...props} state={state} />);
      // The user's Review pick holds through a fresh setup response; step 1 is a click away.
      expect(selectedStep()).toMatch(/^3\s*Review/);
      openStep("Quick checks");
      expect(screen.getByRole("heading", { name: "Checks are up to date" })).toBeTruthy();
      expect(screen.queryByText("Why setup needs updating")).toBeNull();
      expect(screen.queryByText("Cannot read package.json")).toBeNull();
      expect(
        (shownStep().getByRole("button", { name: "Show suggested checks" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
      openStep("Review");
      expect(
        within(screen.getByRole("region", { name: "Ready to run" })).getByText(
          /Choose Check again to update them/,
        ),
      ).toBeTruthy();
      expect(
        (screen.getByRole("button", { name: "Check again" }) as HTMLButtonElement).disabled,
      ).toBe(true);
    },
  );
  it("keeps current setup compact and maps Show suggested checks to inspection only", () => {
    const { props, rerender } = fixture();
    const state: ProgrammaticChatState = {
      ...props.state,
      report: {
        ...props.state.report!,
        configuration: {
          status: "current",
          currentFingerprint: hash,
          refreshAvailable: false,
          baselineUnavailable: false,
          diagnostic: null,
          drift: null,
        },
      },
    };
    rerender(<ProgrammaticChat {...props} state={state} />);
    // Saved results sit on Review; setup sits on step 1, a separate step.
    expect(shownStep().getByRole("region", { name: "Ready to run" })).toBeTruthy();
    expect(shownStep().queryByRole("region", { name: "Check setup" })).toBeNull();
    openStep("Quick checks");
    const setup = shownStep().getByRole("region", { name: "Check setup" });
    expect(within(setup).getByText("Your checks are set up.")).toBeTruthy();
    expect(within(setup).queryByText(/Choose which project checks to save/)).toBeNull();
    expect(within(setup).queryByRole("button", { name: /Approve/ })).toBeNull();
    expect(shownStep().queryByRole("region", { name: "Ready to run" })).toBeNull();
    expect(props.onAction).not.toHaveBeenCalled();
    expect(props.onRun).not.toHaveBeenCalled();
    fireEvent.click(within(setup).getByRole("button", { name: "Show suggested checks" }));
    expect(props.onAction).toHaveBeenCalledExactlyOnceWith({ version: 1, action: "inspect-setup" });
    expect(props.onRun).not.toHaveBeenCalled();
  });

  it("displays current saved settings without an approval button", () => {
    fixture({
      proposalApprovable: false,
      proposal: {
        operation: "current",
        handle: null,
        fingerprint: hash,
        profileJson: "saved settings",
        routes: [],
        exclusions: [],
        configurationInputs: [],
        configuration: {
          status: "current",
          currentFingerprint: hash,
          refreshAvailable: false,
          baselineUnavailable: false,
          diagnostic: null,
          drift: null,
        },
      },
    });
    expect(screen.getByText("Checks are up to date")).toBeTruthy();
    expect(screen.getByText("saved settings")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save checks" })).toBeNull();
  });
  it("separates discovery, saved checks and refresh without starting a task", () => {
    const { props } = fixture({ selectedId: null, detail: null });
    // Fixed order: 1 Quick checks, 2 Find ideas, 3 Review. Only the Next step is aria-current.
    const sections = screen.getByRole("tablist", { name: "Opportunities steps" });
    const steps = within(sections).getAllByRole("tab");
    expect(steps.map((tab) => tab.textContent)).toEqual([
      "1 Quick checks → Next",
      "2 Find ideas ○ Not yet",
      "3 Review ○ Not yet",
    ]);
    expect(steps.map((tab) => tab.getAttribute("aria-current"))).toEqual(["step", null, null]);
    // The header key does step 1's action; step 1's own button is the quiet copy.
    expect(document.querySelector(".inst-key")!.textContent).toBe("Show suggested checks");
    expect(
      shownStep().getByRole("button", { name: "Show suggested checks" }).className,
    ).not.toContain("btn-primary");
    expect(props.onAction).not.toHaveBeenCalled();
    // Skip for now writes nothing and moves on to step 2.
    fireEvent.click(shownStep().getByRole("button", { name: "Skip for now" }));
    expect(props.onAction).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(steps[1]);
    expect(steps[1]!.getAttribute("aria-selected")).toBe("true");
    expect(steps.map((tab) => tab.getAttribute("aria-current"))).toEqual([null, "step", null]);
    expect(steps[0]!.textContent).toBe("1 Quick checks ○ Not yet");
    fireEvent.click(screen.getByRole("button", { name: "Find ideas" }));
    openStep("Review");
    const checks = screen.getByRole("region", { name: "Ready to run" });
    expect(screen.getByRole("region", { name: "Ideas" })).toBeTruthy();
    fireEvent.click(within(checks).getByRole("button", { name: "Check again" }));
    expect(within(checks).queryByRole("button", { name: "Refresh results" })).toBeNull();
    expect(props.onAction.mock.calls).toEqual([
      [{ version: 1, action: "discover" }],
      [{ version: 1, action: "scan" }],
    ]);
    expect(props.onRun).not.toHaveBeenCalled();
  });
  it("limits Checks action buttons to the allowed set and shows Try again only after an error", () => {
    const allowed = new Set([
      "Show suggested checks",
      "Update checks",
      "Save checks",
      "Not now",
      "Check again",
      "Review and run",
      "Dismiss",
    ]);
    const { props, rerender } = fixture();
    const actionNames = () =>
      ["Check setup", "Ready to run"].flatMap((name) =>
        Array.from(
          screen
            .getByRole("region", { name, hidden: true })
            .querySelectorAll("div.programmatic-actions button"),
          (button) => button.textContent ?? "",
        ),
      );
    expect(actionNames().length).toBeGreaterThan(0);
    for (const name of actionNames()) expect(allowed).toContain(name);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    rerender(<ProgrammaticChat {...props} state={{ ...props.state, error: "Failed" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(props.onAction).toHaveBeenCalledExactlyOnceWith({
      version: 1,
      action: "report",
      offset: 0,
    });
  });
  it("can close a review without saving, retaining results and requiring inspection to reopen", () => {
    const proposal = {
      handle: hash,
      fingerprint: hash,
      profileJson: "exact unsaved settings",
      operation: "initial" as const,
      configuration: {
        status: "missing" as const,
        currentFingerprint: hash,
        refreshAvailable: false,
        baselineUnavailable: false,
        diagnostic: null,
        drift: null,
      },
      routes: [],
      exclusions: [],
      configurationInputs: [],
    };
    const { props, rerender } = fixture({ proposal, proposalApprovable: true });
    const technical = screen.getByText("Technical details").closest("details")!;
    expect(technical.open).toBe(false);
    expect(within(technical).getByLabelText("Exact settings to save").textContent).toBe(
      proposal.profileJson,
    );
    const close = screen.getByRole("button", { name: "Not now" });
    close.focus();
    fireEvent.click(close);
    expect(props.onAction).not.toHaveBeenCalled();
    expect(props.onRun).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Save checks" })).toBeNull();
    openSavedResults();
    expect(
      screen.getByRole("button", { name: /Review app packaging/ }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Opportunities" }));
    rerender(<ProgrammaticChat {...props} state={{ ...props.state, proposalApprovable: false }} />);
    expect(screen.queryByRole("button", { name: "Save checks" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show suggested checks" }));
    expect(props.onAction).toHaveBeenCalledExactlyOnceWith({ version: 1, action: "inspect-setup" });
    expect(
      (screen.getByRole("button", { name: "Save checks" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
  it("displays exact proposal and requires its separate approval", () => {
    const { props, rerender } = fixture({
      proposalApprovable: true,
      proposal: {
        handle: hash,
        operation: "initial" as const,
        configuration: {
          status: "missing" as const,
          currentFingerprint: hash,
          refreshAvailable: false,
          baselineUnavailable: false,
          diagnostic: null,
          drift: null,
        },
        fingerprint: hash,
        profileJson: "exact profile",
        routes: [],
        exclusions: [],
        configurationInputs: [],
      },
    });
    expect(screen.getByLabelText("Exact settings to save").textContent).toBe("exact profile");
    expect(props.onAction).not.toHaveBeenCalled();
    const approve = shownStep().getByRole("button", { name: "Save checks" });
    approve.focus();
    fireEvent.click(approve);
    expect(props.onAction).toHaveBeenCalledWith({
      version: 1,
      action: "approve-setup",
      proposalHandle: hash,
    });
    rerender(<ProgrammaticChat {...props} state={{ ...props.state, proposal: null }} />);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Opportunities" }));
  });
  it.each([false, true])(
    "cannot resubmit obsolete approval after a report (uncertain: %s)",
    (uncertain) => {
      const proposal = {
        handle: hash,
        operation: "initial" as const,
        configuration: {
          status: "missing" as const,
          currentFingerprint: hash,
          refreshAvailable: false,
          baselineUnavailable: false,
          diagnostic: null,
          drift: null,
        },
        fingerprint: hash,
        profileJson: "exact old profile",
        routes: [],
        exclusions: ["node_modules/**"],
        configurationInputs: [{ path: "package.json", sha256: hash }],
      };
      const { props, rerender } = fixture({ proposal, proposalApprovable: true });
      fireEvent.click(shownStep().getByRole("button", { name: "Save checks" }));
      expect(props.onAction).toHaveBeenCalledTimes(1);
      let state = programmaticChatReducer(props.state, {
        type: "start",
        generation: "one",
        epoch: 1,
        operation: "approve-setup",
      });
      state = programmaticChatReducer(
        state,
        uncertain
          ? { type: "error", generation: "one", epoch: 1, error: "unknown", reconcile: true }
          : {
              type: "response",
              generation: "one",
              epoch: 1,
              response: {
                version: 1,
                action: "approve-setup",
                ok: false,
                error: "stale",
                reconcile: false,
              },
            },
      );
      state = programmaticChatReducer(state, {
        type: "response",
        generation: "one",
        epoch: 1,
        response: { version: 1, action: "report", ok: true, report: props.state.report! },
      });
      rerender(<ProgrammaticChat {...props} state={state} />);
      const approve = shownStep().getByRole("button", {
        name: "Save checks",
      }) as HTMLButtonElement;
      expect(approve.disabled).toBe(true);
      fireEvent.click(approve);
      expect(props.onAction).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/Choose Show suggested checks again/)).toBeTruthy();
      expect(screen.getByLabelText("Exact settings to save").textContent).toBe(
        proposal.profileJson,
      );
      fireEvent.click(screen.getByText("Technical details"));
      expect(screen.getByText("node_modules/**")).toBeTruthy();
      expect(screen.getByText("package.json")).toBeTruthy();
      fireEvent.click(shownStep().getByRole("button", { name: "Show suggested checks" }));
      expect(props.onAction).toHaveBeenLastCalledWith({ version: 1, action: "inspect-setup" });
      const fresh = { ...proposal, handle: "b".repeat(64), profileJson: "exact fresh profile" };
      state = programmaticChatReducer(state, {
        type: "start",
        generation: "one",
        epoch: 2,
        operation: "inspect-setup",
      });
      state = programmaticChatReducer(state, {
        type: "response",
        generation: "one",
        epoch: 2,
        response: { version: 1, action: "inspect-setup", ok: true, proposal: fresh },
      });
      rerender(<ProgrammaticChat {...props} state={state} />);
      expect(
        (shownStep().getByRole("button", { name: "Save checks" }) as HTMLButtonElement).disabled,
      ).toBe(false);
      fireEvent.click(shownStep().getByRole("button", { name: "Save checks" }));
      expect(props.onAction).toHaveBeenLastCalledWith({
        version: 1,
        action: "approve-setup",
        proposalHandle: fresh.handle,
      });
      expect(props.onAction).toHaveBeenCalledTimes(3);
    },
  );
  it.each(["completed", "dismissed", "running"] as const)(
    "retains inspectable %s state without allowing rerun",
    (lifecycle) => {
      const { props, rerender } = fixture();
      const summary = {
        ...props.state.detail!.summary,
        state: lifecycle,
        route: { ...props.state.detail!.summary.route, available: false },
      };
      rerender(
        <ProgrammaticChat
          {...props}
          state={{
            ...props.state,
            detail: { ...props.state.detail!, summary },
            report: { ...props.state.report!, rows: [summary] },
          }}
        />,
      );
      expect(
        (screen.getByRole("button", { name: "Review and run" }) as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(screen.getByText("Why this came up")).toBeTruthy();
    },
  );
  it("does not steal focus after the user leaves an approval control", () => {
    const { props, rerender } = fixture({
      proposalApprovable: true,
      proposal: {
        handle: hash,
        operation: "initial" as const,
        configuration: {
          status: "missing" as const,
          currentFingerprint: hash,
          refreshAvailable: false,
          baselineUnavailable: false,
          diagnostic: null,
          drift: null,
        },
        fingerprint: hash,
        profileJson: "exact profile",
        routes: [],
        exclusions: [],
        configurationInputs: [],
      },
    });
    const approve = shownStep().getByRole("button", { name: "Save checks" });
    approve.focus();
    approve.blur();
    rerender(<ProgrammaticChat {...props} state={{ ...props.state, proposal: null }} />);
    expect(document.activeElement).toBe(document.body);
  });

  it("shows setup-required, empty, stale, disappeared and unavailable states truthfully", () => {
    const { props, rerender } = fixture();
    const empty = {
      ...props.state,
      detail: null,
      report: { ...props.state.report!, rows: [], total: 0 },
    };
    rerender(
      <ProgrammaticChat
        {...props}
        state={{ ...empty, report: { ...empty.report, status: "setup-required" } }}
      />,
    );
    // Said once, in the setup intro only.
    expect(
      screen.getByText("Pick which checks to save. You don't need this to find ideas."),
    ).toBeTruthy();
    // Setup lives on step 1 (Review is open here: a check result is still remembered).
    openStep("Quick checks");
    fireEvent.click(shownStep().getByRole("button", { name: "Show suggested checks" }));
    expect(props.onAction).toHaveBeenCalledWith({ version: 1, action: "inspect-setup" });
    openStep("Review");
    rerender(<ProgrammaticChat {...props} state={empty} />);
    expect(screen.getByText(/No results yet/)).toBeTruthy();
    rerender(
      <ProgrammaticChat
        {...props}
        state={{
          ...props.state,
          report: {
            ...props.state.report!,
            status: "stale",
            scan: { available: false, reason: "Approve current setup." },
          },
        }}
      />,
    );
    expect(
      (screen.getByRole("button", { name: "Check again" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Review and run" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    const summary = {
      ...props.state.detail!.summary,
      presence: "disappeared" as const,
      route: {
        ...props.state.detail!.summary.route,
        available: false,
        reason: "Specialist not installed",
      },
    };
    rerender(
      <ProgrammaticChat
        {...props}
        state={{ ...props.state, detail: { ...props.state.detail!, summary } }}
      />,
    );
    expect(screen.getByText("Specialist not installed")).toBeTruthy();
    expect(screen.getByText(/No longer found, so it can't start/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Review and run" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    rerender(<ProgrammaticChat {...props} planMode />);
    expect((screen.getByRole("button", { name: "Dismiss" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole("button", { name: "Show suggested checks" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    props.onAction.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Show suggested checks" }));
    expect(props.onAction).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Refresh results" })).toBeNull();
    openSavedResults();
    fireEvent.click(screen.getByRole("button", { name: /Review app packaging/ }));
    expect(props.onSelect).toHaveBeenCalledWith(hash);
    rerender(<ProgrammaticChat {...props} />);
    const review = screen.getByRole("button", {
      name: "Show suggested checks",
    }) as HTMLButtonElement;
    expect(review.disabled).toBe(false);
    fireEvent.click(review);
    expect(props.onAction).toHaveBeenLastCalledWith({ version: 1, action: "inspect-setup" });
  });

  it("gates stale, missing, loading and uncertain states without dropping the report", () => {
    const { props, rerender } = fixture({ reconcile: true, error: "Unknown acknowledgement" });
    expect(
      (screen.getByRole("button", { name: "Review and run" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByRole("alert").textContent).toBe(
      "We couldn't tell if that was saved. Choose Try again to reload results.",
    );
    const errorDetails = screen.getByText("Error details");
    expect(errorDetails.closest("details")!.open).toBe(false);
    fireEvent.click(errorDetails);
    expect(screen.getByText("Unknown acknowledgement")).toBeTruthy();
    expect(props.onAction).not.toHaveBeenCalled();
    expect(props.onRun).not.toHaveBeenCalled();
    const recovery = screen.getByRole("button", { name: "Try again" });
    expect(recovery.closest(".programmatic-stage")).toBeNull();
    expect(recovery.closest("details")).toBeNull();
    fireEvent.click(recovery);
    expect(props.onAction).toHaveBeenCalledWith({ version: 1, action: "report", offset: 0 });
    rerender(<ProgrammaticChat {...props} state={{ ...props.state, operation: "scan" }} />);
    expect(screen.getByRole("status").textContent).toBe("Working…");
    expect((screen.getByRole("button", { name: "Try again" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    openSavedResults();
    expect(screen.getByRole("button", { name: /Review app packaging/ })).toBeTruthy();
    rerender(
      <ProgrammaticChat
        {...props}
        state={{ ...props.state, detail: null, missingSelection: true }}
      />,
    );
    expect(screen.getByText(/Pick another one/)).toBeTruthy();
  });
});
