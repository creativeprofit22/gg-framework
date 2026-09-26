import { describe, expect, it } from "vitest";
import { describeRunVerification, describeTurnVerification } from "./run-status.js";
import { SessionVerificationEvidenceLedger } from "./verification-evidence.js";

let execution = 0;
function check(ledger: SessionVerificationEvidenceLedger, command = "pnpm test", exitCode = 0) {
  ledger.recordToolResult({
    name: "bash", args: { command }, evidenceRevision: ledger.revision,
    evidenceRun: ledger.runId, isError: exitCode !== 0,
    details: { bashDiagnostics: { executionId: `status-${++execution}`, command,
      cwd: process.cwd(), startedAt: Date.now(), reason: exitCode === 0 ? "completed" : "nonZeroExit", exitCode } },
  });
}
const mutate = (ledger: SessionVerificationEvidenceLedger) =>
  ledger.recordToolResult({ name: "edit", args: {}, isError: false });
const turn = (ledger: SessionVerificationEvidenceLedger) => describeTurnVerification(ledger.runActivity(), null);
const workspace = (ledger: SessionVerificationEvidenceLedger) => describeRunVerification(ledger.workspaceEvidence(), null);

describe("desktop verification evidence", () => {
  it("does not mislabel a current pending check as an earlier workspace warning", () => {
    const ledger = new SessionVerificationEvidenceLedger();
    ledger.beginRun();
    ledger.recordToolResult({ name: "bash", args: { command: "pnpm test" }, isError: false });
    expect(describeTurnVerification(ledger.runActivity(), "A background check is still running.").verification).toBe("incomplete");
    ledger.beginRun();
    expect(ledger.runActivity().checked).toBe(false);
  });

  it.each(["passed", "failed", "unverified"])("does not attribute earlier %s work to a read-only request", (earlier) => {
    const ledger = new SessionVerificationEvidenceLedger();
    mutate(ledger);
    if (earlier === "passed") check(ledger);
    if (earlier === "failed") check(ledger, "pnpm test", 1);
    if (earlier === "unverified") check(ledger, "npm test --help");
    const previous = workspace(ledger);
    ledger.beginRun();
    expect(turn(ledger)).toEqual({ changed: false, verification: "not_recorded", verifiedChecks: 0, reason: "" });
    expect(workspace(ledger)).toEqual(previous);
  });

  it("reports a new passing check separately from an earlier different failure", () => {
    const ledger = new SessionVerificationEvidenceLedger();
    check(ledger, "pnpm test", 1);
    ledger.beginRun();
    check(ledger, "pnpm lint");
    expect(turn(ledger).verification).toBe("passed");
    expect(workspace(ledger).verification).toBe("failed");
    check(ledger);
    expect(workspace(ledger).verification).toBe("passed");
  });

  it("rejects stale checks after an edit within the current run", () => {
    const ledger = new SessionVerificationEvidenceLedger();
    ledger.beginRun();
    check(ledger);
    mutate(ledger);
    expect(turn(ledger)).toMatchObject({ changed: true, verification: "incomplete", verifiedChecks: 0 });
    check(ledger);
    expect(turn(ledger)).toMatchObject({ changed: true, verification: "passed", verifiedChecks: 1 });
  });

  it("keeps rejected checks unverified and resets run evidence on a new session", () => {
    const ledger = new SessionVerificationEvidenceLedger();
    check(ledger, "npm test --help");
    expect(turn(ledger).verification).toBe("incomplete");
    ledger.clear();
    expect(turn(ledger)).toMatchObject({ changed: false, verification: "not_recorded" });
    expect(ledger.workspaceEvidence()).toEqual([]);
  });

  it("never equates no evidence with a passing check", () => {
    expect(describeRunVerification([], null)).toEqual({ verification: "not_recorded", verifiedChecks: 0 });
    expect(describeRunVerification([], "Verification owed").verification).toBe("incomplete");
  });

  it("uses current-revision successes and rejects stale passes", () => {
    const ledger = new SessionVerificationEvidenceLedger();
    mutate(ledger);
    check(ledger);
    expect(workspace(ledger)).toEqual({ verification: "passed", verifiedChecks: 1 });
    mutate(ledger);
    expect(workspace(ledger)).toEqual({ verification: "incomplete", verifiedChecks: 0 });
  });

  it("a failure is not hidden by another passing command", () => {
    const ledger = new SessionVerificationEvidenceLedger();
    mutate(ledger);
    check(ledger, "pnpm test", 1);
    check(ledger, "pnpm build");
    expect(workspace(ledger).verification).toBe("failed");
  });

  it("an unresolved integrity gate is not green even with passing tests", () => {
    expect(describeRunVerification([{ command: "pnpm test", status: "passed", reason: "Exit 0" }], "Review test changes").verification).toBe("incomplete");
  });
});
