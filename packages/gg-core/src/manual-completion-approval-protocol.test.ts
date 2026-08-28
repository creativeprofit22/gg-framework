import { describe, expect, it } from "vitest";
import {
  isManualCompletionApprovalCommitOutcome,
  isManualCompletionApprovalCommitRequest,
  isManualCompletionApprovalPreviewOutcome,
  isManualCompletionApprovalPreviewRequest,
} from "./manual-completion-approval-protocol.js";

const checkpoint = {
  nonce: "nonce-1",
  projectKey: "c:/work/project",
  phaseId: "phase-1",
  revision: 4,
  session: { sessionId: "session-1", sessionPath: "C:\\sessions\\1.jsonl" },
  implementationCheckpointId: "implementation-1",
  verificationStatusUpdateId: "verification-1",
  expiresAt: "2026-08-27T21:20:00.000Z",
};

describe("manual completion approval protocol", () => {
  it("accepts exact preview and confirmed commit requests", () => {
    expect(
      isManualCompletionApprovalPreviewRequest({
        version: 1,
        phaseId: "phase-1",
        expectedRevision: 4,
      }),
    ).toBe(true);
    expect(
      isManualCompletionApprovalCommitRequest({ version: 1, nonce: "nonce-1", confirmed: true }),
    ).toBe(true);
  });

  it.each([
    { version: 1, phaseId: "phase-1", expectedRevision: 4, sessionId: "chosen" },
    { version: 1, phaseId: "phase-1", expectedRevision: -1 },
    { version: 1, nonce: "nonce-1", confirmed: false },
    { version: 1, nonce: "", confirmed: true },
  ])("rejects malformed or authority-expanding requests", (value) => {
    expect(
      isManualCompletionApprovalPreviewRequest(value) ||
        isManualCompletionApprovalCommitRequest(value),
    ).toBe(false);
  });

  it.each([
    { status: "ready", checkpoint },
    { status: "stale-revision", revision: 5 },
    { status: "unmet-gate", revision: 4, code: "stale-verification" },
    { status: "missing" },
    { status: "corrupt", primary: "malformed-json", backup: null },
  ])("parses strict preview outcome %o", (value) => {
    expect(isManualCompletionApprovalPreviewOutcome(value)).toBe(true);
  });

  it.each([
    { status: "committed", revision: 5, phaseId: "phase-1", approvalId: "approval-1" },
    { status: "duplicate", revision: 5, phaseId: "phase-1", approvalId: "approval-1" },
    { status: "nonce-not-found" },
    { status: "nonce-expired" },
    { status: "unmet-gate", revision: 4, code: "failed-verification" },
  ])("parses strict commit outcome %o", (value) => {
    expect(isManualCompletionApprovalCommitOutcome(value)).toBe(true);
  });

  it.each([
    { status: "ready", checkpoint: { ...checkpoint, session: { ...checkpoint.session, sessionPath: null } } },
    { status: "unmet-gate", revision: 4, code: "unknown" },
    { status: "committed", revision: 5, phaseId: "phase-1", approvalId: "approval-1", reviewer: "ken" },
  ])("fails closed for invalid outcomes %o", (value) => {
    expect(
      isManualCompletionApprovalPreviewOutcome(value) ||
        isManualCompletionApprovalCommitOutcome(value),
    ).toBe(false);
  });
});
