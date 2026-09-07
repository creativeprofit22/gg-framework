import { describe, expect, it } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import {
  ROADMAP_VERIFICATION_CLASSIFIER_VERSION,
  SessionVerificationEvidenceLedger,
  classifyVerificationCommand,
  collectVerificationEvidence,
  createDurableVerificationEvidence,
  evaluateDurableVerificationEvidence,
  evaluateRoadmapVerificationEvidence,
  formatVerificationCommandDisplay,
  partitionVerificationMessagesForWorkspaceMutation,
  roadmapCriterionId,
  workspaceVerificationEvidenceMatches,
} from "./verification-evidence.js";

const TEST_ENVIRONMENT_DIGEST = "9".repeat(64);
const TEST_WORKSPACE = {
  version: 1 as const,
  repository: {
    projectKey: "C:/project",
    identityHash: "1".repeat(64),
    rootCommit: "2".repeat(40),
  },
  headCommit: "3".repeat(40),
  worktreeDigest: "4".repeat(64),
  clean: true,
};

function executionFields(
  index: number,
  workspace: {
    version: 1;
    repository: { projectKey: string; identityHash: string; rootCommit: string };
    headCommit: string;
    worktreeDigest: string;
    clean: boolean;
  },
) {
  return {
    executionId: `execution-${index}`,
    observedAt: "2026-08-30T10:00:00.000Z",
    cwd: "C:/project",
    safeToolEnvironmentDigest: TEST_ENVIRONMENT_DIGEST,
    workspace,
  };
}

describe("durable verification evidence", () => {
  const workspace = TEST_WORKSPACE;

  it("binds classifier-approved commands to exact criterion and workspace identities", () => {
    const evidence = createDurableVerificationEvidence({
      coverage: [
        {
          criterionIndex: 1,
          criterion: "Tests pass",
          evidence: "pnpm test",
          command: "pnpm test",
          ...executionFields(1, workspace),
        },
      ],
    });
    expect(
      evaluateDurableVerificationEvidence({
        doneWhen: ["Tests pass"],
        evidence,
        verificationBindings: evidence.map((record) => ({
          criterionId: record.criterionId,
          executionId: record.executionId,
        })),
        workspace,
        safeToolEnvironmentDigest: TEST_ENVIRONMENT_DIGEST,
      }),
    ).toMatchObject({
      ready: true,
      staleCriterionIds: [],
      missingCriterionIds: [],
    });
    expect(
      evaluateDurableVerificationEvidence({
        doneWhen: ["Tests pass"],
        evidence,
        verificationBindings: evidence.map((record) => ({
          criterionId: record.criterionId,
          executionId: record.executionId,
        })),
        workspace: { ...workspace, worktreeDigest: "5".repeat(64) },
        safeToolEnvironmentDigest: TEST_ENVIRONMENT_DIGEST,
      }),
    ).toMatchObject({ ready: false, staleCriterionIds: [evidence[0]!.criterionId] });
    expect(evidence[0]!.classifierVersion).toBe("roadmap-verification-v2");
  });

  it("treats prior-policy durable records as stale", () => {
    const evidence = createDurableVerificationEvidence({
      coverage: [
        {
          criterionIndex: 1,
          criterion: "Tests pass",
          evidence: "pnpm test",
          command: "pnpm test",
          ...executionFields(1, workspace),
        },
      ],
    });
    const priorPolicyEvidence = evidence.map((record) => ({
      ...record,
      classifierVersion: "roadmap-verification-v1",
    }));

    expect(
      evaluateDurableVerificationEvidence({
        doneWhen: ["Tests pass"],
        evidence: priorPolicyEvidence,
        verificationBindings: evidence.map((record) => ({
          criterionId: record.criterionId,
          executionId: record.executionId,
        })),
        workspace,
        safeToolEnvironmentDigest: TEST_ENVIRONMENT_DIGEST,
      }),
    ).toMatchObject({ ready: false, staleCriterionIds: [evidence[0]!.criterionId] });
  });

  it("hashes exact commands while keeping secret-like values out of durable displays", () => {
    const commands = [
      "pnpm test -- --token=synthetic-token-4f93a8",
      "pnpm test -- --password synthetic-password-8b27",
      'pnpm test -- --header "Authorization: Bearer synthetic-header-6d51"',
      "pnpm test -- API_KEY=synthetic-key-2c74",
      "pnpm test -- --token='unterminated-synthetic-token",
    ];
    const evidence = createDurableVerificationEvidence({
      coverage: commands.map((command, index) => ({
        criterionIndex: index + 1,
        criterion: `Criterion ${index + 1}`,
        evidence: command,
        command,
        ...executionFields(index + 1, workspace),
      })),
    });

    expect(evidence.map((item) => item.commandHash)).toEqual([
      "50c7de277d4a0807ed6cfff53ccc7ae26be29b9df51b350f5189cad82115490c",
      "258efab2c490fe69f30b1182c864e13d0da1bb70bc4a0a0304dbafb402a3a43a",
      "407bf90ef56389db2e42d541c7f424ee9334f29f5d2c19efb1f5c2bb9896c215",
      "7fc9fb739b3fd19d11e11125412870412b3e3b02ac2fd52be536302c61016bff",
      "9a155faebe516364242bab6c7d5e26e2bc78d4b0e11e3a929b740bdad5bd1865",
    ]);
    expect(evidence.map((item) => item.commandDisplay)).toEqual([
      "pnpm test -- --token=[REDACTED]",
      "pnpm test -- --password [REDACTED]",
      "pnpm test -- --header [REDACTED]",
      "pnpm test -- API_KEY=[REDACTED]",
      "Approved verification command",
    ]);
    expect(JSON.stringify(evidence)).not.toMatch(/synthetic-(?:token|password|header|key)/);
    expect(formatVerificationCommandDisplay("pnpm test -- TOKEN = synthetic-spaced-value")).toBe(
      "Approved verification command",
    );
    expect(formatVerificationCommandDisplay("pnpm test -- -k synthetic-short-value")).toBe(
      "pnpm test -- -k [REDACTED]",
    );

    const sameDisplayEvidence = createDurableVerificationEvidence({
      coverage: [
        {
          criterionIndex: 1,
          criterion: "First",
          evidence: "first",
          command: commands[0]!,
          ...executionFields(1, workspace),
        },
        {
          criterionIndex: 2,
          criterion: "Second",
          evidence: "second",
          command: "pnpm test -- --token=[REDACTED]",
          ...executionFields(2, workspace),
        },
      ],
    });
    expect(sameDisplayEvidence[0]!.commandDisplay).toBe(sameDisplayEvidence[1]!.commandDisplay);
    expect(sameDisplayEvidence[0]!.commandHash).not.toBe(sameDisplayEvidence[1]!.commandHash);
    expect(
      evaluateDurableVerificationEvidence({
        doneWhen: ["First", "Second"],
        evidence: sameDisplayEvidence,
        verificationBindings: sameDisplayEvidence.map((record) => ({
          criterionId: record.criterionId,
          executionId: record.executionId,
        })),
        workspace,
        safeToolEnvironmentDigest: TEST_ENVIRONMENT_DIGEST,
      }).ready,
    ).toBe(true);
  });
});

