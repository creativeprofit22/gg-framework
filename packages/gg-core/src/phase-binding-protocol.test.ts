import { describe, expect, it } from "vitest";
import { isPhaseBindingOutcome, isPhaseBindingRequest } from "./phase-binding-protocol.js";

const previousSession = { sessionId: "session-a", sessionPath: "C:\\sessions\\a.jsonl" };
const request = {
  version: 1,
  action: "rebind-current",
  phaseId: "phase-1",
  expectedProjectKey: "c:/work/project",
  expectedRevision: 4,
  expectedPreviousSession: previousSession,
  operationId: "operation-1",
  confirmRebind: true,
};

describe("phase binding protocol", () => {
  it("accepts exact bind-current and rebind-current requests", () => {
    expect(isPhaseBindingRequest(request)).toBe(true);
    expect(
      isPhaseBindingRequest({
        ...request,
        action: "bind-current",
        expectedPreviousSession: null,
        confirmRebind: false,
      }),
    ).toBe(true);
  });

  it.each([
    { ...request, extra: true },
    { ...request, action: "bind-current" },
    { ...request, confirmRebind: false },
    { ...request, expectedRevision: -1 },
    { ...request, expectedProjectKey: " " },
    { ...request, operationId: "x".repeat(257) },
    { ...request, expectedPreviousSession: { sessionId: "", sessionPath: null } },
  ])("rejects malformed or ambiguous requests", (value) => {
    expect(isPhaseBindingRequest(value)).toBe(false);
  });

  it.each([
    {
      status: "committed",
      revision: 5,
      phaseId: "phase-1",
      previousSession,
      session: { sessionId: "session-b", sessionPath: "C:\\sessions\\b.jsonl" },
    },
    {
      status: "already-bound",
      revision: 5,
      phaseId: "phase-1",
      session: previousSession,
    },
    { status: "duplicate-id-conflict", revision: 5 },
    { status: "stale-revision", revision: 5 },
    { status: "stale-previous-session", revision: 5, currentSession: previousSession },
    { status: "project-mismatch", revision: 5, currentProjectKey: "c:/work/current" },
    { status: "phase-terminal" },
    { status: "missing-session-path" },
    { status: "missing" },
    { status: "corrupt", primary: "malformed-json", backup: null },
  ])("accepts exact typed outcome %o", (outcome) => {
    expect(isPhaseBindingOutcome(outcome)).toBe(true);
  });

  it.each([
    { status: "committed", revision: 5, phaseId: "phase-1", session: previousSession },
    { status: "stale-revision", revision: 5, message: "extra" },
    { status: "project-mismatch", revision: 5 },
    { status: "unknown" },
    { status: "corrupt", primary: "unknown", backup: null },
  ])("rejects malformed outcomes %o", (outcome) => {
    expect(isPhaseBindingOutcome(outcome)).toBe(false);
  });
});
