import { describe, expect, it } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import {
  SessionVerificationEvidenceLedger,
  classifyVerificationCommand,
  collectVerificationEvidence,
  formatVerificationCommandDisplay,
} from "./verification-evidence.js";

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

describe("command display redaction", () => {
  it("keeps secret-like values out of command displays", () => {
    const commands = [
      "pnpm test -- --token=synthetic-token-4f93a8",
      "pnpm test -- --password synthetic-password-8b27",
      'pnpm test -- --header "Authorization: Bearer synthetic-header-6d51"',
      "pnpm test -- API_KEY=synthetic-key-2c74",
      "pnpm test -- --token='unterminated-synthetic-token",
    ];
    const displays = commands.map((command) => formatVerificationCommandDisplay(command));
    expect(displays).toEqual([
      "pnpm test -- --token=[REDACTED]",
      "pnpm test -- --password [REDACTED]",
      "pnpm test -- --header [REDACTED]",
      "pnpm test -- API_KEY=[REDACTED]",
      "Approved verification command",
    ]);
    expect(JSON.stringify(displays)).not.toMatch(/synthetic-(?:token|password|header|key)/);
    expect(formatVerificationCommandDisplay("pnpm test -- TOKEN = synthetic-spaced-value")).toBe(
      "Approved verification command",
    );
    expect(formatVerificationCommandDisplay("pnpm test -- -k synthetic-short-value")).toBe(
      "pnpm test -- -k [REDACTED]",
    );
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
    "pnpm format:check",
    "npm run format:check",
    "yarn format:check",
    "bun run format:check",
    "pnpm format-check",
    "pnpm check && pnpm lint && pnpm format:check && pnpm test",
  ])("accepts bounded check: %s", (command) => {
    expect(classifyVerificationCommand(command)).toMatchObject({
      accepted: true,
      candidate: true,
      mayMutate: false,
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
    ["pnpm format", "mutating"],
    ["pnpm format:write", "mutating"],
    ["pnpm format:check:write", "mutating"],
    ["pnpm format:check --write", "mutating"],
    ["pnpm format:check --watch", "long-running"],
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
    expect(classifyVerificationCommand("pnpm format:check --write").mayMutate).toBe(true);
    expect(classifyVerificationCommand("pnpm test --update").mayMutate).toBe(true);
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
    [
      "completed",
      0,
      "passed",
      "command exited successfully; requirement coverage is not certified",
    ],
    ["nonZeroExit", 1, "failed", "failed (exit 1)"],
    ["spawnError", null, "failed", "launch failed"],
    ["timedOut", null, "failed", "timed out"],
    ["aborted", null, "failed", "cancelled"],
    [undefined, null, "unavailable", "execution outcome unavailable"],
  ])("retains terminal diagnostics for %s", (reason, exitCode, status, explanation) => {
    const ledger = new SessionVerificationEvidenceLedger();
    ledger.recordToolResult({
      name: "bash",
      args: { command: "tsc --noEmit" },
      isError: exitCode !== 0,
      details: {
        bashDiagnostics: {
          executionId: "terminal",
          command: "tsc --noEmit",
          cwd: "C:/project",
          startedAt: 1000,
          reason,
          exitCode,
          signal: "SIGTERM",
          elapsedMs: 123,
          timeoutMs: 120000,
          logPath: "C:/logs/terminal.log",
          tail: "fixture debugging target timed out: fetch failed",
        },
      },
    });
    const evidence = ledger.snapshot().currentEvidence[0];
    expect(evidence).toMatchObject({
      status,
      reason: explanation,
      exitCode,
      signal: "SIGTERM",
      elapsedMs: 123,
      timeoutMs: 120000,
      logPath: "C:/logs/terminal.log",
    });
    expect(evidence).not.toHaveProperty("tail");
  });

  it("accepts a successful path-qualified Windows Go test as ready evidence", () => {
    const command =
      "./.tools/go/bin/go.exe test ./internal/architecture -run '^TestProjectImportDAG$' -count=1";
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
        reason: "command exited successfully; requirement coverage is not certified",
      }),
    ]);
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
    ledger.recordToolResult({
      name: "edit",
      args: { file_path: "src/example.ts" },
      isError: false,
    });
    ledger.recordToolResult({
      name: "bash",
      args: { command: "pnpm check" },
      isError: false,
      evidenceRevision,
      workspace: TEST_WORKSPACE,
      details: {
        bashDiagnostics: {
          executionId: "in-flight",
          command: "pnpm check",
          cwd: "C:/project",
          startedAt: 1000,
          reason: "completed",
          exitCode: 0,
        },
      },
    });
    expect(ledger.snapshot()).toMatchObject({
      currentEvidence: [],
      staleEvidence: [{ executionId: "in-flight", status: "passed", workspace: TEST_WORKSPACE }],
    });
  });

  it("keeps equal commands isolated by execution, cwd, and reset boundary", () => {
    const ledger = new SessionVerificationEvidenceLedger();
    for (const [executionId, cwd, exitCode] of [
      ["one", "C:/one", 1],
      ["two", "C:/two", 0],
    ] as const) {
      ledger.recordToolResult({
        name: "bash",
        args: { command: "pnpm check" },
        isError: exitCode !== 0,
        details: {
          bashDiagnostics: {
            executionId,
            cwd,
            exitCode,
            command: "pnpm check",
            startedAt: 1000,
            reason: exitCode ? "nonZeroExit" : "completed",
          },
        },
      });
    }
    expect(ledger.snapshot().currentEvidence).toMatchObject([
      { executionId: "one", cwd: "C:/one", status: "failed" },
      { executionId: "two", cwd: "C:/two", status: "passed" },
    ]);
    ledger.clear();
    expect(ledger.snapshot()).toEqual({ currentEvidence: [], staleEvidence: [] });
  });

  it.each([
    "gg-app/src/local-release-notes.json",
    "gg-app/src/local-changelog.ts",
    "tsconfig.json",
  ])("conservatively stales backend evidence after editing %s", (file_path) => {
    const ledger = new SessionVerificationEvidenceLedger();
    record(ledger, "backend", "pnpm --filter @kenkaiiii/ggcoder exec tsc --noEmit");
    ledger.recordToolResult({ name: "edit", args: { file_path }, isError: false });
    expect(ledger.snapshot().currentEvidence).toEqual([]);
    expect(ledger.snapshot().staleEvidence[0]).toMatchObject({
      executionId: "backend",
      status: "passed",
    });
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
