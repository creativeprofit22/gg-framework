import { describe, expect, it } from "vitest";
import { SessionVerificationEvidenceLedger } from "./verification-evidence.js";

function record(
  ledger: SessionVerificationEvidenceLedger,
  id: string,
  exitCode = 0,
  run = ledger.runId,
) {
  ledger.recordToolResult({
    name: "bash",
    args: { command: "pnpm test" },
    evidenceRevision: ledger.revision,
    evidenceRun: run,
    isError: exitCode !== 0,
    details: {
      bashDiagnostics: {
        executionId: id,
        command: "pnpm test",
        cwd: process.cwd(),
        startedAt: Date.now(),
        reason: exitCode === 0 ? "completed" : "nonZeroExit",
        exitCode,
      },
    },
  });
}

describe("verificationProblem (upstream 0.86.0 rule on the fork ledger)", () => {
  const editFile = (ledger: SessionVerificationEvidenceLedger, filePath: string) =>
    ledger.recordToolResult({ name: "edit", args: { file_path: filePath }, isError: false });

  it("owes a check after a code edit and clears once one passes", () => {
    const ledger = new SessionVerificationEvidenceLedger();
    expect(ledger.verificationProblem()).toBeNull();
    editFile(ledger, "src/app.ts");
    expect(ledger.verificationProblem()).toMatch(/^Unverified: no successful check/);
    record(ledger, "after-edit");
    expect(ledger.verificationProblem()).toBeNull();
  });

  it("keeps a failed check outstanding until that check passes again", () => {
    const ledger = new SessionVerificationEvidenceLedger();
    editFile(ledger, "src/app.ts");
    record(ledger, "fails", 1);
    expect(ledger.verificationProblem()).toMatch(/^Unverified: a check failed/);
    record(ledger, "passes");
    expect(ledger.verificationProblem()).toBeNull();
  });

  it("ignores docs and plan files, and an earlier pass does not cover a later edit", () => {
    const ledger = new SessionVerificationEvidenceLedger();
    editFile(ledger, ".gg/plans/plan.md");
    editFile(ledger, "README.md");
    expect(ledger.verificationProblem()).toBeNull();
    record(ledger, "early");
    editFile(ledger, "src/app.test.ts");
    expect(ledger.verificationProblem()).toMatch(/^Unverified: no successful check/);
    ledger.clear();
    expect(ledger.verificationProblem()).toBeNull();
  });

  it("does not count a code edit refused in plan mode", () => {
    const ledger = new SessionVerificationEvidenceLedger();
    ledger.recordToolResult({
      name: "write",
      args: { file_path: "src/sneaky.ts" },
      isError: false,
      planMode: true,
    });
    expect(ledger.verificationProblem()).toBeNull();
  });
});

describe("request-scoped host verification", () => {
  it.each([0, 1])("does not inherit an earlier turn's result (%s)", (exitCode) => {
    const ledger = new SessionVerificationEvidenceLedger();
    ledger.beginRun();
    record(ledger, "first", exitCode);
    expect(ledger.runActivity().evidence).toHaveLength(1);
    ledger.beginRun();
    expect(ledger.runActivity()).toEqual({ changed: false, checked: false, evidence: [] });
    expect(ledger.snapshot().currentEvidence).toHaveLength(1);
  });

  it("does not attribute a late result to the next request", () => {
    const ledger = new SessionVerificationEvidenceLedger();
    ledger.beginRun();
    const firstRun = ledger.runId;
    ledger.beginRun();
    record(ledger, "late", 0, firstRun);
    expect(ledger.runActivity()).toEqual({ changed: false, checked: false, evidence: [] });
  });

  it("rejects earlier checks after a workspace mutation without changing Roadmap evidence ownership", () => {
    const ledger = new SessionVerificationEvidenceLedger();
    ledger.beginRun();
    record(ledger, "before-edit");
    ledger.recordToolResult({ name: "edit", args: {}, isError: false });
    expect(ledger.runActivity()).toMatchObject({
      changed: true,
      checked: true,
      evidence: [{ status: "rejected" }],
    });
    expect(ledger.snapshot().currentEvidence).toEqual([]);
    expect(ledger.snapshot().staleEvidence).toHaveLength(1);
    record(ledger, "after-edit");
    expect(ledger.runActivity().evidence.map((e) => e.status)).toEqual(["passed"]);
    expect(ledger.snapshot().staleEvidence).toHaveLength(1);
    expect(ledger.snapshot().currentEvidence).toHaveLength(1);
  });

  it("does not promote missing execution metadata to passed evidence", () => {
    const ledger = new SessionVerificationEvidenceLedger();
    ledger.beginRun();
    ledger.recordToolResult({ name: "bash", args: { command: "pnpm test" }, isError: false });
    expect(ledger.runActivity()).toEqual({ changed: false, checked: true, evidence: [] });
  });

  it("retires activity on reset", () => {
    const ledger = new SessionVerificationEvidenceLedger();
    record(ledger, "before-reset");
    ledger.clear();
    expect(ledger.runActivity()).toEqual({ changed: false, checked: false, evidence: [] });
    expect(ledger.snapshot()).toEqual({ currentEvidence: [], staleEvidence: [] });
  });
});
