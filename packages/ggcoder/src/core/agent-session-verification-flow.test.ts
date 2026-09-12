import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Message } from "@kenkaiiii/gg-ai";
import type { AgentEvent } from "@kenkaiiii/gg-agent";
import { useFakeHome } from "../test-support/fake-home.js";
import type { AgentSession } from "./agent-session.js";
import type { ProcessManager } from "./process-manager.js";

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
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(cwd, { recursive: true, force: true });
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
