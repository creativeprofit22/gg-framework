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
});
