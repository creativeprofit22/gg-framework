import { describe, expect, it } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import {
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
        classifierVersion: "roadmap-verification-v2",
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
    "pnpm test -- --runInBand",
    "cargo fmt --check && cargo clippy",
    "cargo test --manifest-path gg-app/src-tauri/Cargo.toml nested_repositories_are_rejected -- --exact",
    "ruff format --check .",
  ])("accepts bounded check: %s", (command) => {
    expect(classifyVerificationCommand(command)).toMatchObject({
      accepted: true,
      candidate: true,
    });
  });

  it.each([
    ["tsc --init", "mutating"],
    ["tsc --build", "mutating"],
    ["tsc --noEmit --incremental", "mutating"],
    ["tsc --noEmit --tsBuildInfoFile cache.tsbuildinfo", "mutating"],
    ["prettier --write src", "mutating"],
    ["pnpm build", "artifact-producing"],
    ["tsc --watch --noEmit", "long-running"],
    ["vitest --watch", "long-running"],
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
    ["tsc --noEmit | cat", "control operator"],
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

  it("rejects unknown commands without mislabeling ordinary shell work as verification", () => {
    expect(classifyVerificationCommand("git status --short")).toMatchObject({
      accepted: false,
      candidate: false,
    });
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
        classifierVersion: "roadmap-verification-v1",
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
      currentMessages: [],
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
      classifierVersion: "roadmap-verification-v1",
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
        currentMessages: [],
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

  it("rejects reused executions and unknown criterion bindings", () => {
    const doneWhen = ["first", "second"];
    const execution = {
      ...executionFields(1, TEST_WORKSPACE),
      command: "pnpm check",
      status: "passed" as const,
      reason: "bounded pnpm verification script",
      classifierVersion: "roadmap-verification-v1",
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
        currentMessages: [],
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
        currentMessages: [],
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
        classifierVersion: "roadmap-verification-v1",
      },
      {
        ...executionFields(2, TEST_WORKSPACE),
        executionId: "new-pass",
        command: "pnpm check",
        status: "passed" as const,
        reason: "ok",
        classifierVersion: "roadmap-verification-v1",
      },
      {
        ...executionFields(3, TEST_WORKSPACE),
        executionId: "unbound-failure",
        command: "vitest run unrelated.test.ts",
        status: "failed" as const,
        reason: "failed",
        classifierVersion: "roadmap-verification-v1",
      },
    ];
    for (const executionId of ["old-pass", "new-pass"]) {
      expect(
        evaluateRoadmapVerificationEvidence({
          doneWhen: [criterion],
          evidence: [],
          verificationBindings: [{ criterionId, executionId }],
          expectedRevision: 15,
          currentMessages: [],
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
