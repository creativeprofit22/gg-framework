import { describe, expect, it } from "vitest";
import { describeRunVerification, describeTurnVerification } from "./run-status.js";
import { VerificationGate } from "./verification-gate.js";

describe("desktop verification evidence", () => {
  const turn = (gate: VerificationGate) =>
    describeTurnVerification(
      {
        changed: gate.changedThisRun,
        checked: gate.checkedThisRun,
        evidence: gate.evidence("run"),
      },
      gate.verificationProblem(),
    );

  it("does not mislabel a current pending check as an earlier workspace warning", () => {
    const gate = new VerificationGate();
    gate.beginRun();
    gate.recordVerificationAttempt();
    const activity = {
      changed: gate.changedThisRun,
      checked: gate.checkedThisRun,
      evidence: gate.evidence("run"),
    };
    expect(
      describeTurnVerification(activity, "A background check is still running.").verification,
    ).toBe("incomplete");
    gate.beginRun();
    expect(gate.checkedThisRun).toBe(false);
  });

  it.each(["passed", "failed", "unverified"])(
    "does not attribute earlier %s work to a read-only request",
    (earlier) => {
      const gate = new VerificationGate();
      gate.recordMutation("src/example.ts");
      if (earlier === "passed") gate.recordVerification(gate.revision, "pnpm test");
      if (earlier === "failed") gate.recordFailedVerification("pnpm test");
      const workspace = describeRunVerification(gate.evidence(), gate.verificationProblem());
      gate.beginRun();
      expect(turn(gate)).toEqual({
        changed: false,
        verification: "not_recorded",
        verifiedChecks: 0,
        reason: "",
      });
      expect(describeRunVerification(gate.evidence(), gate.verificationProblem())).toEqual(
        workspace,
      );
    },
  );

  it("reports a new passing check separately from an earlier different failure", () => {
    const gate = new VerificationGate();
    gate.recordFailedVerification("pnpm test");
    gate.beginRun();
    gate.recordVerification(gate.revision, "pnpm lint");
    expect(turn(gate).verification).toBe("passed");
    expect(describeRunVerification(gate.evidence(), gate.verificationProblem()).verification).toBe(
      "failed",
    );
    gate.recordVerification(gate.revision, "pnpm test");
    expect(gate.verificationProblem()).toBeNull();
  });

  it("rejects stale checks after an edit within the current run", () => {
    const gate = new VerificationGate();
    gate.beginRun();
    gate.recordVerification(gate.revision, "pnpm test");
    gate.recordMutation("src/example.ts");
    expect(turn(gate)).toMatchObject({
      changed: true,
      verification: "incomplete",
      verifiedChecks: 0,
    });
    gate.recordVerification(gate.revision, "pnpm test");
    expect(turn(gate)).toMatchObject({ changed: true, verification: "passed", verifiedChecks: 1 });
  });

  it("keeps rejected checks unverified and resets run evidence on a new session", () => {
    const gate = new VerificationGate();
    gate.requireFreshVerification();
    gate.recordRejectedCheck("npm test --help", "Help is not a test run");
    expect(turn(gate).verification).toBe("incomplete");
    gate.reset();
    expect(turn(gate)).toMatchObject({ changed: false, verification: "not_recorded" });
    expect(gate.evidence()).toEqual([]);
  });
  it("never equates no evidence with a passing check", () => {
    expect(describeRunVerification([], null)).toEqual({
      verification: "not_recorded",
      verifiedChecks: 0,
    });
    expect(describeRunVerification([], "Verification owed").verification).toBe("incomplete");
  });
  it("uses current-revision successes and rejects stale passes", () => {
    const gate = new VerificationGate();
    gate.recordMutation("src/example.ts");
    gate.recordVerification(gate.revision, "pnpm test");
    expect(describeRunVerification(gate.evidence(), gate.verificationProblem())).toEqual({
      verification: "passed",
      verifiedChecks: 1,
    });
    gate.recordMutation("src/example.ts");
    expect(describeRunVerification(gate.evidence(), gate.verificationProblem())).toEqual({
      verification: "incomplete",
      verifiedChecks: 0,
    });
  });
  it("a failure is not hidden by another passing command", () => {
    const gate = new VerificationGate();
    gate.recordMutation("src/example.ts");
    gate.recordFailedVerification("pnpm test");
    gate.recordVerification(gate.revision, "pnpm build");
    expect(describeRunVerification(gate.evidence(), gate.verificationProblem()).verification).toBe(
      "failed",
    );
  });
  it("an unresolved integrity gate is not green even with passing tests", () => {
    expect(
      describeRunVerification(
        [{ command: "pnpm test", status: "passed", reason: "Exit 0" }],
        "Review test changes",
      ).verification,
    ).toBe("incomplete");
  });
});
