import { describe, expect, it } from "vitest";
import {
  isPhaseBindingOutcome,
  isPhaseBindingProtocolRequest,
  isPhaseBindingRequest,
  isPhaseExecutionReconciliationOutcome,
  isPhaseExecutionReconciliationRequestV3,
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
    confirmTakeover: false,
    takeoverReason: null,
    predecessorProof: null,
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
    expect(
      isPhaseLeaseRequest({
        ...acquire,
        action: "takeover",
        lease: { leaseId: lease.leaseId, fence: lease.fence },
        confirmTakeover: true,
        takeoverReason: "Continue recovery in this session",
      }),
    ).toBe(true);
  });

  it("rejects release requests and released outcomes", () => {
    const release = {
      ...acquire,
      action: "release",
      lease: { leaseId: lease.leaseId, fence: lease.fence },
    };
    expect(isPhaseLeaseRequest(release)).toBe(false);
    expect(isPhaseBindingProtocolRequest(release)).toBe(false);
    expect(
      isPhaseLeaseOutcome({
        status: "released",
        roadmapRevision: 4,
        leaseRevision: 2,
        phaseId: "phase-1",
        lease: null,
      }),
    ).toBe(false);
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

describe("phase execution reconciliation protocol", () => {
  const repository = {
    projectKey: "c:/work/project",
    identityHash: "1".repeat(64),
    rootCommit: "2".repeat(40),
  };
  const workspace = {
    version: 1 as const,
    repository,
    headCommit: "3".repeat(40),
    worktreeDigest: "4".repeat(64),
    clean: true,
  };
  const reconciliation = {
    version: 3,
    action: "reconcile-execution",
    phaseId: "phase-1",
    expectedProjectKey: repository.projectKey,
    expectedRevision: 7,
    operationId: "reconcile-1",
    repository,
    plan: {
      planId: "plan-1",
      contentHash: "5".repeat(64),
      snapshotPath: ".gg/plans/plan-1.md",
      approvedAt: "2026-08-31T12:00:00.000Z",
      approvedRevision: 6,
      baseCommit: "2".repeat(40),
    },
    workspace,
  };

  it("accepts only exact, fully fenced requests", () => {
    expect(isPhaseExecutionReconciliationRequestV3(reconciliation)).toBe(true);
    expect(isPhaseExecutionReconciliationRequestV3({ ...reconciliation, extra: true })).toBe(false);
    expect(
      isPhaseExecutionReconciliationRequestV3({
        ...reconciliation,
        plan: { ...reconciliation.plan, contentHash: "wrong" },
      }),
    ).toBe(false);
    expect(
      isPhaseExecutionReconciliationRequestV3({
        ...reconciliation,
        workspace: { ...workspace, worktreeDigest: "wrong" },
      }),
    ).toBe(false);
    expect(
      isPhaseExecutionReconciliationRequestV3({
        ...reconciliation,
        workspace: {
          ...workspace,
          repository: { ...repository, identityHash: "9".repeat(64) },
        },
      }),
    ).toBe(false);
  });

  it("accepts exact success and denial outcomes", () => {
    expect(
      isPhaseExecutionReconciliationOutcome({
        status: "reconciled",
        revision: 8,
        phaseId: "phase-1",
        preservedStepIds: ["step-1"],
        revalidationStepIds: ["step-2"],
        revalidationEvidenceCount: 1,
        reconciledAt: "2026-08-31T12:01:00.000Z",
      }),
    ).toBe(true);
    expect(isPhaseExecutionReconciliationOutcome({ status: "workspace-mismatch" })).toBe(true);
    expect(
      isPhaseExecutionReconciliationOutcome({ status: "workspace-mismatch", revision: 8 }),
    ).toBe(false);
  });
});