describe("classifyVerificationCommand", () => {
  it.each([
    "tsc --noEmit",
    "pnpm exec tsc --noEmit --pretty false",
    "pnpm --filter @kenkaiiii/gg-ai check",
    "pnpm -w typecheck",
    "vitest run src/foo.test.ts",
    "pnpm vitest run src/foo.test.ts",
    "pnpm --filter web vitest run",
    "node --test verification.test.mjs",
    "node --test --import tsx verification.test.ts",
    "node.exe --test verification.test.mjs",
    "python -m unittest",
    "cd packages/app && npm test",
    "git status --short && npm run test",
    "git status && npm test",
    "cd packages/app && git status --porcelain && npm test",
    "pnpm test -- --runInBand",
    "cargo fmt --check && cargo clippy",
    "cargo test --manifest-path gg-app/src-tauri/Cargo.toml nested_repositories_are_rejected -- --exact",
    "go test ./...",
    "go.exe test ./...",
    "./.tools/go/bin/go.exe test ./internal/architecture",
    "C:\\tools\\go\\bin\\GO.ExE vet ./...",
    "go.exe test ./... && go vet ./...",
    "ruff format --check .",
  ])("accepts bounded check: %s", (command) => {
    expect(classifyVerificationCommand(command)).toMatchObject({
      accepted: true,
      candidate: true,
    });
  });

  it.each([
    ["go.exe test ./...", "go test ./..."],
    ["./.tools/go/bin/go.exe vet ./...", "go vet ./..."],
    ["C:\\tools\\go\\bin\\GO.ExE test ./...", "go test ./..."],
  ])("classifies Windows Go command %s exactly like %s", (windowsCommand, unixCommand) => {
    expect(classifyVerificationCommand(windowsCommand)).toEqual(
      classifyVerificationCommand(unixCommand),
    );
  });

  it("keeps unsupported Go subcommands unclassified", () => {
    expect(classifyVerificationCommand("go.exe list ./...")).toEqual(
      classifyVerificationCommand("go list ./..."),
    );
  });

  it("rejects env-wrapped Windows Go commands", () => {
    expect(classifyVerificationCommand("env CI=1 go.exe test ./...")).toMatchObject({
      accepted: false,
      candidate: true,
    });
  });

  it.each([
    ["go.exe test ./... | cat", "pipe stage can transform check results"],
    ["go.exe test ./... || echo ignored", "shell control operator can hide a failed check"],
    ["go.exe test ./...; echo ignored", "shell control operator can hide a failed check"],
  ])("rejects Windows Go checks with unsafe control operators: %s", (command, reason) => {
    expect(classifyVerificationCommand(command)).toMatchObject({
      accepted: false,
      candidate: true,
      reason,
    });
  });

  it.each([
    ["node script.js --test", "must lead"],
    ["node.exe script.js --test", "must lead"],
    ["node -- script.js --test", "must lead"],
    ["node --require --test script.js", "must lead"],
    ["pnpm exec node script.js --test", "must lead"],
    ["tsc --init", "mutating"],
    ["tsc --build", "mutating"],
    ["tsc --noEmit --incremental", "mutating"],
    ["tsc --noEmit --tsBuildInfoFile cache.tsbuildinfo", "mutating"],
    ["prettier --write src", "mutating"],
    ["pnpm build", "artifact-producing"],
    ["tsc --watch --noEmit", "long-running"],
    ["vitest --watch", "long-running"],
    ["pnpm vitest --watch", "long-running"],
    ["pnpm eslint --fix src", "mutating"],
    ["pnpm vitest run --listTests", "does not execute"],
    ["pnpm dev", "long-running"],
    ["tsc", "--noEmit"],
    ["tsc --noEmit --noCheck", "does not prove"],
    ["tsc --noEmit --listFilesOnly", "does not prove"],
    ["tsc --showConfig", "does not prove"],
    ["tsc --help", "does not prove"],
    ["tsc --version", "does not prove"],
    ["tsc --noEmit --generateTrace trace", "does not prove"],
    ["tsc --noEmit --generateCpuProfile cpu.cpuprofile", "does not prove"],
    ["tsc --noEmit > result.txt", "unsafe shell"],
    ["tsc --noEmit | cat", "pipe stage"],
    ["tsc --noEmit || echo ignored", "control operator"],
    ["tsc --noEmit; echo ignored", "control operator"],
    ["tsc --noEmit && npm run clean", "mutating"],
  ])("rejects non-evidence command: %s", (command, reason) => {
    expect(classifyVerificationCommand(command)).toMatchObject({
      accepted: false,
      candidate: true,
      reason: expect.stringContaining(reason),
    });
  });

  it.each([
    "git status --short && git status",
    "git status --short && npm test || true",
    "git status --short; npm test",
    "git status --short | npm test",
    "git status --short > status.txt && npm test",
    "git -c core.fsmonitor=helper status --short && npm test",
    "git reset --hard && npm test",
    "git status --help && npm test",
    "git status --short && echo done",
  ])("does not let a status prelude bypass verification: %s", (command) => {
    expect(classifyVerificationCommand(command).accepted).toBe(false);
  });

  it("rejects unknown commands without mislabeling ordinary shell work as verification", () => {
    expect(classifyVerificationCommand("git status --short")).toMatchObject({
      accepted: false,
      candidate: false,
    });
  });

  it("accepts checks piped through pure output limiters (pipefail keeps the status)", () => {
    expect(classifyVerificationCommand("pnpm vitest run src/a.test.ts | tail -20")).toMatchObject({
      accepted: true,
    });
    expect(
      classifyVerificationCommand("cd packages/ggcoder && pnpm test 2>&1 | tail -5"),
    ).toMatchObject({ accepted: true });
    expect(classifyVerificationCommand("npm test | head -3")).toMatchObject({
      accepted: true,
    });
  });

  it("rejects pipes whose stages can transform check results", () => {
    // grep/tee/wc can filter, redirect, or replace what the check proved.
    expect(classifyVerificationCommand("pnpm test | grep -q 'all passed'").accepted).toBe(false);
    expect(classifyVerificationCommand("pnpm test | tee results.log").accepted).toBe(false);
    expect(classifyVerificationCommand("pnpm test | wc -l").accepted).toBe(false);
    // A limiter joined by && (not a pipe) runs AFTER the check and its own 0
    // would mask the check's status — the pipe allowance must not leak to it.
    expect(classifyVerificationCommand("pnpm test && tail -5").accepted).toBe(false);
    // Output redirection into the pipe stage is not a pure limiter either.
    expect(classifyVerificationCommand("pnpm test | tail -f log.txt").accepted).toBe(false);
  });

  it("marks file-rewriting rejections mayMutate, plain unrecognized checks not", () => {
    // The gate bumps its mutation revision when a mayMutate check STARTS (the
    // command can rewrite files). A green `make test` — a real check the
    // classifier just cannot vouch for — must not poison the revision and
    // re-arm the gate into every later question turn.
    expect(classifyVerificationCommand("pnpm lint:fix").mayMutate).toBe(true);
    expect(classifyVerificationCommand("pnpm build").mayMutate).toBe(true);
    expect(classifyVerificationCommand("pnpm eslint --fix src/foo.ts").mayMutate).toBe(true);
    expect(classifyVerificationCommand("tsc -p .").mayMutate).toBe(true); // emits JS files
    expect(classifyVerificationCommand("cargo build").mayMutate).toBe(true);
    expect(classifyVerificationCommand("pnpm build 2>&1 | tail -5").mayMutate).toBe(true);
    // Non-mutating shapes: unrecognized runners and pure checks.
    expect(classifyVerificationCommand("make test").mayMutate).toBe(false);
    expect(classifyVerificationCommand("deno test").mayMutate).toBe(false);
    expect(classifyVerificationCommand("pnpm test").mayMutate).toBe(false);
    expect(classifyVerificationCommand("pnpm test | grep -q ok").mayMutate).toBe(false);
  });
});

