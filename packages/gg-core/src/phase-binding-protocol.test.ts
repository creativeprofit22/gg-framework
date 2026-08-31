import { describe, expect, it } from "vitest";
import {
  isPhaseBindingOutcome,
  isPhaseBindingProtocolRequest,
  isPhaseBindingRequest,
  isPhaseLease,
  isPhaseLeaseOutcome,
  isPhaseLeaseRequest,
} from "./phase-binding-protocol.js";

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


describe("phase lease protocol", () => {
  const lease = {
    version: 1,
    projectKey: "c:/work/project",
    phaseId: "phase-1",
    planId: "plan-1",
    leaseId: "lease-1",
    fence: 2,
    holder: {
      daemonInstanceId: "daemon-1",
      sessionId: "session-a",
      sessionPath: "C:\\sessions\\a.jsonl",
      processId: 123,
    },
    runState: "idle",
    acquiredAt: "2026-08-30T10:00:00.000Z",
    renewedAt: "2026-08-30T10:00:30.000Z",
    expiresAt: "2026-08-30T10:02:30.000Z",
    operationId: "operation-1",
  };
  const acquire = {
    version: 2,
    action: "acquire",
    phaseId: "phase-1",
    expectedProjectKey: "c:/work/project",
    expectedRevision: 4,
    planId: "plan-1",
    operationId: "operation-1",
    lease: null,
  };

  it("accepts strict v2 lease requests and leases", () => {
    expect(isPhaseLeaseRequest(acquire)).toBe(true);
    expect(isPhaseBindingProtocolRequest(acquire)).toBe(true);
    expect(isPhaseLease(lease)).toBe(true);
    expect(
      isPhaseLeaseRequest({
        ...acquire,
        action: "renew",
        lease: { leaseId: lease.leaseId, fence: lease.fence },
      }),
    ).toBe(true);
  });

  it.each([
    { ...acquire, extra: true },
    { ...acquire, action: "renew" },
    { ...acquire, planId: "" },
    { ...acquire, expectedRevision: -1 },
    { ...acquire, lease: { leaseId: "lease-1", fence: 0 } },
  ])("rejects malformed lease requests %o", (value) => {
    expect(isPhaseLeaseRequest(value)).toBe(false);
  });

  it.each([
    { ...lease, fence: 0 },
    { ...lease, phaseId: "" },
    { ...lease, expiresAt: lease.renewedAt },
    { ...lease, holder: { ...lease.holder, processId: -1 } },
    { ...lease, acquiredAt: "later" },
  ])("rejects malformed leases %o", (value) => {
    expect(isPhaseLease(value)).toBe(false);
  });

  it("validates typed lease outcomes and cross-phase identity", () => {
    expect(
      isPhaseLeaseOutcome({
        status: "acquired",
        roadmapRevision: 4,
        leaseRevision: 1,
        phaseId: "phase-1",
        lease,
      }),
    ).toBe(true);
    expect(
      isPhaseLeaseOutcome({
        status: "acquired",
        roadmapRevision: 4,
        leaseRevision: 1,
        phaseId: "phase-2",
        lease,
      }),
    ).toBe(false);
  });
});
