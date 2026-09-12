// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProgrammaticChat } from "./ProgrammaticChat";
import {
  initialProgrammaticChatState,
  programmaticChatReducer,
  type ProgrammaticChatState,
} from "./programmatic-chat-state";
const hash = "a".repeat(64);
afterEach(cleanup);
function fixture(overrides: Partial<ProgrammaticChatState> = {}) {
  const summary = {
    id: hash,
    expectedOutput: "Review app packaging",
    state: "discovered" as const,
    presence: "present" as const,
    mutationPaths: [],
    actions: { run: { available: true, reason: "Can run." }, dismiss: { available: true, reason: "Can dismiss." } },
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
describe("embedded opportunity review", () => {
  it.each([true, false])("keeps inspection available while another pane owns a run (owner visible: %s)", (ownerVisible) => {
    const { props, rerender } = fixture();
    const blocked = { available: false, reason: "An opportunity is running in this project." };
    const summary = { ...props.state.detail!.summary, actions: { run: blocked, dismiss: blocked } };
    const owner = { ...summary, id: "b".repeat(64), state: "running" as const, expectedOutput: "Other pane's run" };
    const report = { ...props.state.report!, total: 51, scan: blocked, rows: ownerVisible ? [summary, owner] : [summary] };
    const state = { ...props.state, report, detail: { ...props.state.detail!, summary } };
    rerender(<ProgrammaticChat {...props} state={state} />);
    for (const name of ["Review task approval", "Dismiss this item", "Check for opportunities"]) {
      const button = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.title).toBe(blocked.reason);
      fireEvent.click(button);
    }
    expect(props.onRun).not.toHaveBeenCalled();
    expect(props.onAction).not.toHaveBeenCalled();
    for (const name of ["Review setup", "Refresh results", "Next opportunities", /Review app packaging/])
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /Review app packaging/ }));
    expect(props.onSelect).toHaveBeenCalledWith(hash);
    fireEvent.click(screen.getByText("Why this was suggested and how to check it"));
    expect(screen.getByText("Manifest exists")).toBeTruthy();
    let fresh = programmaticChatReducer(state, { type: "response", generation: "one", epoch: 0,
      response: { version: 1, action: "report", ok: true, report: { ...props.state.report!, snapshot: "c".repeat(64) } } });
    rerender(<ProgrammaticChat {...props} state={fresh} />);
    expect((screen.getByRole("button", { name: "Review task approval" }) as HTMLButtonElement).disabled).toBe(true);
    fresh = programmaticChatReducer(fresh, { type: "response", generation: "one", epoch: 0,
      response: { version: 1, action: "detail", ok: true, snapshot: "c".repeat(64), detail: props.state.detail } });
    rerender(<ProgrammaticChat {...props} state={fresh} />);
    for (const name of ["Review task approval", "Dismiss this item", "Check for opportunities"])
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("keeps Previous reachable for an empty recovered tail and never renders an inverted range", () => {
    const { props, rerender } = fixture();
    const state = { ...props.state, report: { ...props.state.report!, status: "recovered" as const,
      offset: 1, total: 1, rows: [] } };
    rerender(<ProgrammaticChat {...props} state={state} />);
    expect(screen.queryByText("2–1 of 1")).toBeNull();
    expect(screen.getByText("No opportunities on this page (1 total).")).toBeTruthy();
    const previous = screen.getByRole("button", { name: "Previous opportunities" });
    expect((previous as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(previous);
    expect(props.onAction).toHaveBeenCalledExactlyOnceWith({ version: 1, action: "report", offset: 0 });
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onRun).not.toHaveBeenCalled();
  });

  it.each([
    { oldOffset: 50, total: 1, offset: 0 },
    { oldOffset: 50, total: 0, offset: 0 },
    { oldOffset: 100, total: 51, offset: 50 },
  ])("keeps selection while a page at $oldOffset recovers to $total records", ({ oldOffset, total, offset }) => {
    const { props, rerender } = fixture();
    const selected = props.state.detail!;
    let state: ProgrammaticChatState = { ...props.state, report: { ...props.state.report!, offset: oldOffset, total: 151 } };
    rerender(<ProgrammaticChat {...props} state={state} />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh results" }));
    expect(props.onAction).toHaveBeenCalledExactlyOnceWith({ version: 1, action: "report", offset: oldOffset });
    const survivor = { ...selected.summary, id: "b".repeat(64), expectedOutput: "Surviving opportunity" };
    state = programmaticChatReducer(state, { type: "response", generation: "one", epoch: 0,
      response: { version: 1, action: "report", ok: true, report: { ...state.report!,
        status: "recovered", snapshot: "c".repeat(64), offset, total, rows: total ? [survivor] : [] } } });
    expect(state.selectedId).toBe(hash);
    expect(state.detail).toBe(selected);
    state = programmaticChatReducer(state, { type: "response", generation: "one", epoch: 0,
      response: { version: 1, action: "detail", ok: true, snapshot: "c".repeat(64), detail: null } });
    rerender(<ProgrammaticChat {...props} state={state} />);
    expect(state.selectedId).toBe(hash);
    expect(screen.getByText(/none was selected for you/)).toBeTruthy();
    if (total) expect(screen.getByRole("button", { name: /Surviving opportunity/ }).getAttribute("aria-pressed")).toBe("false");
    else expect(screen.getByText(/No opportunities to show/)).toBeTruthy();
    if (total > 50) {
      expect(screen.getByText("51–51 of 51")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Previous opportunities" }));
      expect(props.onAction).toHaveBeenLastCalledWith({ version: 1, action: "report", offset: 0 });
    } else expect(screen.queryByRole("navigation", { name: "Opportunity pages" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh results" }));
    expect(props.onAction).toHaveBeenLastCalledWith({ version: 1, action: "report", offset });
    expect(props.onAction.mock.calls.every(([request]) => request.action === "report")).toBe(true);
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onRun).not.toHaveBeenCalled();
  });
  it("enables only explicitly approved refresh scans while keeping execution blocked", () => {
    const { props, rerender } = fixture();
    const stale = { ...props.state, report: { ...props.state.report!, status: "stale" as const,
      scan: { available: false, reason: "Approve current setup." } } };
    rerender(<ProgrammaticChat {...props} state={stale} />);
    fireEvent.click(screen.getByRole("button", { name: "Check for opportunities" }));
    expect(props.onAction).not.toHaveBeenCalled();
    const approved = { ...stale, report: { ...stale.report,
      scan: { available: true, reason: "Approved configuration is current." } } };
    rerender(<ProgrammaticChat {...props} state={approved} />);
    expect((screen.getByRole("button", { name: "Check for opportunities" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Review task approval" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Check for opportunities" }));
    expect(props.onAction).toHaveBeenCalledExactlyOnceWith({ version: 1, action: "scan" });
    for (const locks of [{ busy: true }, { planMode: true }, { state: { ...approved, reconcile: true } }, { state: { ...approved, operation: "scan" as const } }]) {
      rerender(<ProgrammaticChat {...props} state={approved} {...locks} />);
      expect((screen.getByRole("button", { name: "Check for opportunities" }) as HTMLButtonElement).disabled).toBe(true);
    }
  });
  it("retains selected ID and detail through scan acknowledgement and fresh hydration", () => {
    const { props, rerender } = fixture();
    const detail = props.state.detail!;
    let state = { ...props.state, report: { ...props.state.report!, status: "stale" as const } } as ProgrammaticChatState;
    state = programmaticChatReducer(state, { type: "start", generation: "one", epoch: 1, operation: "scan" });
    state = programmaticChatReducer(state, { type: "response", generation: "one", epoch: 1,
      response: { version: 1, action: "scan", ok: true, changed: true } });
    expect(state.selectedId).toBe(hash);
    expect(state.detail).toBe(detail);
    const snapshot = "b".repeat(64);
    state = programmaticChatReducer(state, { type: "response", generation: "one", epoch: 1,
      response: { version: 1, action: "report", ok: true, report: { ...props.state.report!, snapshot } } });
    rerender(<ProgrammaticChat {...props} state={state} />);
    expect((screen.getByRole("button", { name: "Review task approval" }) as HTMLButtonElement).disabled).toBe(true);
    state = programmaticChatReducer(state, { type: "response", generation: "one", epoch: 1,
      response: { version: 1, action: "detail", ok: true, snapshot, detail } });
    rerender(<ProgrammaticChat {...props} state={state} />);
    expect(state.selectedId).toBe(hash);
    expect(state.detail).toBe(detail);
    expect((screen.getByRole("button", { name: "Review task approval" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("keeps selection separate from run, exposes evidence and one-record dismissal", () => {
    const { props } = fixture();
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
  it("displays exact proposal and requires its separate approval", () => {
    const { props, rerender } = fixture({
      proposalApprovable: true,
      proposal: {
        handle: hash,
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
  it.each([false, true])("cannot resubmit obsolete approval after a report (uncertain: %s)", (uncertain) => {
    const proposal = { handle: hash, fingerprint: hash, profileJson: "exact old profile",
      routes: [], exclusions: ["node_modules/**"], configurationInputs: [{ path: "package.json", sha256: hash }] };
    const { props, rerender } = fixture({ proposal, proposalApprovable: true });
    fireEvent.click(screen.getByRole("button", { name: "Approve and save setup" }));
    expect(props.onAction).toHaveBeenCalledTimes(1);
    let state = programmaticChatReducer(props.state, { type: "start", generation: "one", epoch: 1, operation: "approve-setup" });
    state = programmaticChatReducer(state, uncertain
      ? { type: "error", generation: "one", epoch: 1, error: "unknown", reconcile: true }
      : { type: "response", generation: "one", epoch: 1, response: { version: 1, action: "approve-setup", ok: false, error: "stale", reconcile: false } });
    state = programmaticChatReducer(state, { type: "response", generation: "one", epoch: 1,
      response: { version: 1, action: "report", ok: true, report: props.state.report! } });
    rerender(<ProgrammaticChat {...props} state={state} />);
    const approve = screen.getByRole("button", { name: "Approve and save setup" }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.click(approve);
    expect(props.onAction).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Review setup again before approving/)).toBeTruthy();
    expect(screen.getByLabelText("Exact settings to save").textContent).toBe(proposal.profileJson);
    fireEvent.click(screen.getByText("What is skipped and which files were checked"));
    expect(screen.getByText("node_modules/**")).toBeTruthy();
    expect(screen.getByText("package.json")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review setup" }));
    expect(props.onAction).toHaveBeenLastCalledWith({ version: 1, action: "inspect-setup" });
    const fresh = { ...proposal, handle: "b".repeat(64), profileJson: "exact fresh profile" };
    state = programmaticChatReducer(state, { type: "start", generation: "one", epoch: 2, operation: "inspect-setup" });
    state = programmaticChatReducer(state, { type: "response", generation: "one", epoch: 2,
      response: { version: 1, action: "inspect-setup", ok: true, proposal: fresh } });
    rerender(<ProgrammaticChat {...props} state={state} />);
    expect((screen.getByRole("button", { name: "Approve and save setup" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Approve and save setup" }));
    expect(props.onAction).toHaveBeenLastCalledWith({ version: 1, action: "approve-setup", proposalHandle: fresh.handle });
    expect(props.onAction).toHaveBeenCalledTimes(3);
  });
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
    const { props, rerender } = fixture({ proposalApprovable: true, proposal: { handle: hash, fingerprint: hash, profileJson: "exact profile", routes: [], exclusions: [], configurationInputs: [] } });
    const approve = screen.getByRole("button", { name: "Approve and save setup" });
    approve.focus(); approve.blur();
    rerender(<ProgrammaticChat {...props} state={{ ...props.state, proposal: null }} />);
    expect(document.activeElement).toBe(document.body);
  });

  it("shows setup-required, empty, stale, disappeared and unavailable states truthfully", () => {
    const { props, rerender } = fixture();
    const empty = { ...props.state, detail: null, report: { ...props.state.report!, rows: [], total: 0 } };
    rerender(<ProgrammaticChat {...props} state={{ ...empty, report: { ...empty.report, status: "setup-required" } }} />);
    expect(screen.getByText(/Start with Review setup/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review setup" }));
    expect(props.onAction).toHaveBeenCalledWith({ version: 1, action: "inspect-setup" });
    rerender(<ProgrammaticChat {...props} state={empty} />);
    expect(screen.getByText(/No opportunities to show/)).toBeTruthy();
    rerender(<ProgrammaticChat {...props} state={{ ...props.state, report: { ...props.state.report!, status: "stale", scan: { available: false, reason: "Approve current setup." } } }} />);
    expect((screen.getByRole("button", { name: "Check for opportunities" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Review task approval" }) as HTMLButtonElement).disabled).toBe(true);
    const summary = { ...props.state.detail!.summary, presence: "disappeared" as const, route: { ...props.state.detail!.summary.route, available: false, reason: "Specialist not installed" } };
    rerender(<ProgrammaticChat {...props} state={{ ...props.state, detail: { ...props.state.detail!, summary } }} />);
    expect(screen.getByText("Specialist not installed")).toBeTruthy();
    expect(screen.getByText(/No longer found; cannot start/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Review task approval" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<ProgrammaticChat {...props} planMode />);
    expect((screen.getByRole("button", { name: "Dismiss this item" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Review setup" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("gates stale, missing, loading and uncertain states without dropping the report", () => {
    const { props, rerender } = fixture({ reconcile: true, error: "Unknown acknowledgement" });
    expect(
      (screen.getByRole("button", { name: "Review task approval" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByRole("alert").textContent).toBe("Unknown acknowledgement");
    fireEvent.click(screen.getByRole("button", { name: "Retry loading results" }));
    expect(props.onAction).toHaveBeenCalledWith({ version: 1, action: "report", offset: 0 });
    rerender(<ProgrammaticChat {...props} state={{ ...props.state, operation: "scan" }} />);
    expect(screen.getByRole("status").textContent).toBe("Working…");
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