function bashExchange(
  id: string,
  command: string,
  result: string,
  args: Record<string, unknown> = {},
): Message[] {
  return [
    {
      role: "assistant",
      content: [{ type: "tool_call", id, name: "bash", args: { command, ...args } }],
    },
    {
      role: "tool",
      content: [{ type: "tool_result", toolCallId: id, content: result }],
    },
  ];
}

function toolExchange(
  id: string,
  name: string,
  args: Record<string, unknown>,
  content = "completed",
): Message[] {
  return [
    { role: "assistant", content: [{ type: "tool_call", id, name, args }] },
    { role: "tool", content: [{ type: "tool_result", toolCallId: id, content }] },
  ];
}

function roadmapExchange(id: string, revision: number): Message[] {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool_call",
          id,
          name: "roadmap_status",
          args: { expected_revision: revision - 1 },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool_result",
          toolCallId: id,
          content: JSON.stringify({ result: "committed", revision }),
        },
      ],
    },
  ];
}

describe("collectVerificationEvidence", () => {
  it("records only successful bounded checks as passed evidence", () => {
    const messages: Message[] = [
      ...bashExchange("pass", "tsc --noEmit", "Exit code: 0\n"),
      ...bashExchange("fail", "vitest run src/foo.test.ts", "Exit code: 1\n1 test failed"),
      ...bashExchange("watch", "tsc --watch --noEmit", "Exit code: 0\nWatching"),
      ...bashExchange("ordinary", "git status --short", "Exit code: 0\n"),
      ...bashExchange("background", "vitest run", "Background process started.", {
        run_in_background: true,
      }),
    ];

    expect(collectVerificationEvidence(messages)).toEqual([
      {
        command: "tsc --noEmit",
        status: "passed",
        reason: "bounded TypeScript no-emit check",
      },
      {
        command: "vitest run src/foo.test.ts",
        status: "failed",
        reason: "bounded check did not exit successfully",
      },
      {
        command: "tsc --watch --noEmit",
        status: "rejected",
        reason: "long-running watch/debug mode",
      },
      {
        command: "vitest run",
        status: "rejected",
        reason: "background or persistent commands are not bounded evidence",
      },
    ]);
  });
});

