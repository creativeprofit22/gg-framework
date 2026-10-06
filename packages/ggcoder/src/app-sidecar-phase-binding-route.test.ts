import { describe, expect, it } from "vitest";
import type {
  PhaseBindingOutcome,
  PhaseExecutionReconciliationRequestV3,
} from "@kenkaiiii/gg-core/phase-binding-protocol";
import {
  isPhaseBindingRoute,
  parsePhaseBindingBody,
  phaseBindingHttpStatus,
} from "./app-sidecar-phase-binding-route.js";

const body = {
  version: 1,
  action: "rebind-current",
  phaseId: "phase-1",
  expectedProjectKey: "c:/work/project",
  expectedRevision: 4,
  expectedPreviousSession: {
    sessionId: "session-a",
    sessionPath: "C:\\sessions\\a.jsonl",
  },
  operationId: "operation-1",
  confirmRebind: true,
};

const reconciliationRequest: PhaseExecutionReconciliationRequestV3 = {
  version: 3,
  action: "reconcile-execution",
  phaseId: "phase-1",
  expectedProjectKey: "c:/work/project",
  expectedRevision: 4,
  operationId: "reconcile-1",
  plan: {
    planId: "plan-1",
    contentHash: "a".repeat(64),
    snapshotPath: ".gg/plans/plan-1.md",
    approvedAt: "2026-08-31T10:00:00.000Z",
    approvedRevision: 3,
    baseCommit: "c".repeat(40),
  },
  repository: {
    projectKey: "c:/work/project",
    identityHash: "b".repeat(64),
    rootCommit: "c".repeat(40),
  },
  workspace: {
    version: 1,
    repository: {
      projectKey: "c:/work/project",
      identityHash: "b".repeat(64),
      rootCommit: "c".repeat(40),
    },
    headCommit: "d".repeat(40),
    worktreeDigest: "e".repeat(64),
    clean: true,
  },
};

describe("phase binding route", () => {
  it("matches only the exact POST path", () => {
    expect(isPhaseBindingRoute("POST", "/notes/roadmap/phase-binding?source=native")).toBe(true);
    expect(isPhaseBindingRoute("GET", "/notes/roadmap/phase-binding")).toBe(false);
    expect(isPhaseBindingRoute("POST", "/notes/roadmap/phase-binding/other")).toBe(false);
  });

  it("parses only the strict shared request body", () => {
    expect(parsePhaseBindingBody(body)).toEqual(body);
    expect(
      parsePhaseBindingBody({ ...body, destinationSession: { sessionId: "chosen" } }),
    ).toBeNull();
    expect(parsePhaseBindingBody({ ...body, confirmRebind: false })).toBeNull();
  });

  it.each([
    [
      {
        status: "committed",
        revision: 5,
        phaseId: "phase-1",
        previousSession: body.expectedPreviousSession,
        session: body.expectedPreviousSession,
      },
      200,
    ],
    [
      {
        status: "already-bound",
        revision: 5,
        phaseId: "phase-1",
        session: body.expectedPreviousSession,
      },
      200,
    ],
    [{ status: "phase-not-found" }, 404],
    [{ status: "missing" }, 404],
    [{ status: "stale-revision", revision: 5 }, 409],
    [{ status: "missing-session-path" }, 409],
    [{ status: "corrupt", primary: "malformed-json", backup: null }, 500],
  ] as const)("maps %o to HTTP %s", (outcome, status) => {
    expect(phaseBindingHttpStatus(outcome as PhaseBindingOutcome)).toBe(status);
  });
  it("parses reconciliation and rejects malformed payloads", () => {
    expect(parsePhaseBindingBody(reconciliationRequest)).toEqual(reconciliationRequest);
    expect(
      parsePhaseBindingBody({
        ...reconciliationRequest,
        workspace: { ...reconciliationRequest.workspace, clean: "yes" },
      }),
    ).toBeNull();
    expect(parsePhaseBindingBody({ ...reconciliationRequest, unexpected: true })).toBeNull();
  });

  it("rejects caller-supplied V2 predecessor proof", () => {
    expect(
      parsePhaseBindingBody({
        version: 2,
        action: "takeover",
        phaseId: "phase-1",
        expectedProjectKey: "c:/work/project",
        expectedRevision: 4,
        planId: "plan-1",
        operationId: "operation-2",
        lease: { leaseId: "lease-1", fence: 1 },
        confirmTakeover: true,
        takeoverReason: "caller takeover",
        predecessorProof: {
          daemonInstanceId: "daemon-a",
          processId: 42,
          processStartToken: "start-a",
          terminatedAt: "2026-08-30T10:00:00.000Z",
        },
      }),
    ).toBeNull();
  });

  it.each([
    [
      {
        status: "committed",
        revision: 5,
        phaseId: "phase-1",
        previousSession: body.expectedPreviousSession,
        session: body.expectedPreviousSession,
      },
      200,
    ],
    [
      {
        status: "already-bound",
        revision: 5,
        phaseId: "phase-1",
        session: body.expectedPreviousSession,
      },
      200,
    ],
    [{ status: "phase-not-found" }, 404],
    [{ status: "missing" }, 404],
    [{ status: "stale-revision", revision: 5 }, 409],
    [{ status: "missing-session-path" }, 409],
    [{ status: "corrupt", primary: "malformed-json", backup: null }, 500],
  ] as const)("maps %o to HTTP %s", (outcome, status) => {
    expect(phaseBindingHttpStatus(outcome as PhaseBindingOutcome)).toBe(status);
  });

  it("maps reconciliation success and typed denials without translation", () => {
    expect(
      phaseBindingHttpStatus({
        status: "reconciled",
        revision: 5,
        phaseId: "phase-1",
        preservedStepIds: ["step-1"],
        revalidationStepIds: ["step-2"],
        revalidationEvidenceCount: 1,
        reconciledAt: "2026-08-31T10:05:00.000Z",
      }),
    ).toBe(200);
    expect(phaseBindingHttpStatus({ status: "workspace-mismatch" })).toBe(409);
    expect(phaseBindingHttpStatus({ status: "lease-corrupt" })).toBe(500);
  });
});
