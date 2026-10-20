import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Message } from "@kenkaiiii/gg-ai";
import type { AgentEvent } from "@kenkaiiii/gg-agent";
import { useFakeHome } from "../test-support/fake-home.js";
import { removeWhenReleased } from "./lsp/test-support.js";
import type { AgentSession } from "./agent-session.js";
import type { ProcessManager } from "./process-manager.js";
import { createBashTool, REVIEW_REJECTED_BEFORE_START } from "../tools/bash.js";

interface FlowInternals {
  processManager: ProcessManager;
  resetHookState(request: string): void;
  getHookFollowUpMessages(): Promise<Message[] | null>;
  trackHookEvent(event: AgentEvent): Promise<void>;
  eventBus: { on(event: string, handler: (data: Record<string, unknown>) => void): () => void };
}
let home: string;
let cwd: string;
let restoreHome: (() => void) | undefined;
let session: AgentSession | undefined;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "gg-report-home-"));
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gg-report-project-"));
  restoreHome = useFakeHome(home);
  await fs.mkdir(path.join(home, ".gg"), { recursive: true });
  await fs.writeFile(
    path.join(home, ".gg", "auth.json"),
    JSON.stringify({
      anthropic: {
        accessToken: "fixture-access",
        refreshToken: "fixture-refresh",
        expiresAt: Date.now() + 3600000,
      },
    }),
  );
});
afterEach(async () => {
  await session?.dispose();
  session = undefined;
  restoreHome?.();
  // Windows refuses to delete a folder a still-exiting node child holds.
  await removeWhenReleased(home);
  await removeWhenReleased(cwd);
});
async function makeSession(transient = true, sessionId?: string) {
  const { AgentSession: Session } = await import("./agent-session.js");
  session = new Session({
    provider: "anthropic",
    model: "claude-test",
    cwd,
    transient,
    sessionId,
    systemPrompt: "test",
  });
  await session.initialize();
  const internal = session as unknown as FlowInternals;
  const events: string[] = [];
  internal.eventBus.on("hook", (event) => events.push(String(event.kind)));
  internal.eventBus.on("hook_armed", (event) => events.push(String(event.kind)));
  internal.resetHookState("Audit current work and report remaining gaps");
  return { internal, events };
}
async function tool(
  internal: FlowInternals,
  name: string,
  args: Record<string, unknown>,
  exitCode?: number,
) {
  const toolCallId = randomUUID();
  const result = exitCode === undefined ? "output unavailable" : `Exit code: ${exitCode}\n`;
  await internal.trackHookEvent({ type: "tool_call_start", toolCallId, name, args } as AgentEvent);
  const details =
    name === "bash"
      ? {
          bashDiagnostics: {
            executionId: toolCallId,
            pid: process.pid,
            command: String(args.command),
            cwd,
            startedAt: Date.now(),
            timeoutMs: 120000,
            reason:
              exitCode === undefined ? "unavailable" : exitCode === 0 ? "completed" : "nonZeroExit",
            exitCode: exitCode ?? null,
            signal: null,
            elapsedMs: 1,
            logPath: path.join(home, `${toolCallId}.log`),
            tail: result,
            outputCapped: false,
            totalOutputBytes: result.length,
            retainedOutputBytes: result.length,
            droppedOutputBytes: 0,
          },
        }
      : undefined;
  await internal.trackHookEvent({
    type: "tool_call_end",
    toolCallId,
    result,
    isError: false,
    durationMs: 1,
    details,
  } as AgentEvent);
}