describe("evaluateRoadmapVerificationEvidence", () => {
  const evaluate = (
    messages: Message[],
    evidence: string[],
    doneWhen = ["criterion one"],
    expectedRevision: number | undefined = 15,
  ) => {
    const partition =
      expectedRevision === undefined
        ? { currentMessages: messages, staleMessages: [] }
        : partitionVerificationMessagesForWorkspaceMutation(messages);
    const toLedger = (items: Message[], prefix: string) =>
      collectVerificationEvidence(items).map((item, index) => ({
        ...item,
        ...executionFields(index + 1, TEST_WORKSPACE),
        executionId: `${prefix}-${index + 1}`,
        classifierVersion: ROADMAP_VERIFICATION_CLASSIFIER_VERSION,
      }));
    const currentLedgerEvidence = toLedger(partition.currentMessages, "current");
    const staleLedgerEvidence = toLedger(partition.staleMessages, "stale");
    const all = [...currentLedgerEvidence, ...staleLedgerEvidence];
    const verificationBindings = doneWhen.map((criterion, index) => ({
      criterionId: roadmapCriterionId(index + 1, criterion),
      executionId:
        all.find((item) => evidence[index]?.toLowerCase().includes(item.command.toLowerCase()))
          ?.executionId ?? `missing-${index + 1}`,
    }));
    return evaluateRoadmapVerificationEvidence({
      doneWhen,
      evidence,
      verificationBindings,
      expectedRevision,
      currentLedgerEvidence,
      staleLedgerEvidence,
    });
  };

  it("binds seven criteria to exact execution identities without reading citation text", () => {
    const doneWhen = Array.from({ length: 7 }, (_, index) => `criterion ${index + 1}`);
    const currentLedgerEvidence = doneWhen.map((_, index) => ({
      ...executionFields(index + 1, TEST_WORKSPACE),
      command:
        "cargo test --manifest-path gg-app/src-tauri/Cargo.toml nested_repositories_are_rejected -- --exact",
      status: "passed" as const,
      reason: "bounded Cargo check",
      classifierVersion: ROADMAP_VERIFICATION_CLASSIFIER_VERSION,
    }));
    const verificationBindings = doneWhen.map((criterion, index) => ({
      criterionId: roadmapCriterionId(index + 1, criterion),
      executionId: `execution-${index + 1}`,
    }));

    expect(
      evaluateRoadmapVerificationEvidence({
        doneWhen,
        evidence: ["Seven focused checks passed; wording intentionally omits commands."],
        verificationBindings,
        expectedRevision: 231,
        currentLedgerEvidence,
      }),
    ).toMatchObject({
      ready: true,
      criterionCoverage: verificationBindings.map((binding, index) => ({
        criterionIndex: index + 1,
        criterion: doneWhen[index],
        executionId: binding.executionId,
      })),
    });
  });

  it("treats prior-policy ledger records as stale", () => {
    const criterion = "Tests pass";
    const execution = {
      ...executionFields(1, TEST_WORKSPACE),
      command: "pnpm check",
      status: "passed" as const,
      reason: "bounded pnpm verification script",
      classifierVersion: "roadmap-verification-v1",
    };

    expect(
      evaluateRoadmapVerificationEvidence({
        doneWhen: [criterion],
        evidence: [execution.command],
        verificationBindings: [
          { criterionId: roadmapCriterionId(1, criterion), executionId: execution.executionId },
        ],
        expectedRevision: 15,
        currentLedgerEvidence: [execution],
      }),
    ).toEqual({
      ready: false,
      unmetEvidenceCodes: ["stale-evidence", "missing-approved-evidence"],
    });
  });

  it("rejects reused executions and unknown criterion bindings", () => {
    const doneWhen = ["first", "second"];
    const execution = {
      ...executionFields(1, TEST_WORKSPACE),
      command: "pnpm check",
      status: "passed" as const,
      reason: "bounded pnpm verification script",
      classifierVersion: ROADMAP_VERIFICATION_CLASSIFIER_VERSION,
    };
    const firstId = roadmapCriterionId(1, doneWhen[0]!);

    expect(
      evaluateRoadmapVerificationEvidence({
        doneWhen,
        evidence: [],
        verificationBindings: [
          { criterionId: firstId, executionId: execution.executionId },
          { criterionId: roadmapCriterionId(2, doneWhen[1]!), executionId: execution.executionId },
        ],
        expectedRevision: 15,
        currentLedgerEvidence: [execution],
      }),
    ).toMatchObject({
      ready: false,
      unmetEvidenceCodes: expect.arrayContaining(["duplicate-evidence"]),
    });

    expect(
      evaluateRoadmapVerificationEvidence({
        doneWhen,
        evidence: [],
        verificationBindings: [{ criterionId: "f".repeat(64), executionId: execution.executionId }],
        expectedRevision: 15,
        currentLedgerEvidence: [execution],
      }),
    ).toMatchObject({ ready: false });
  });

  it("ignores unbound extra executions and permits selecting either same-command rerun", () => {
    const criterion = "focused tests pass";
    const criterionId = roadmapCriterionId(1, criterion);
    const currentLedgerEvidence = [
      {
        ...executionFields(1, TEST_WORKSPACE),
        executionId: "old-pass",
        command: "pnpm check",
        status: "passed" as const,
        reason: "ok",
        classifierVersion: ROADMAP_VERIFICATION_CLASSIFIER_VERSION,
      },
      {
        ...executionFields(2, TEST_WORKSPACE),
        executionId: "new-pass",
        command: "pnpm check",
        status: "passed" as const,
        reason: "ok",
        classifierVersion: ROADMAP_VERIFICATION_CLASSIFIER_VERSION,
      },
      {
        ...executionFields(3, TEST_WORKSPACE),
        executionId: "unbound-failure",
        command: "vitest run unrelated.test.ts",
        status: "failed" as const,
        reason: "failed",
        classifierVersion: ROADMAP_VERIFICATION_CLASSIFIER_VERSION,
      },
    ];
    for (const executionId of ["old-pass", "new-pass"]) {
      expect(
        evaluateRoadmapVerificationEvidence({
          doneWhen: [criterion],
          evidence: [],
          verificationBindings: [{ criterionId, executionId }],
          expectedRevision: 15,
          currentLedgerEvidence,
        }),
      ).toMatchObject({ ready: true });
    }
  });

  it("rejects unsafe shell wrappers even when the outer command exits zero", () => {
    const command = "vitest run smoke.test.ts || echo PASS";
    const evaluation = evaluate(bashExchange("unsafe", command, "Exit code: 0\nPASS"), [command]);
    expect(evaluation).toEqual({
      ready: false,
      unmetEvidenceCodes: ["rejected-evidence", "missing-approved-evidence"],
    });
    expect("criterionCoverage" in evaluation).toBe(false);
  });

  it("does not let an unrelated approved command mask the cited command's failure", () => {
    const required = "vitest run required.test.ts";
    const unrelated = "tsc --noEmit";
    expect(
      evaluate(
        [
          ...bashExchange("required", required, "Exit code: 1\n1 test failed"),
          ...bashExchange("unrelated", unrelated, "Exit code: 0"),
        ],
        [`${required}; unrelated approval: ${unrelated}`],
      ),
    ).toEqual({
      ready: false,
      unmetEvidenceCodes: ["failed-evidence", "missing-approved-evidence"],
    });
  });

  it.each([undefined, "unknown"])("reports unavailable evidence for terminal reason %s", (reason) => {
    const ledger = new SessionVerificationEvidenceLedger();
    const command = "pnpm test";
    const criterion = "Tests pass";
    const executionId = "missing-terminal-metadata";
    ledger.recordToolResult({
      name: "bash",
      args: { command },
      isError: false,
      workspace: TEST_WORKSPACE,
      details: {
        bashDiagnostics: { executionId, command, cwd: "C:/project", startedAt: 1000, reason },
      },
    });
    const currentLedgerEvidence = ledger.snapshot().currentEvidence;
    expect(currentLedgerEvidence).toEqual([
      expect.objectContaining({ executionId, status: "unavailable" }),
    ]);
    expect(evaluateRoadmapVerificationEvidence({
      doneWhen: [criterion],
      evidence: [command],
      verificationBindings: [{ criterionId: roadmapCriterionId(1, criterion), executionId }],
      expectedRevision: 15,
      currentLedgerEvidence,
    })).toEqual({
      ready: false,
      unmetEvidenceCodes: ["unavailable-evidence", "missing-approved-evidence"],
    });
  });

  it("keeps an explicitly selected passing execution when a later rerun fails", () => {
    const command = "vitest run current-phase.test.ts";
    expect(
      evaluate(
        [
          ...bashExchange("passing", command, "Exit code: 0"),
          ...bashExchange("failing", command, "Exit code: 1\n1 test failed"),
        ],
        [command],
      ),
    ).toMatchObject({ ready: true });
  });

  it("rejects an unclassified row-700-style generic smoke command", () => {
    const command = "node scripts/roadmap-smoke.mjs";
    expect(
      evaluate(bashExchange("smoke", command, "Exit code: 0\nPASS criteria 1-5"), [command]),
    ).toMatchObject({
      ready: false,
      unmetEvidenceCodes: ["unmatched-evidence", "missing-approved-evidence"],
    });
  });

  it("retains approved evidence across Roadmap metadata and read-only tools", () => {
    const command = "vitest run current-phase.test.ts";
    const messages = [
      ...bashExchange("verified", command, "Exit code: 0"),
      ...roadmapExchange("status", 15),
      ...toolExchange("read", "read", { file_path: "src/example.ts" }),
    ];

    expect(evaluate(messages, [command])).toMatchObject({
      ready: true,
      unmetEvidenceCodes: [],
      criterionCoverage: [
        { criterionIndex: 1, criterion: "criterion one", evidence: command, command },
      ],
    });
  });

  it.each([
    ["edit", toolExchange("edit", "edit", { file_path: "src/example.ts", edits: [] })],
    ["delegated edit", toolExchange("delegate", "subagent", { task: "Edit source" })],
    [
      "unclassified shell operation",
      bashExchange("shell", "node scripts/rewrite-source.mjs", "Exit code: 0"),
    ],
  ])("invalidates approved evidence after a %s", (_label, mutation) => {
    const command = "vitest run current-phase.test.ts";
    expect(
      evaluate([...bashExchange("old", command, "Exit code: 0"), ...mutation], [command]),
    ).toEqual({
      ready: false,
      unmetEvidenceCodes: ["stale-evidence", "missing-approved-evidence"],
    });
  });

  it("keeps the latest mutation boundary when tool results complete out of order", () => {
    const command = "vitest run current-phase.test.ts";
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "older-edit",
            name: "edit",
            args: { file_path: "src/older.ts", edits: [] },
          },
        ],
      },
      ...bashExchange("verified-between-edits", command, "Exit code: 0"),
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "latest-edit",
            name: "edit",
            args: { file_path: "src/latest.ts", edits: [] },
          },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "latest-edit", content: "completed" }],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "older-edit", content: "completed" }],
      },
    ];

    expect(evaluate(messages, [command])).toEqual({
      ready: false,
      unmetEvidenceCodes: ["stale-evidence", "missing-approved-evidence"],
    });
  });

  it("rejects duplicate command evidence and criterion count mismatches", () => {
    const command = "vitest run duplicate.test.ts";
    expect(
      evaluate(
        bashExchange("duplicate", command, "Exit code: 0"),
        [command, command],
        ["criterion one", "criterion two"],
      ),
    ).toMatchObject({
      ready: false,
      unmetEvidenceCodes: ["duplicate-evidence"],
    });
    expect(
      evaluate(bashExchange("mismatch", command, "Exit code: 0"), [command], ["one", "two"]),
    ).toMatchObject({
      ready: false,
      unmetEvidenceCodes: expect.arrayContaining([
        "unmatched-evidence",
        "missing-approved-evidence",
      ]),
    });
  });

  it("accepts one distinct current approved command per criterion", () => {
    const first = "vitest run first.test.ts";
    const second = "tsc --noEmit";
    expect(
      evaluate(
        [
          ...bashExchange("first", first, "Exit code: 0"),
          ...bashExchange("second", second, "Exit code: 0"),
        ],
        [`criterion one — ${first}`, `criterion two — ${second}`],
        ["criterion one", "criterion two"],
      ),
    ).toMatchObject({
      ready: true,
      unmetEvidenceCodes: [],
      criterionCoverage: [
        {
          criterionIndex: 1,
          criterion: "criterion one",
          evidence: `criterion one — ${first}`,
          command: first,
        },
        {
          criterionIndex: 2,
          criterion: "criterion two",
          evidence: `criterion two — ${second}`,
          command: second,
        },
      ],
    });
  });
});

