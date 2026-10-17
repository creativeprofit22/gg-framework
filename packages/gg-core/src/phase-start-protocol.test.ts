import { describe, expect, it } from "vitest";
import {
  isPhaseStartResult,
  isPhaseStartSession,
  toLegacyPhaseStartResult,
  type PhaseStartResult,
} from "./phase-start-protocol.js";

const session = { sessionId: "session-1", sessionPath: "/sessions/one.jsonl" };

describe("phase-start protocol", () => {
  it.each([session, { sessionId: "session-1", sessionPath: null }])(
    "accepts a canonical session link: %o",
    (value) => {
      expect(isPhaseStartSession(value)).toBe(true);
      expect(
        isPhaseStartResult({
          status: "accepted",
          operationId: "operation-1",
          session: value,
          packageTokenCount: 0,
        }),
      ).toBe(true);
    },
  );

  it.each([
    { sessionId: "", sessionPath: "/sessions/one.jsonl" },
    { sessionId: "   ", sessionPath: "/sessions/one.jsonl" },
    { sessionId: "session-1", sessionPath: "" },
    { sessionId: "session-1", sessionPath: " \t " },
    { ...session, extra: true },
  ])("rejects a malformed session link: %o", (value) => {
    expect(isPhaseStartSession(value)).toBe(false);
    expect(
      isPhaseStartResult({
        status: "accepted",
        operationId: "operation-1",
        session: value,
        packageTokenCount: 0,
      }),
    ).toBe(false);
  });

  it("accepts the advancement confirmation failure in the current protocol", () => {
    expect(
      isPhaseStartResult({
        status: "failed",
        code: "advancement-confirmation-required",
        operationId: "operation-1",
        message: "Use Start next phase to confirm this Roadmap checkpoint.",
      }),
    ).toBe(true);
  });

  it("downgrades the new failure code for legacy clients", () => {
    const result = {
      status: "failed",
      code: "advancement-confirmation-required",
      operationId: "operation-1",
      message: "Use Start next phase to confirm this Roadmap checkpoint.",
    } satisfies PhaseStartResult;

    expect(toLegacyPhaseStartResult(result)).toEqual({
      ...result,
      code: "phase-inactive",
    });
  });

  it("preserves failures understood by legacy clients", () => {
    const result = {
      status: "failed",
      code: "notes-corrupt",
      operationId: null,
      message: "Project Notes are corrupt.",
    } satisfies PhaseStartResult;

    expect(toLegacyPhaseStartResult(result)).toBe(result);
  });
  it("accepts durable lease and reconciliation outcomes", () => {
    const lease = {
      version: 1 as const,
      projectKey: "c:/work/project",
      phaseId: "phase-1",
      planId: "plan-1",
      leaseId: "lease-1",
      fence: 1,
      holder: {
        daemonInstanceId: "daemon-1",
        sessionId: session.sessionId,
        sessionPath: session.sessionPath,
        processId: 123,
      },
      runState: "idle" as const,
      acquiredAt: "2026-08-30T10:00:00.000Z",
      renewedAt: "2026-08-30T10:00:30.000Z",
      expiresAt: "2026-08-30T10:02:30.000Z",
      operationId: "operation-1",
    };
    const result = {
      status: "accepted" as const,
      operationId: "operation-1",
      session,
      packageTokenCount: 12,
      lease,
      reconciliation: "ready" as const,
    };

    expect(isPhaseStartResult(result)).toBe(true);
    expect(toLegacyPhaseStartResult(result)).toEqual({
      status: "accepted",
      operationId: "operation-1",
      session,
      packageTokenCount: 12,
    });
    expect(isPhaseStartResult({ ...result, reconciliation: "unknown" })).toBe(false);
  });

  it("downgrades durable-only recovery failures for legacy clients", () => {
    const result = {
      status: "failed",
      code: "plan-reconciliation-required",
      operationId: "operation-1",
      message: "Reconcile the approved plan before resuming.",
    } satisfies PhaseStartResult;
    expect(toLegacyPhaseStartResult(result)).toMatchObject({ code: "launch-failed" });
  });
});
