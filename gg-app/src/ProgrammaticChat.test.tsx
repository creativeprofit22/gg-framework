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
const assessmentLabels = { completed: "Finished", incomplete: "Incomplete", cancelled: "Cancelled", unavailable: "Unavailable" };
const checkLabels = { succeeded: "Finished", "not-run": "Not run", failed: "Failed", denied: "Not allowed", cancelled: "Cancelled", unavailable: "Unavailable" };
function openSavedResults() {
  const summary = screen.queryByText(/Browse saved check results \(\d+\)/);
  if (summary && !summary.closest("details")!.open) fireEvent.click(summary);
}
function openAssessmentDetails() {
  const region = screen.getByRole("region", { name: "Project assessment" });
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
      expect(screen.getByText(/Previous assessment, retained for reference/)).toBeTruthy();
      state = programmaticChatReducer(state, {
        type: "assessment",
        generation: "one",
        event: { ...identity, phase: "started" },
      });
      show();
      expect(screen.getByText("Old assessment")).toBeTruthy();
      expect(screen.getByText(/Previous assessment, retained for reference/)).toBeTruthy();
      if (interrupted) {
        state = programmaticChatReducer(state, {
          type: "error",
          generation: "one",
          epoch: 1,
          error: "Transport lost",
          reconcile: false,
        });
        show();
        expect(screen.getByText(/Previous assessment, retained for reference/)).toBeTruthy();
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
      expect(screen.getByRole("heading", { name: `Project assessment: ${assessmentLabels[status]}` })).toBeTruthy();
      expect(screen.getByText(current.summary)).toBeTruthy();
      expect(screen.queryByText(/Previous assessment, retained for reference/)).toBeNull();
      expect(screen.getByText(/This suggestion is from an earlier check/)).toBeTruthy();
      expect(screen.getByText("Success check: Known issue found")).toBeTruthy();
      expect(
        (screen.getByRole("button", { name: "Review this task" }) as HTMLButtonElement)
          .disabled,
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
  expect(screen.getByText("Assumed, not checked")).toBeTruthy();
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
  const { props } = fixture({ configuration: { status: "current", currentFingerprint: hash, refreshAvailable: false, baselineUnavailable: false, diagnostic: null, drift: null } });
  expect(screen.queryByText("Choose which project checks to save. Discovery is available separately, without setup.")).toBeNull();
  expect(props.onAction).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Change settings" }));
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
  expect(screen.getByText(/saves future configured assessments automatically/)).toBeTruthy();
  expect(screen.getByText(/leave without approving/)).toBeTruthy();
  expect(screen.getByLabelText("Exact history policy to save").textContent).toContain(
    '"enabled": true',
  );
  fireEvent.click(screen.getByRole("button", { name: "Approve history saving" }));
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
      label: "Recommendation history: saved",
    },
    { history: { status: "disabled" }, label: "Recommendation history: saving disabled" },
    {
      history: { status: "setup-not-saved" },
      label: "Recommendation history: setup assessment not saved",
    },
    {
      history: { status: "unsaved", assessmentId, reason },
      label: "Recommendation history: not saved",
    },
    {
      history: { status: "acknowledgement-unknown", assessmentId, reason },
      label: "Recommendation history: save not confirmed",
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
      expect(screen.getByRole("heading", { name: "Project assessment: Finished" })).toBeTruthy();
      openAssessmentDetails();
      openSavedResults();
      expect(
        screen.getByRole("heading", {
          name: `Saved checks: ${checkLabels[assessment.deterministic.status]}`,
        }),
      ).toBeTruthy();
      expect(state.report).toBe(props.state.report);
      expect(state.detail).toBe(props.state.detail);
      expect(state.selectedId).toBe(hash);
      expect(
        screen.getByRole("button", { name: /Review app packaging/ }).getAttribute("aria-pressed"),
      ).toBe("true");
      const section = screen.queryByRole("region", { name: "Recommendation history" });
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
            "History may already have been saved, but this could not be confirmed. Read current history before retrying the save. Do not rerun the assessment or its checks just to save history.",
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
      expect(screen.getByRole("heading", { name: `Project assessment: ${assessmentLabels[status]}` })).toBeTruthy();
      expect(screen.getByText("Documentation suggests missing workflow guidance.")).toBeTruthy();
      expect(screen.getByText("Unfamiliar source was not inspected.")).toBeTruthy();
      openAssessmentDetails();
      expect(screen.getByText(/Project: Only partly checked/)).toBeTruthy();
      expect(screen.getByText(/0 enabled checks; 0 applicable checks/)).toBeTruthy();
      expect(screen.getByText(/No saved checks applied/)).toBeTruthy();
      expect(screen.getByText("Unfamiliar source was not inspected.").closest("details")).toBeNull();
      expect(screen.queryByText(/not a clean bill of health/)).toBeNull();
      expect(screen.queryByText("Transcript-only detailed observation")).toBeNull();
      expect(screen.queryByRole("button", { name: /Run|Review task approval/ })).toBeNull();
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
      expect(screen.getByRole("heading", { name: `Saved checks: ${checkLabels[status]}` })).toBeTruthy();
      expect(screen.getByText("Checks did not complete.")).toBeTruthy();
    },
  );
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
      for (const name of ["Review task approval", "Dismiss this item", "Run project checks"]) {
        const button = screen.getByRole("button", { name }) as HTMLButtonElement;
        expect(button.disabled).toBe(true);
        expect(button.title).toBe(blocked.reason);
        fireEvent.click(button);
      }
      expect(props.onRun).not.toHaveBeenCalled();
      expect(props.onAction).not.toHaveBeenCalled();
      openSavedResults();
      for (const name of [
        "Review setup",
        "Refresh results",
        "Next opportunities",
        /Review app packaging/,
      ])
        expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(false);
      openSavedResults();
    fireEvent.click(screen.getByRole("button", { name: /Review app packaging/ }));
      expect(props.onSelect).toHaveBeenCalledWith(hash);
      fireEvent.click(screen.getByText("Why this was suggested and how to check it"));
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
        (screen.getByRole("button", { name: "Review task approval" }) as HTMLButtonElement)
          .disabled,
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
      for (const name of ["Review task approval", "Dismiss this item", "Run project checks"])
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
    expect(screen.getByText("No deterministic results on this page (1 total).")).toBeTruthy();
    const previous = screen.getByRole("button", { name: "Previous opportunities" });
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
      fireEvent.click(screen.getByRole("button", { name: "Refresh results" }));
      expect(props.onAction).toHaveBeenCalledExactlyOnceWith({
        version: 1,
        action: "report",
        offset: oldOffset,
      });
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
      expect(screen.getByText(/none was selected for you/)).toBeTruthy();
      openSavedResults();
      if (total)
        expect(
          screen
            .getByRole("button", { name: /Surviving opportunity/ })
            .getAttribute("aria-pressed"),
        ).toBe("false");
      else expect(screen.getByText(/No saved check results yet/)).toBeTruthy();
      if (total > 50) {
        expect(screen.getByText("51–51 of 51")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Previous opportunities" }));
        expect(props.onAction).toHaveBeenLastCalledWith({
          version: 1,
          action: "report",
          offset: 0,
        });
      } else expect(screen.queryByRole("navigation", { name: "Opportunity pages" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Refresh results" }));
      expect(props.onAction).toHaveBeenLastCalledWith({ version: 1, action: "report", offset });
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
    fireEvent.click(screen.getByRole("button", { name: "Run project checks" }));
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
      (screen.getByRole("button", { name: "Run project checks" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (screen.getByRole("button", { name: "Review task approval" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Run project checks" }));
    expect(props.onAction).toHaveBeenCalledExactlyOnceWith({ version: 1, action: "scan" });
    for (const locks of [
      { busy: true },
      { planMode: true },
      { state: { ...approved, reconcile: true } },
      { state: { ...approved, operation: "scan" as const } },
    ]) {
      rerender(<ProgrammaticChat {...props} state={approved} {...locks} />);
      expect(
        (screen.getByRole("button", { name: "Run project checks" }) as HTMLButtonElement).disabled,
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
      (screen.getByRole("button", { name: "Review task approval" }) as HTMLButtonElement).disabled,
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
      (screen.getByRole("button", { name: "Review task approval" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
  it("keeps selection separate from run, exposes evidence and one-record dismissal", () => {
    const { props } = fixture();
    openSavedResults();
    fireEvent.click(screen.getByRole("button", { name: /Review app packaging/ }));
    expect(props.onSelect).toHaveBeenCalledWith(hash);
    expect(props.onRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Why this was suggested and how to check it"));
    expect(screen.getByText("src/package.json")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review task approval" }));
    expect(props.onRun).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss this item" }));
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
    expect(screen.getByText("Why setup needs a refresh")).toBeTruthy();
    expect(screen.getByText("package.json")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Run project checks" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Review setup refresh" }));
    expect(props.onAction).toHaveBeenCalledWith({ version: 1, action: "inspect-setup" });
    expect(screen.queryByRole("button", { name: "Approve and save refresh" })).toBeNull();
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
    fireEvent.click(screen.getByRole("button", { name: "Approve and save refresh" }));
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
    for (const name of ["Run project checks", "Review task approval"]) {
      const button = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(props.onRun).not.toHaveBeenCalled();
    expect(props.onAction).not.toHaveBeenCalled();
    expect(screen.getByText("package.json").parentElement?.textContent).toBe(
      "modified: package.json",
    );
    expect(screen.getByLabelText("Exact settings to save").textContent).toBe("exact refresh");
    expect(state.detail).toBe(props.state.detail);
    expect(state.report).toBe(props.state.report);
    expect(state.selectedId).toBe(hash);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss this item" }));
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
    const review = screen.getByRole("button", { name: "Review setup" });
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
    expect(screen.getByText("Safe project evidence remains available.")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("This request did not finish. You can retry it when the current work has stopped.");
    const errorDetails = screen.getByText("Error details");
    expect(errorDetails.closest("details")!.open).toBe(false);
    fireEvent.click(errorDetails);
    expect(screen.getByText(error)).toBeTruthy();
    expect(state.proposal).toBe(props.state.proposal);
    expect(state.proposalApprovable).toBe(false);
    for (const name of ["Approve and save setup", "Run project checks", "Review task approval"]) {
      const button = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(props.onAction).toHaveBeenCalledTimes(1);
    expect(props.onRun).not.toHaveBeenCalled();
    rerender(<ProgrammaticChat {...props} state={state} busy />);
    expect((review as HTMLButtonElement).disabled).toBe(true);
    rerender(<ProgrammaticChat {...props} state={state} planMode />);
    expect((review as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(review);
    expect(props.onAction).toHaveBeenCalledTimes(1);
    expect(
      (screen.getByRole("button", { name: "Approve and save setup" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
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
      expect(screen.queryByText("Saved setup is current")).toBeNull();
      expect(screen.queryByText(/No regeneration or approval is needed/)).toBeNull();
      expect(screen.getByRole("heading", { name: "Previous setup review" })).toBeTruthy();
      expect(screen.getByLabelText("Exact settings to save").textContent).toBe(
        "previous exact settings",
      );
      expect(screen.getByRole("heading", { name: "Review app packaging" })).toBeTruthy();
      if (status === "refresh-required")
        expect(screen.getByText("package.json").parentElement?.textContent).toBe(
          "modified: package.json",
        );
      for (const name of ["Run project checks", "Review task approval"])
        expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
      expect(
        (screen.getByRole("button", { name: "Dismiss this item" }) as HTMLButtonElement).disabled,
      ).toBe(false);
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
      expect(screen.getByRole("heading", { name: "Saved setup is current" })).toBeTruthy();
      expect(screen.queryByText("Why setup needs a refresh")).toBeNull();
      expect(screen.queryByText("Cannot read package.json")).toBeNull();
      expect(within(screen.getByRole("region", { name: "Saved check results" })).getByText(/Refresh results to update task availability/)).toBeTruthy();
      expect(
        (screen.getByRole("button", { name: "Change settings" }) as HTMLButtonElement).disabled,
      ).toBe(false);
      expect(
        (screen.getByRole("button", { name: "Run project checks" }) as HTMLButtonElement).disabled,
      ).toBe(true);
    },
  );
  it("keeps current setup compact and maps Change settings to inspection only", () => {
    const { props, rerender } = fixture();
    const state: ProgrammaticChatState = {
      ...props.state,
      report: { ...props.state.report!, configuration: {
        status: "current", currentFingerprint: hash, refreshAvailable: false,
        baselineUnavailable: false, diagnostic: null, drift: null,
      } },
    };
    rerender(<ProgrammaticChat {...props} state={state} />);
    const setup = screen.getByRole("region", { name: "Saved checks setup" });
    expect(within(setup).getByText("Saved check settings are up to date.")).toBeTruthy();
    expect(within(setup).queryByText(/Choose which project checks to save/)).toBeNull();
    expect(within(setup).queryByRole("button", { name: /Approve/ })).toBeNull();
    const results = screen.getByRole("region", { name: "Saved check results" });
    expect(results.compareDocumentPosition(setup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(props.onAction).not.toHaveBeenCalled();
    expect(props.onRun).not.toHaveBeenCalled();
    fireEvent.click(within(setup).getByRole("button", { name: "Change settings" }));
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
    expect(screen.getByText("Saved setup is current")).toBeTruthy();
    expect(screen.getByText("saved settings")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Approve and save/ })).toBeNull();
  });
  it("separates discovery, saved checks and refresh without starting a task", () => {
    const { props } = fixture();
    const discovery = screen.getByRole("region", { name: "Discovery" });
    const checks = screen.getByRole("region", { name: "Saved check results" });
    expect(screen.queryByRole("navigation", { name: "Opportunity sections" })).toBeNull();
    expect(checks.compareDocumentPosition(discovery) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(props.onAction).not.toHaveBeenCalled();
    fireEvent.click(within(discovery).getByRole("button", { name: "Find tasks to automate" }));
    fireEvent.click(within(checks).getByRole("button", { name: "Run project checks" }));
    fireEvent.click(within(checks).getByRole("button", { name: "Refresh results" }));
    expect(props.onAction.mock.calls).toEqual([
      [{ version: 1, action: "discover" }],
      [{ version: 1, action: "scan" }],
      [{ version: 1, action: "report", offset: 0 }],
    ]);
    expect(props.onRun).not.toHaveBeenCalled();
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
    const technical = screen
      .getByText("Technical details: exact settings, history policy and checked files")
      .closest("details")!;
    expect(technical.open).toBe(false);
    expect(within(technical).getByLabelText("Exact settings to save").textContent).toBe(
      proposal.profileJson,
    );
    const close = screen.getByRole("button", { name: "Close review without saving" });
    close.focus();
    fireEvent.click(close);
    expect(props.onAction).not.toHaveBeenCalled();
    expect(props.onRun).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Approve and save setup" })).toBeNull();
    openSavedResults();
    expect(
      screen.getByRole("button", { name: /Review app packaging/ }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Opportunities" }));
    rerender(<ProgrammaticChat {...props} state={{ ...props.state, proposalApprovable: false }} />);
    expect(screen.queryByRole("button", { name: "Approve and save setup" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review setup" }));
    expect(props.onAction).toHaveBeenCalledExactlyOnceWith({ version: 1, action: "inspect-setup" });
    expect(
      (screen.getByRole("button", { name: "Approve and save setup" }) as HTMLButtonElement)
        .disabled,
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
    const approve = screen.getByRole("button", { name: "Approve and save setup" });
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
      fireEvent.click(screen.getByRole("button", { name: "Approve and save setup" }));
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
      const approve = screen.getByRole("button", {
        name: "Approve and save setup",
      }) as HTMLButtonElement;
      expect(approve.disabled).toBe(true);
      fireEvent.click(approve);
      expect(props.onAction).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/Review setup again before approving/)).toBeTruthy();
      expect(screen.getByLabelText("Exact settings to save").textContent).toBe(
        proposal.profileJson,
      );
      fireEvent.click(
        screen.getByText("Technical details: exact settings, history policy and checked files"),
      );
      expect(screen.getByText("node_modules/**")).toBeTruthy();
      expect(screen.getByText("package.json")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Review setup" }));
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
        (screen.getByRole("button", { name: "Approve and save setup" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "Approve and save setup" }));
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
        (screen.getByRole("button", { name: "Review task approval" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      expect(screen.getByText("Why this was suggested and how to check it")).toBeTruthy();
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
    const approve = screen.getByRole("button", { name: "Approve and save setup" });
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
    expect(
      screen.getByText(
        "Nothing is saved until you approve. You can still discover opportunities below.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review setup" }));
    expect(props.onAction).toHaveBeenCalledWith({ version: 1, action: "inspect-setup" });
    rerender(<ProgrammaticChat {...props} state={empty} />);
    expect(screen.getByText(/No saved check results yet/)).toBeTruthy();
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
      (screen.getByRole("button", { name: "Run project checks" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Review task approval" }) as HTMLButtonElement).disabled,
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
    expect(screen.getByText(/No longer found; cannot start/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Review task approval" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    rerender(<ProgrammaticChat {...props} planMode />);
    expect(
      (screen.getByRole("button", { name: "Dismiss this item" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Review setup" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    props.onAction.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Review setup" }));
    expect(props.onAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh results" }));
    expect(props.onAction).toHaveBeenCalledWith({ version: 1, action: "report", offset: 0 });
    openSavedResults();
    fireEvent.click(screen.getByRole("button", { name: /Review app packaging/ }));
    expect(props.onSelect).toHaveBeenCalledWith(hash);
    rerender(<ProgrammaticChat {...props} />);
    const review = screen.getByRole("button", { name: "Review setup" }) as HTMLButtonElement;
    expect(review.disabled).toBe(false);
    fireEvent.click(review);
    expect(props.onAction).toHaveBeenLastCalledWith({ version: 1, action: "inspect-setup" });
  });

  it("gates stale, missing, loading and uncertain states without dropping the report", () => {
    const { props, rerender } = fixture({ reconcile: true, error: "Unknown acknowledgement" });
    expect(
      (screen.getByRole("button", { name: "Review task approval" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByRole("alert").textContent).toBe("We couldn't confirm whether this was saved. Check the saved results before trying again.");
    const errorDetails = screen.getByText("Error details");
    expect(errorDetails.closest("details")!.open).toBe(false);
    fireEvent.click(errorDetails);
    expect(screen.getByText("Unknown acknowledgement")).toBeTruthy();
    expect(props.onAction).not.toHaveBeenCalled();
    expect(props.onRun).not.toHaveBeenCalled();
    const recovery = screen.getByRole("button", { name: "Retry loading results" });
    expect(recovery.closest(".programmatic-stage")).toBeNull();
    expect(recovery.closest("details")).toBeNull();
    fireEvent.click(recovery);
    expect(props.onAction).toHaveBeenCalledWith({ version: 1, action: "report", offset: 0 });
    rerender(<ProgrammaticChat {...props} state={{ ...props.state, operation: "scan" }} />);
    expect(screen.getByRole("status").textContent).toBe("Working…");
    expect((screen.getByRole("button", { name: "Retry loading results" }) as HTMLButtonElement).disabled).toBe(true);
    openSavedResults();
    expect(screen.getByRole("button", { name: /Review app packaging/ })).toBeTruthy();
    rerender(
      <ProgrammaticChat
        {...props}
        state={{ ...props.state, detail: null, missingSelection: true }}
      />,
    );
    expect(screen.getByText(/none was selected for you/)).toBeTruthy();
  });
});