describe("SessionVerificationEvidenceLedger", () => {
  function record(
    ledger: SessionVerificationEvidenceLedger,
    executionId: string,
    command: string,
    exitCode = 0,
  ) {
    ledger.recordToolResult({
      name: "bash",
      args: { command },
      isError: exitCode !== 0,
      details: {
        bashDiagnostics: {
          executionId,
          command,
          cwd: "C:/project",
          startedAt: Date.parse("2026-08-30T10:00:00.000Z"),
          reason: "completed",
          exitCode,
        },
      },
    });
  }

  it.each([
    ["completed", 0, "passed", "bounded TypeScript no-emit check"],
    ["nonZeroExit", 1, "failed", "failed (exit 1)"],
    ["spawnError", null, "failed", "launch failed"],
    ["timedOut", null, "failed", "timed out"],
    ["aborted", null, "failed", "cancelled"],
    [undefined, null, "unavailable", "execution outcome unavailable"],
  ])("retains terminal diagnostics for %s", (reason, exitCode, status, explanation) => {
    const ledger = new SessionVerificationEvidenceLedger();
    ledger.recordToolResult({ name: "bash", args: { command: "tsc --noEmit" }, isError: exitCode !== 0,
      details: { bashDiagnostics: {
        executionId: "terminal", command: "tsc --noEmit", cwd: "C:/project", startedAt: 1000,
        reason, exitCode, signal: "SIGTERM", elapsedMs: 123, timeoutMs: 120000,
        logPath: "C:/logs/terminal.log", tail: "fixture debugging target timed out: fetch failed",
      } } });
    const evidence = ledger.snapshot().currentEvidence[0];
    expect(evidence).toMatchObject({ status, reason: explanation,
      exitCode, signal: "SIGTERM", elapsedMs: 123, timeoutMs: 120000, logPath: "C:/logs/terminal.log" });
    expect(evidence).not.toHaveProperty("tail");
  });

  it("accepts a successful path-qualified Windows Go test as ready evidence", () => {
    const command =
      "./.tools/go/bin/go.exe test ./internal/architecture -run '^TestProjectImportDAG$' -count=1";
    const criterion = "project imports preserve the architecture DAG";
    const ledger = new SessionVerificationEvidenceLedger();
    ledger.recordToolResult({
      name: "bash",
      args: { command },
      isError: false,
      details: {
        bashDiagnostics: {
          executionId: "windows-go-test",
          command,
          cwd: "C:/project",
          startedAt: Date.parse("2026-08-30T10:00:00.000Z"),
          reason: "completed",
          exitCode: 0,
        },
      },
      workspace: TEST_WORKSPACE,
    });

    const currentLedgerEvidence = ledger.snapshot().currentEvidence;
    expect(currentLedgerEvidence).toEqual([
      expect.objectContaining({
        command,
        executionId: "windows-go-test",
        status: "passed",
        reason: "bounded Go check",
      }),
    ]);
    expect(
      evaluateRoadmapVerificationEvidence({
        doneWhen: [criterion],
        evidence: [command],
        verificationBindings: [
          { criterionId: roadmapCriterionId(1, criterion), executionId: "windows-go-test" },
        ],
        expectedRevision: 15,
        currentLedgerEvidence,
      }),
    ).toMatchObject({ ready: true, unmetEvidenceCodes: [] });
  });

  it("keeps execution identities immutable across replay and conflicting diagnostics", () => {
    const ledger = new SessionVerificationEvidenceLedger();
    record(ledger, "immutable", "pnpm check");
    const first = ledger.snapshot();
    record(ledger, "immutable", "pnpm check");
    expect(ledger.snapshot()).toEqual(first);

    record(ledger, "immutable", "pnpm check", 1);
    expect(ledger.snapshot().currentEvidence).toEqual([
      expect.objectContaining({
        executionId: "immutable",
        command: "pnpm check",
        status: "passed",
      }),
    ]);
  });

  it("bounds retained executions while preserving the newest evidence", () => {
    const ledger = new SessionVerificationEvidenceLedger();
    for (let index = 0; index <= 100; index += 1) {
      record(ledger, `execution-${index}`, `vitest run src/case-${index}.test.ts`);
    }

    const evidence = ledger.snapshot().currentEvidence;
    expect(evidence).toHaveLength(100);
    expect(evidence.at(-1)?.command).toBe("vitest run src/case-100.test.ts");
  });

  it("does not retain oversized execution diagnostics", () => {
    const ledger = new SessionVerificationEvidenceLedger();
    record(ledger, "x".repeat(1_000), `vitest run ${"x".repeat(10_000)}`);

    expect(ledger.snapshot()).toEqual({ currentEvidence: [], staleEvidence: [] });
  });

  it("does not promote a check started before an edit with a completion-time snapshot", () => {
    const ledger = new SessionVerificationEvidenceLedger();
    const evidenceRevision = ledger.revision;
    ledger.recordToolResult({ name: "edit", args: { file_path: "src/example.ts" }, isError: false });
    ledger.recordToolResult({ name: "bash", args: { command: "pnpm check" }, isError: false,
      evidenceRevision, workspace: TEST_WORKSPACE,
      details: { bashDiagnostics: { executionId: "in-flight", command: "pnpm check",
        cwd: "C:/project", startedAt: 1000, reason: "completed", exitCode: 0 } } });
    expect(ledger.snapshot()).toMatchObject({ currentEvidence: [], staleEvidence: [
      { executionId: "in-flight", status: "passed", workspace: TEST_WORKSPACE },
    ] });
  });

  it("keeps equal commands isolated by execution, cwd, and reset boundary", () => {
    const ledger = new SessionVerificationEvidenceLedger();
    for (const [executionId, cwd, exitCode] of [["one", "C:/one", 1], ["two", "C:/two", 0]] as const) {
      ledger.recordToolResult({ name: "bash", args: { command: "pnpm check" }, isError: exitCode !== 0,
        details: { bashDiagnostics: { executionId, cwd, exitCode, command: "pnpm check",
          startedAt: 1000, reason: exitCode ? "nonZeroExit" : "completed" } } });
    }
    expect(ledger.snapshot().currentEvidence).toMatchObject([
      { executionId: "one", cwd: "C:/one", status: "failed" },
      { executionId: "two", cwd: "C:/two", status: "passed" },
    ]);
    ledger.clear();
    expect(ledger.snapshot()).toEqual({ currentEvidence: [], staleEvidence: [] });
  });

  it.each(["gg-app/src/local-release-notes.json", "gg-app/src/local-changelog.ts", "tsconfig.json"])(
    "conservatively stales backend evidence after editing %s", (file_path) => {
      const ledger = new SessionVerificationEvidenceLedger();
      record(ledger, "backend", "pnpm --filter @kenkaiiii/ggcoder exec tsc --noEmit");
      ledger.recordToolResult({ name: "edit", args: { file_path }, isError: false });
      expect(ledger.snapshot().currentEvidence).toEqual([]);
      expect(ledger.snapshot().staleEvidence[0]).toMatchObject({ executionId: "backend", status: "passed" });
    },
  );

  it("moves accepted evidence to stale after a workspace mutation", () => {
    const ledger = new SessionVerificationEvidenceLedger();
    record(ledger, "accepted", "pnpm check");
    ledger.recordToolResult({
      name: "edit",
      args: { file_path: "src/example.ts" },
      isError: false,
    });

    expect(ledger.snapshot()).toMatchObject({
      currentEvidence: [],
      staleEvidence: [expect.objectContaining({ command: "pnpm check", status: "passed" })],
    });
  });

  it.each([
    "roadmap_status",
    "roadmap_phase_draft",
    "roadmap_inspect",
    "roadmap_bind",
    "roadmap_checkpoint",
  ])("retains evidence across %s metadata operations", (name) => {
    const ledger = new SessionVerificationEvidenceLedger();
    record(ledger, "accepted", "pnpm check");
    ledger.recordToolResult({ name, args: {}, isError: false });
    expect(ledger.snapshot()).toMatchObject({
      currentEvidence: [expect.objectContaining({ executionId: "accepted" })],
      staleEvidence: [],
    });
  });
});