describe("honest reports without stop gates", () => {
  it.each(["Audit the code", "Plan remaining work", "Save partial progress"])(
    "allows %s to stop after an edit",
    async (request) => {
      const { internal, events } = await makeSession();
      internal.resetHookState(request);
      await tool(internal, "edit", { file_path: "source.ts" });
      expect(await internal.getHookFollowUpMessages()).toBeNull();
      expect(await internal.getHookFollowUpMessages()).toBeNull();
      expect(events).not.toContain("verification");
      expect(
        session!
          .getMessages()
          .some((message) => JSON.stringify(message).includes("roadmap_status")),
      ).toBe(false);
    },
  );

  it("retains command failures and unavailable output without forcing another turn", async () => {
    const { internal, events } = await makeSession();
    await tool(internal, "bash", { command: "node --test first.test.mjs" }, 1);
    await tool(internal, "bash", { command: "node --test second.test.mjs" }, 0);
    await tool(internal, "bash", { command: "node --test missing.test.mjs" });
    expect(
      session!.getVerificationEvidenceLedgerSnapshot().currentEvidence.map((entry) => entry.status),
    ).toEqual(["failed", "passed", "unavailable"]);
    expect(await internal.getHookFollowUpMessages()).toBeNull();
    expect(events).not.toContain("verification");
  });

  // Upstream regression: plain git/shell commands must not re-arm a
  // verification demand or be recorded as verification evidence.
  it.each([
    "git status --short && git diff --stat",
    "rm -r scratch.html && git status --short && echo CLEAN",
  ])("does not demand verification after ordinary shell work: %s", async (command) => {
    const { internal, events } = await makeSession();
    await tool(internal, "edit", { file_path: "subject.mjs" });
    await tool(internal, "bash", { command }, 0);
    expect(session!.getVerificationEvidenceLedgerSnapshot().currentEvidence).toEqual([]);
    expect(await internal.getHookFollowUpMessages()).toBeNull();
    expect(events).not.toContain("verification");
  });

  // Upstream regression: a review the bash tool rejects before spawning ran
  // nothing, so it is neither a pass nor a failure.
  it("records nothing for a review rejected before start, but keeps real failures", async () => {
    const { internal } = await makeSession();
    await tool(internal, "edit", { file_path: "subject.mjs" });
    const bash = createBashTool(cwd, internal.processManager);
    const args = { command: "node --test a.test.mjs && git diff --check", review: true };
    const toolCallId = randomUUID();
    await internal.trackHookEvent({
      type: "tool_call_start",
      toolCallId,
      name: "bash",
      args,
    } as AgentEvent);
    const result = await bash.execute(args, { signal: new AbortController().signal, toolCallId });
    expect(result).toBe(REVIEW_REJECTED_BEFORE_START);
    await internal.trackHookEvent({
      type: "tool_call_end",
      toolCallId,
      result,
      isError: false,
      durationMs: 1,
    } as AgentEvent);
    expect(session!.getVerificationEvidenceLedgerSnapshot().currentEvidence).toEqual([]);

    // Matching text from a check that actually ran must still count.
    await tool(internal, "bash", { command: "node --test a.test.mjs", review: true }, 1);
    expect(
      session!.getVerificationEvidenceLedgerSnapshot().currentEvidence.map((entry) => entry.status),
    ).toEqual(["failed"]);
  });

  it("accepts format-check evidence without restoring automatic reminders", async () => {
    const { internal, events } = await makeSession();
    await tool(internal, "edit", { file_path: "src/a.test.ts" });
    await tool(
      internal,
      "bash",
      {
        command: "pnpm check && pnpm lint && pnpm format:check && pnpm test",
      },
      0,
    );
    expect(
      session!.getVerificationEvidenceLedgerSnapshot().currentEvidence.map((entry) => entry.status),
    ).toEqual(["passed"]);
    expect(await internal.getHookFollowUpMessages()).toBeNull();
    expect(events).not.toContain("verification");
  });

  it("resumes without requiring fresh evidence or claiming historical outcomes are current", async () => {
    const { internal } = await makeSession(false);
    await tool(internal, "bash", { command: "node --test first.test.mjs" }, 1);
    const sessionId = session!.getConversationIdentity().conversationId;
    const sessionPath = session!.getState().sessionPath;
    await session!.dispose();
    session = undefined;
    if (!sessionPath) throw new Error("Expected persisted session");
    const legacy = {
      type: "custom",
      kind: "verification_state",
      id: randomUUID(),
      parentId: null,
      timestamp: new Date().toISOString(),
      data: {
        version: 1,
        seq: 2,
        mutation: 1,
        verified: 0,
        files: ["source.ts"],
        failedChecks: [],
        unknown: true,
      },
    };
    await fs.appendFile(sessionPath, `${JSON.stringify(legacy)}\n`);
    await fs.writeFile(
      path.join(home, ".gg", "settings.json"),
      JSON.stringify({ verificationGateEnabled: true }),
    );
    const resumed = await makeSession(false, sessionId);
    expect(await resumed.internal.getHookFollowUpMessages()).toBeNull();
    expect(resumed.events).not.toContain("verification");
    expect(session!.getVerificationEvidenceLedgerSnapshot().currentEvidence).toEqual([]);
  });

  it("keeps real background exits distinct from unavailable foreground observations", async () => {
    const { internal } = await makeSession();
    for (const exitCode of [1, 0]) {
      const started = await internal.processManager.start(
        `node -e "process.exit(${exitCode})"`,
        cwd,
      );
      await tool(internal, "bash", {
        command: `node -e "process.exit(${exitCode})"`,
        run_in_background: true,
      });
      expect(await internal.processManager.waitForExit(started.id, 5000)).toBe("exited");
      expect(internal.processManager.list().find((task) => task.id === started.id)?.exitCode).toBe(
        exitCode,
      );
      expect(await internal.getHookFollowUpMessages()).toBeNull();
    }
    expect(
      session!
        .getVerificationEvidenceLedgerSnapshot()
        .currentEvidence.every((entry) => entry.status === "unavailable"),
    ).toBe(true);
  });
});

