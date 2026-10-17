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

  // Regressions: each of these left checked work "Unverified", so Autopilot
  // re-demanded checks on later read-only questions.
  function runCommand(
    ledger: SessionVerificationEvidenceLedger,
    id: string,
    command: string,
    { exitCode = 0, sourceUnchanged }: { exitCode?: number; sourceUnchanged?: boolean } = {},
  ) {
    ledger.recordToolResult({
      name: "bash",
      args: { command },
      evidenceRevision: ledger.revision,
      evidenceRun: ledger.runId,
      isError: exitCode !== 0,
      details: {
        bashDiagnostics: {
          executionId: id,
          command,
          cwd: process.cwd(),
          startedAt: Date.now(),
          reason: exitCode === 0 ? "completed" : "nonZeroExit",
          exitCode,
          ...(sourceUnchanged === undefined ? {} : { sourceUnchanged }),
        },
      },
    });
  }

  it("keeps the covering check after more than 100 later commands", () => {
    const ledger = new SessionVerificationEvidenceLedger();
    editFile(ledger, "src/app.ts");
    runCommand(ledger, "check", "pnpm check");
    for (let index = 0; index <= 100; index += 1) {
      runCommand(ledger, `log-${index}`, "git log -1");
    }
    expect(ledger.verificationProblem()).toBeNull();
  });

  it("re-owes checks after a build only when it changed workspace inputs", () => {
    const build = "pnpm --filter gg-app build";
    const ledger = new SessionVerificationEvidenceLedger({ posixShell: true });
    editFile(ledger, "src/app.ts");
    runCommand(ledger, "check", "pnpm check");
    runCommand(ledger, "build-same", build, { sourceUnchanged: true });
    expect(ledger.verificationProblem()).toBeNull();
    runCommand(ledger, "build-changed", build, { sourceUnchanged: false });
    expect(ledger.verificationProblem()).toMatch(/^Unverified: no successful check/);
    runCommand(ledger, "recheck", "pnpm check");
    runCommand(ledger, "build-uncompared", build);
    expect(ledger.verificationProblem()).toMatch(/^Unverified: no successful check/);
    runCommand(ledger, "build-failed", build, { exitCode: 1, sourceUnchanged: true });
    expect(ledger.verificationProblem()).toMatch(/^Unverified: a check failed/);
  });

  it("counts a check piped through grep only with pipefail and unchanged inputs", () => {
    const piped = "pnpm test 2>&1 | grep -E 'pass|fail'";
    const verdict = (
      options: { posixShell: boolean },
      run: { exitCode?: number; sourceUnchanged?: boolean },
    ) => {
      const ledger = new SessionVerificationEvidenceLedger(options);
      editFile(ledger, "src/app.ts");
      runCommand(ledger, "piped", piped, run);
      return ledger.verificationProblem();
    };
    expect(verdict({ posixShell: true }, { sourceUnchanged: true })).toBeNull();
    expect(verdict({ posixShell: true }, {})).toMatch(/^Unverified: no successful check/);
    expect(verdict({ posixShell: true }, { sourceUnchanged: false })).toMatch(
      /^Unverified: no successful check/,
    );
    // cmd.exe has no pipefail, so grep's exit could hide a failed check.
    expect(verdict({ posixShell: false }, { sourceUnchanged: true })).toMatch(
      /^Unverified: no successful check/,
    );
    // grep matching nothing also exits 1: not proof that the check failed.
    expect(verdict({ posixShell: true }, { exitCode: 1, sourceUnchanged: true })).toMatch(
      /^Unverified: no successful check/,
    );
  });

  it("credits a handed-off check that finishes after ordinary commands", () => {
    const ledger = new SessionVerificationEvidenceLedger();
    editFile(ledger, "src/app.ts");
    ledger.recordToolResult({
      name: "bash",
      args: { command: "pnpm test" },
      evidenceRevision: ledger.revision,
      evidenceRun: ledger.runId,
      isError: false,
      details: {
        bashDiagnostics: {
          executionId: "handed-off",
          command: "pnpm test",
          cwd: process.cwd(),
          startedAt: Date.now(),
          reason: "backgrounded",
          exitCode: null,
          backgroundTaskId: "task-1",
        },
      },
    });
    runCommand(ledger, "log", "git log -1");
    expect(ledger.verificationProblem()).toMatch(/^Unverified: no successful check/);
    ledger.recordToolResult({
      name: "task_output",
      args: { id: "task-1" },
      isError: false,
      details: {
        taskOutput: { id: "task-1", isRunning: false, exitCode: 0, stopReason: null },
      },
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