describe("workspaceVerificationEvidenceMatches", () => {
  const workspace = {
    version: 1 as const,
    repository: {
      projectKey: "C:/project",
      identityHash: "1".repeat(64),
      rootCommit: "2".repeat(40),
    },
    headCommit: "3".repeat(40),
    worktreeDigest: "4".repeat(64),
    clean: true,
  };

  it("ignores Notes metadata revisions but stales executable inputs and safe environment", () => {
    expect(
      workspaceVerificationEvidenceMatches(
        { workspace, safeToolEnvironmentDigest: "5".repeat(64) },
        { workspace: structuredClone(workspace), safeToolEnvironmentDigest: "5".repeat(64) },
      ),
    ).toBe(true);
    expect(
      workspaceVerificationEvidenceMatches(
        { workspace, safeToolEnvironmentDigest: "5".repeat(64) },
        {
          workspace: { ...workspace, worktreeDigest: "6".repeat(64), clean: false },
          safeToolEnvironmentDigest: "5".repeat(64),
        },
      ),
    ).toBe(false);
    expect(
      workspaceVerificationEvidenceMatches(
        { workspace, safeToolEnvironmentDigest: "5".repeat(64) },
        { workspace, safeToolEnvironmentDigest: "6".repeat(64) },
      ),
    ).toBe(false);
  });
});