// Upstream 0.94 regression (arena, 2026-10-18): Haiku 5.5 ran passing tests
// inside longer commands in 21/50 trials; none counted, so runs showed as
// unverified. The session now re-runs that check standalone, on this ledger.
describe("re-running a check whose exit status could not count", { timeout: 60_000 }, () => {
  const check = "node --test pass.test.mjs";
  const compound = `${check} 2>&1 | tail -3; node -e "console.log(1)"`;
  const writeTest = (passes: boolean) =>
    fs.writeFile(
      path.join(cwd, "pass.test.mjs"),
      `import test from "node:test";\ntest("t", () => { if (!${passes}) throw new Error("no"); });\n`,
    );
  const evidenceFor = (command: string) =>
    session!
      .getVerificationEvidenceLedgerSnapshot()
      .currentEvidence.filter((entry) => entry.command === command);

  it("records the re-run's pass when the turn would end", async () => {
    await writeTest(true);
    const { internal } = await makeSession();
    await tool(internal, "edit", { file_path: "source.ts" });
    await tool(internal, "bash", { command: compound }, 0);
    expect(session!.getVerificationProblem()).not.toBeNull();
    await internal.getHookFollowUpMessages();
    expect(session!.getVerificationProblem()).toBeNull();
    expect(evidenceFor(check)).toEqual([expect.objectContaining({ status: "passed" })]);
  });

  it("stays unverified, without a recorded failure, when the re-run fails", async () => {
    await writeTest(false);
    const { internal } = await makeSession();
    await tool(internal, "edit", { file_path: "source.ts" });
    await tool(internal, "bash", { command: compound }, 0);
    await internal.getHookFollowUpMessages();
    const problem = session!.getVerificationProblem();
    expect(problem).not.toBeNull();
    expect(problem).not.toContain("a check failed");
    expect(evidenceFor(check)).toEqual([]);
  });

  it("does not run a check the model skipped after its last edit", async () => {
    await writeTest(true);
    const { internal } = await makeSession();
    await tool(internal, "bash", { command: compound }, 0);
    await tool(internal, "edit", { file_path: "source.ts" });
    await internal.getHookFollowUpMessages();
    expect(session!.getVerificationProblem()).not.toBeNull();
    expect(evidenceFor(check)).toEqual([]);
  });
});
