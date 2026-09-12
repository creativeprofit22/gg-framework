import { describe, expect, it } from "vitest";
import {
  initialProgrammaticChatState,
  programmaticChatReducer,
  canRunProgrammaticSelection,
} from "./programmatic-chat-state";
const hash = "a".repeat(64);
const proposal = { handle: hash, fingerprint: hash, profileJson: "exact profile", routes: [], exclusions: [], configurationInputs: [] };
describe("programmatic state", () => {
  it.each(["rejected", "uncertain", "inspection-failed"])("requires fresh inspection after %s without losing proposal context", (failure) => {
    let state = programmaticChatReducer(initialProgrammaticChatState("one"), {
      type: "response", generation: "one", epoch: 0,
      response: { version: 1, action: "inspect-setup", ok: true, proposal },
    });
    expect(state.proposalApprovable).toBe(true);
    state = programmaticChatReducer(state, { type: "start", generation: "one", epoch: 1,
      operation: failure === "inspection-failed" ? "inspect-setup" : "approve-setup" });
    state = programmaticChatReducer(state, failure === "uncertain"
      ? { type: "error", generation: "one", epoch: 1, error: "unknown", reconcile: true }
      : { type: "response", generation: "one", epoch: 1, response: { version: 1,
          action: failure === "inspection-failed" ? "inspect-setup" : "approve-setup",
          ok: false, error: "rejected", reconcile: false } });
    expect(state.proposalApprovable).toBe(false);
    expect(state.proposal).toBe(proposal);
    state = programmaticChatReducer(state, { type: "response", generation: "one", epoch: 1,
      response: { version: 1, action: "report", ok: true, report: { status: "setup-required",
        reason: "Inspect setup", scan: { available: false, reason: "Approve setup" }, snapshot: null,
        fingerprint: null, offset: 0, total: 0, rows: [] } } });
    expect(state.reconcile).toBe(false);
    expect(state.proposalApprovable).toBe(false);
    const fresh = { ...proposal, handle: "b".repeat(64) };
    state = programmaticChatReducer(state, { type: "start", generation: "one", epoch: 2, operation: "inspect-setup" });
    state = programmaticChatReducer(state, { type: "response", generation: "one", epoch: 2,
      response: { version: 1, action: "inspect-setup", ok: true, proposal: fresh } });
    expect(state.proposal).toBe(fresh);
    expect(state.proposalApprovable).toBe(true);
  });
  it.each([undefined, hash, "b".repeat(64)])("preserves only an explicitly retained matching handle: %s", (handle) => {
    const state = { ...initialProgrammaticChatState("one"), proposal, proposalApprovable: true };
    const event = { type: "response" as const, generation: "one", epoch: 0,
      response: { version: 1 as const, action: "approve-setup" as const, ok: false as const,
        error: "Not submitted", reconcile: false, ...(handle ? { approvableProposalHandle: handle } : {}) } };
    expect(programmaticChatReducer(state, event).proposalApprovable).toBe(handle === hash);
    expect(programmaticChatReducer({ ...state, proposalApprovable: false }, event).proposalApprovable).toBe(false);
  });
  it("rejects old generations and epochs, and preserves selected context during scans", () => {
    let state = initialProgrammaticChatState("one");
    state = programmaticChatReducer(state, { type: "select", id: hash });
    state = programmaticChatReducer(state, {
      type: "start",
      generation: "one",
      epoch: 2,
      operation: "scan",
    });
    expect(state.selectedId).toBe(hash);
    expect(
      programmaticChatReducer(state, {
        type: "error",
        generation: "one",
        epoch: 1,
        error: "late",
        reconcile: true,
      }),
    ).toBe(state);
    expect(
      programmaticChatReducer(state, {
        type: "error",
        generation: "old",
        epoch: 2,
        error: "late",
        reconcile: true,
      }),
    ).toBe(state);
    const reset = programmaticChatReducer(state, { type: "reset", generation: "two" });
    expect(reset.selectedId).toBeNull();
    expect(
      programmaticChatReducer(reset, { type: "run-accepted", generation: "one", epoch: 2 }),
    ).toBe(reset);
  });
  it("keeps uncertain writes gated until an authoritative report arrives", () => {
    let state = initialProgrammaticChatState("one");
    state = programmaticChatReducer(state, {
      type: "error",
      generation: "one",
      epoch: 0,
      error: "unknown",
      reconcile: true,
    });
    expect(state.reconcile).toBe(true);
    expect(canRunProgrammaticSelection(state)).toBe(false);
    state = programmaticChatReducer(state, {
      type: "response",
      generation: "one",
      epoch: 0,
      response: {
        version: 1,
        action: "report",
        ok: true,
        report: {
          status: "setup-required",
          reason: "Inspect setup",
          scan: { available: false, reason: "Approve current setup." },
          snapshot: null,
          fingerprint: null,
          offset: 0,
          total: 0,
          rows: [],
        },
      },
    });
    expect(state.reconcile).toBe(false);
  });
  it("explains a missing recovered selection without choosing another", () => {
    let state = programmaticChatReducer(initialProgrammaticChatState("one"), {
      type: "select",
      id: hash,
    });
    state = programmaticChatReducer(state, {
      type: "response",
      generation: "one",
      epoch: 0,
      response: { version: 1, action: "detail", ok: true, snapshot: hash, detail: null },
    });
    expect(state.missingSelection).toBe(true);
    expect(state.selectedId).toBe(hash);
  });
});
