/**
 * What the USER sees when the verification gate fires.
 *
 * The gate's follow-up is hidden (provenance `completion_gate`), so the only
 * things a client can render around it are the `hook` notice and the
 * `hook_armed` hold. Without both, an injection reads as the agent posting two
 * unexplained final answers in a row. This test pins the emitted event
 * sequence, which is the whole of the flow a UI can act on.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { Message } from "@kenkaiiii/gg-ai";
import { useFakeHome } from "../test-support/fake-home.js";
import type { AgentEvent } from "@kenkaiiii/gg-agent";
import type { AgentSession } from "./agent-session.js";
import type { ProcessManager } from "./process-manager.js";
import { randomUUID } from "node:crypto";
import { classifyVerificationCommand } from "./verification-evidence.js";
import type { VerificationGate } from "./verification-gate.js";

interface FlowInternals {
  sessionPath: string;
  processManager: ProcessManager;
  resetHookState(originalRequest: string): void;
  verificationGate: {
    revision: number;
    injections: number;
    recheckInjections: number;
    tamperInjections: number;
    snapshot(): ReturnType<VerificationGate["snapshot"]>;
  };
  getHookFollowUpMessages(): Promise<Message[] | null>;
  getVerificationProblem(): string | null;
  trackHookEvent(event: AgentEvent): Promise<void>;
  eventBus: {
    on(event: string, handler: (data: Record<string, unknown>) => void): () => void;
  };
}

let restoreHome: (() => void) | undefined;
let tmpHome: string;
let tmpProject: string;
let session: AgentSession | undefined;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "gg-verify-flow-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "gg-verify-flow-"));
  restoreHome = useFakeHome(tmpHome);
  await fs.mkdir(path.join(tmpHome, ".gg"), { recursive: true });
  await fs.writeFile(
    path.join(tmpHome, ".gg", "auth.json"),
    JSON.stringify({
      anthropic: {
        accessToken: "test-token",
        refreshToken: "test-refresh",
        expiresAt: Date.now() + 3_600_000,
      },
    }),
    "utf-8",
  );
});

afterEach(async () => {
  await session?.dispose();
  session = undefined;
  restoreHome?.();
  await fs.rm(tmpHome, { recursive: true, force: true });
  await fs.rm(tmpProject, { recursive: true, force: true });
});

/** Records the client-visible event stream in emission order. */
async function makeSession(
  transient = true,
  sessionId?: string,
): Promise<{ internal: FlowInternals; events: string[] }> {
  const { AgentSession: Session } = await import("./agent-session.js");
  session = new Session({
    provider: "anthropic",
    model: "claude-test",
    cwd: tmpProject,
    transient,
    sessionId,
    systemPrompt: "test",
  });
  await session.initialize();
  const internal = session as unknown as FlowInternals;
  const events: string[] = [];
  internal.eventBus.on("hook", (d) => events.push(`hook:${String(d.kind)}`));
  internal.eventBus.on("hook_armed", (d) =>
    events.push(`hook_armed:${String(d.kind)}:${String(d.armed)}`),
  );
  return { internal, events };
}

function bashDetails(executionId: string, command: string, startedAt: number, result: string) {
  const exitMatch = /^Exit code:\s*(-?\d+)(?:\s|$)/.exec(result);
  if (!exitMatch) return undefined;
  const exitCode = Number(exitMatch[1]);
  return { bashDiagnostics: {
    executionId,
    pid: process.pid,
    command,
    cwd: tmpProject,
    startedAt,
    timeoutMs: 120_000,
    reason: exitCode === 0 ? "completed" : "nonZeroExit",
    exitCode,
    signal: null,
    elapsedMs: 1,
    logPath: path.join(tmpHome, ".gg", "foreground", `${executionId}.log`),
    tail: result,
    outputCapped: false,
    totalOutputBytes: Buffer.byteLength(result),
    retainedOutputBytes: Buffer.byteLength(result),
    droppedOutputBytes: 0,
  } };
}

async function simulateToolCall(
  internal: FlowInternals,
  name: string,
  args: Record<string, unknown>,
  result = name === "bash" ? "Exit code: 0\n" : "",
) {
  const toolCallId = randomUUID();
  const startedAt = Date.now();
  const startRevision = internal.verificationGate.revision;
  const command = typeof args.command === "string" ? args.command : "";
  await internal.trackHookEvent({
    type: "tool_call_start",
    toolCallId,
    name,
    args,
  } as unknown as AgentEvent);
  await internal.trackHookEvent({
    type: "tool_call_end",
    toolCallId,
    result,
    isError: false,
    durationMs: 1,
    details: name === "bash" ? bashDetails(toolCallId, command, startedAt, result) : undefined,
  } as unknown as AgentEvent);
  // Bounded assertion diagnostics only: never dump arguments, output or environment.
  return {
    sessionId: session!.getConversationIdentity().conversationId,
    runGeneration: session!.getRunJournal().at(-1)?.generation ?? 0,
    executionId: name === "bash" ? toolCallId : null,
    classification: name === "bash" ? classifyVerificationCommand(command) : null,
    startRevision,
    endRevision: internal.verificationGate.revision,
    mutationReason: internal.verificationGate.revision !== startRevision
      ? name === "bash" ? "potentially-mutating-check" : "file-edit"
      : null,
    reminderBudgetUsed: {
      initial: internal.verificationGate.injections,
      recheck: internal.verificationGate.recheckInjections,
      tamper: internal.verificationGate.tamperInjections,
    },
  };
}

describe("verification gate flow", () => {
  it("arms before the draft streams, then announces itself when it injects", async () => {
    const { internal, events } = await makeSession();

    // Work: one code edit, nothing run since.
    await simulateToolCall(internal, "edit", { file_path: "src/a.ts" });

    // Arming must land on the tool call — i.e. BEFORE the model writes the
    // candidate final answer — or the client has already painted the draft it
    // is about to replace.
    expect(events).toContain("hook_armed:verification:true");
    expect(events.indexOf("hook_armed:verification:true")).toBe(0);

    // The stop: the gate injects, and says so.
    const followUp = await internal.getHookFollowUpMessages();
    expect(followUp).not.toBeNull();
    expect(String(followUp![0]!.content)).toContain("Run the project's verification");
    expect(events).toEqual([
      "hook_armed:verification:true",
      "hook:verification",
      // Disarm AFTER the notice: clients release held text on disarm, so the
      // reverse order paints the draft and then deletes it.
      "hook_armed:verification:false",
    ]);

    // One notice, one injection: the reviewed answer that follows streams live
    // and is the only final answer the user sees.
    expect(await internal.getHookFollowUpMessages()).toBeNull();
    expect(events.filter((e) => e === "hook:verification")).toHaveLength(1);
  });

  it("stays silent end to end when the run verified its own edit", async () => {
    const { internal, events } = await makeSession();

    await simulateToolCall(internal, "edit", { file_path: "src/a.ts" });
    await simulateToolCall(internal, "bash", { command: "cd pkg && npm test" });

    // Disarmed by the verification, so no draft is ever held back.
    expect(events).toEqual(["hook_armed:verification:true", "hook_armed:verification:false"]);
    expect(await internal.getHookFollowUpMessages()).toBeNull();
  });

  it("keeps accepted foreground evidence settled across completed explanation-only runs", async () => {
    const { internal, events } = await makeSession(false);
    internal.resetHookState("Repair the verification flow");
    await session!.persistRunStarted(1);
    const edit = await simulateToolCall(internal, "edit", { file_path: "src/a.ts" });
    const check = await simulateToolCall(internal, "bash", {
      command: "pnpm --filter @kenkaiiii/ggcoder exec vitest run src/core/verification-gate.test.ts",
      run_in_background: false,
      persist: false,
    });
    const typecheck = await simulateToolCall(internal, "bash", {
      command: "pnpm --filter @kenkaiiii/ggcoder check",
    });
    const diagnostic = JSON.stringify({ edit, check, typecheck });
    expect(check.classification?.accepted, diagnostic).toBe(true);
    expect(check.startRevision, diagnostic).toBe(edit.endRevision);
    expect(check.endRevision, diagnostic).toBe(check.startRevision);
    expect(check.mutationReason, diagnostic).toBeNull();
    const ledger = session!.getVerificationEvidenceLedgerSnapshot();
    expect(ledger.currentEvidence, diagnostic).toEqual([
      expect.objectContaining({ executionId: check.executionId, status: "passed", cwd: tmpProject }),
      expect.objectContaining({ executionId: typecheck.executionId, status: "passed", cwd: tmpProject }),
    ]);
    expect(ledger.staleEvidence, diagnostic).toEqual([]);
    expect(internal.getVerificationProblem(), diagnostic).toBeNull();
    expect(await internal.getHookFollowUpMessages(), diagnostic).toBeNull();
    await session!.persistRunFinished(1, "completed");
    const settled = internal.verificationGate.snapshot();
    const before = events.length;

    for (const generation of [2, 3, 4]) {
      // Exercise the session's real per-prompt reset, not Gate.beginRun alone.
      internal.resetHookState("Explain the previous result");
      await session!.persistRunStarted(generation);
      await internal.trackHookEvent({ type: "text_delta", text: "The checks passed." });
      expect(internal.getVerificationProblem(), diagnostic).toBeNull();
      expect(await internal.getHookFollowUpMessages(), diagnostic).toBeNull();
      expect(internal.verificationGate.snapshot(), diagnostic).toEqual(settled);
      expect(session!.getVerificationEvidenceLedgerSnapshot(), diagnostic).toEqual(ledger);
      expect(events.length, diagnostic).toBe(before);
      await session!.persistRunFinished(generation, "completed");
    }
    expect(session!.getRunJournal().map(({ generation, outcome }) => ({ generation, outcome })))
      .toEqual([1, 2, 3, 4].map((generation) => ({ generation, outcome: "completed" })));
  });

  it("re-arms after an actual edit in a later run and spends only one reminder", async () => {
    const { internal, events } = await makeSession();
    internal.resetHookState("Repair code");
    await simulateToolCall(internal, "edit", { file_path: "src/a.ts" });
    await simulateToolCall(internal, "bash", { command: "pnpm test" });
    expect(await internal.getHookFollowUpMessages()).toBeNull();
    const evidence = session!.getVerificationEvidenceLedgerSnapshot().currentEvidence;

    internal.resetHookState("Change code again");
    const edit = await simulateToolCall(internal, "edit", { file_path: "src/a.ts" });
    const diagnostic = JSON.stringify(edit);
    expect(edit.endRevision, diagnostic).toBeGreaterThan(edit.startRevision);
    expect(edit.mutationReason, diagnostic).toBe("file-edit");
    expect(session!.getVerificationEvidenceLedgerSnapshot(), diagnostic).toEqual({
      currentEvidence: [], staleEvidence: evidence,
    });
    expect(internal.getVerificationProblem(), diagnostic).toContain("Unverified");
    expect(await internal.getHookFollowUpMessages(), diagnostic).not.toBeNull();
    expect(await internal.getHookFollowUpMessages(), diagnostic).toBeNull();
    expect(internal.verificationGate.injections, diagnostic).toBe(1);
    expect(internal.verificationGate.recheckInjections, diagnostic).toBe(1);
    const before = events.length;
    internal.resetHookState("Explain what remains");
    expect(await internal.getHookFollowUpMessages(), diagnostic).toBeNull();
    expect(internal.getVerificationProblem(), diagnostic).toContain("Unverified");
    expect(events.length, diagnostic).toBe(before);
  });

  it("preserves same-revision failure debt across a later explanation and unrelated pass", async () => {
    const { internal } = await makeSession();
    internal.resetHookState("Repair code");
    await simulateToolCall(internal, "edit", { file_path: "src/a.ts" });
    const failed = await simulateToolCall(internal, "bash", { command: "pnpm test" }, "Exit code: 1\n");
    expect(await internal.getHookFollowUpMessages()).not.toBeNull();
    internal.resetHookState("Explain the failed check");
    await simulateToolCall(internal, "bash", { command: "pnpm lint" });
    const diagnostic = JSON.stringify(failed);
    expect(internal.getVerificationProblem(), diagnostic).toContain("failed");
    expect(await internal.getHookFollowUpMessages(), diagnostic).toBeNull();
    expect(session!.getVerificationEvidenceLedgerSnapshot().currentEvidence, diagnostic).toEqual([
      expect.objectContaining({ executionId: failed.executionId, status: "failed" }),
      expect.objectContaining({ status: "passed", command: "pnpm lint" }),
    ]);
    await simulateToolCall(internal, "bash", { command: "pnpm test" });
    expect(internal.getVerificationProblem(), diagnostic).toBeNull();
  });

  it("counts a check piped through a tail limiter, so a question turn is never hijacked", async () => {
    const { internal, events } = await makeSession();

    await simulateToolCall(internal, "edit", { file_path: "src/a.ts" });
    // The agent-habit shape that caused the real-world incident: green suite,
    // output piped through tail. Pre-pipefail this was rejected as evidence,
    // the gate stayed armed past the turn, and the NEXT turn — a plain user
    // question — had its draft held, discarded, and replaced by the hook
    // notice. With pipefail + the limiter rule it is ordinary passing evidence.
    await simulateToolCall(
      internal,
      "bash",
      { command: "pnpm test 2>&1 | tail -6" },
      "Exit code: 0\n3 passing",
    );

    expect(internal.getVerificationProblem()).toBeNull();
    expect(await internal.getHookFollowUpMessages()).toBeNull();
    expect(events).toEqual(["hook_armed:verification:true", "hook_armed:verification:false"]);
  });

  it("still rejects piped checks whose stages can transform results", async () => {
    const { internal } = await makeSession();
    await simulateToolCall(internal, "edit", { file_path: "src/a.ts" });
    await simulateToolCall(
      internal,
      "bash",
      { command: "pnpm test | grep -q 'all passed'" },
      "Exit code: 0",
    );
    expect(internal.getVerificationProblem()).toContain("Unverified");
  });

  it("does not treat a nonzero bash exit as passing merely because the tool returned normally", async () => {
    const { internal } = await makeSession();
    await simulateToolCall(internal, "edit", { file_path: "src/foo.ts" });
    await simulateToolCall(internal, "bash", { command: "pnpm test" }, "Exit code: 1\nfailed");
    expect(internal.getVerificationProblem()).toContain("failed");
    await simulateToolCall(internal, "bash", { command: "pnpm lint" });
    expect(internal.getVerificationProblem()).toContain("failed");
    await simulateToolCall(internal, "bash", { command: "pnpm test" });
    expect(internal.getVerificationProblem()).toBeNull();
  });

  it("does not accept claimed success or a shell command that can mask failure", async () => {
    const { internal } = await makeSession();
    await simulateToolCall(internal, "edit", { file_path: "src/foo.ts" });
    await simulateToolCall(internal, "bash", { command: "pnpm test" }, "All tests passed!");
    expect(internal.getVerificationProblem()).toContain("Unverified");
    await simulateToolCall(internal, "bash", { command: "pnpm test || true" });
    expect(internal.getVerificationProblem()).toContain("Unverified");
    await simulateToolCall(internal, "bash", { command: "node script.js --test" });
    expect(internal.getVerificationProblem()).toContain("Unverified");
  });

  it("invalidates an earlier check when a later check can rewrite files", async () => {
    const { internal } = await makeSession();
    await simulateToolCall(internal, "edit", { file_path: "src/foo.ts" });
    const startedAt = Date.now();
    await internal.trackHookEvent({
      type: "tool_call_start",
      toolCallId: "before-fix",
      name: "bash",
      args: { command: "pnpm test" },
    } as unknown as AgentEvent);
    await simulateToolCall(internal, "bash", { command: "pnpm eslint --fix src/foo.ts" });
    await internal.trackHookEvent({
      type: "tool_call_end",
      toolCallId: "before-fix",
      result: "Exit code: 0\n",
      isError: false,
      durationMs: 1,
      details: bashDetails("before-fix", "pnpm test", startedAt, "Exit code: 0\n"),
    } as unknown as AgentEvent);
    expect(internal.getVerificationProblem()).toContain("Unverified");
    await simulateToolCall(internal, "bash", { command: "pnpm test" });
    expect(internal.getVerificationProblem()).toBeNull();
  });

  it("does not let a check finishing after an intervening edit verify that edit", async () => {
    const { internal } = await makeSession();
    await simulateToolCall(internal, "edit", { file_path: "src/foo.ts" });
    const startedAt = Date.now();
    await internal.trackHookEvent({
      type: "tool_call_start",
      toolCallId: "stale",
      name: "bash",
      args: { command: "pnpm test" },
    } as unknown as AgentEvent);
    await simulateToolCall(internal, "edit", { file_path: "src/foo.ts" });
    await internal.trackHookEvent({
      type: "tool_call_end",
      toolCallId: "stale",
      result: "Exit code: 0\n",
      isError: false,
      durationMs: 1,
      details: bashDetails("stale", "pnpm test", startedAt, "Exit code: 0\n"),
    } as unknown as AgentEvent);
    expect(internal.getVerificationProblem()).toContain("Unverified");
    await simulateToolCall(internal, "bash", { command: "pnpm test" });
    expect(internal.getVerificationProblem()).toBeNull();
  });

  it("uses real background exit codes and never reuses old output after another edit", async () => {
    const { internal } = await makeSession();
    await fs.writeFile(path.join(tmpProject, "subject.mjs"), "export const value = 0;\n");
    await fs.writeFile(
      path.join(tmpProject, "verification.test.mjs"),
      "import assert from 'node:assert/strict'; import {value} from './subject.mjs'; assert.equal(value, 1);\n",
    );
    await simulateToolCall(internal, "edit", { file_path: "subject.mjs" });
    const command = "node --test verification.test.mjs";
    const check = async () => {
      const started = await internal.processManager.start(command, tmpProject);
      await simulateToolCall(
        internal,
        "bash",
        { command, run_in_background: true },
        `ID: ${started.id}\n`,
      );
      expect(internal.getVerificationProblem()).toContain("Unverified");
      expect(await internal.processManager.waitForExit(started.id, 5000)).toBe("exited");
      await simulateToolCall(internal, "task_output", { id: started.id });
      return started.id;
    };
    await check();
    expect(internal.getVerificationProblem()).toContain("failed");
    await fs.writeFile(path.join(tmpProject, "subject.mjs"), "export const value = 1;\n");
    await simulateToolCall(internal, "edit", { file_path: "subject.mjs" });
    const passedId = await check();
    expect(internal.getVerificationProblem()).toBeNull();
    await fs.writeFile(path.join(tmpProject, "subject.mjs"), "export const value = 2;\n");
    await simulateToolCall(internal, "edit", { file_path: "subject.mjs" });
    await simulateToolCall(internal, "task_output", { id: passedId });
    expect(internal.getVerificationProblem()).toContain("Unverified");
  });

  it("recognizes a real background npm test after a git status prelude", async () => {
    const { internal } = await makeSession();
    execFileSync("git", ["init", "--quiet"], { cwd: tmpProject });
    await fs.writeFile(
      path.join(tmpProject, "package.json"),
      JSON.stringify({ scripts: { test: "node --test verification.test.mjs" } }),
    );
    await fs.writeFile(
      path.join(tmpProject, "verification.test.mjs"),
      "import assert from 'node:assert/strict'; assert.equal(1 + 1, 2);\n",
    );
    await simulateToolCall(internal, "edit", { file_path: "verification.test.mjs" });
    const command = "git status --short && npm run test";
    const started = await internal.processManager.start(command, tmpProject);
    await simulateToolCall(
      internal,
      "bash",
      { command, run_in_background: true },
      `ID: ${started.id}\n`,
    );
    expect(internal.getVerificationProblem()).toContain("Unverified");
    // The npm chain (npm.cmd → node → npm → script) cold-starts far slower on a
    // loaded Windows CI runner than the 5s cap used for direct `node --test`
    // runs — waitForExit still returns the instant the process exits, this only
    // raises the hang ceiling so a slow spawn is not misread as a hang.
    expect(await internal.processManager.waitForExit(started.id, 30_000)).toBe("exited");
    await simulateToolCall(internal, "task_output", { id: started.id });
    expect(internal.getVerificationProblem()).toBeNull();
  });

  it("persists unresolved verification and requires fresh evidence after resuming", async () => {
    const { internal } = await makeSession(false);
    await simulateToolCall(internal, "edit", { file_path: "subject.ts" });
    await simulateToolCall(internal, "bash", { command: "pnpm test" }, "Exit code: 1\n");
    const saved = internal.sessionPath;
    await session!.dispose();
    const resumed = await makeSession(false, saved);
    expect(resumed.internal.getVerificationProblem()).toContain("failed");
    expect(resumed.internal.verificationGate.snapshot().failedChecks).toHaveLength(1);
    expect(session!.getVerificationEvidenceLedgerSnapshot().currentEvidence).toEqual([]);
    resumed.internal.resetHookState("Explain the restored failure");
    expect(await resumed.internal.getHookFollowUpMessages()).toBeNull();
    expect(resumed.internal.getVerificationProblem()).toContain("failed");
    const fresh = await simulateToolCall(resumed.internal, "bash", { command: "pnpm test" });
    expect(resumed.internal.getVerificationProblem()).toBeNull();
    expect(session!.getVerificationEvidenceLedgerSnapshot().currentEvidence).toEqual([
      expect.objectContaining({ executionId: fresh.executionId, status: "passed" }),
    ]);
  });

  it.each(["reload", "checkpoint"] as const)("requires a fresh check for edits after a historical pass (%s)", async (mode) => {
    const { internal } = await makeSession(false);
    await simulateToolCall(internal, "edit", { file_path: "subject.ts" });
    await simulateToolCall(internal, "bash", { command: "pnpm test" });
    expect(internal.getVerificationProblem()).toBeNull();
    // Completed sessions remain settled; only subsequent unverified work is owed.
    await simulateToolCall(internal, "edit", { file_path: "subject.ts" });
    if (mode === "reload") await session!.loadSession(internal.sessionPath);
    else await session!.loadSessionCheckpoint(internal.sessionPath, session!.getConversationIdentity().conversationId);
    expect(internal.getVerificationProblem()).toContain("Unverified");
    await simulateToolCall(internal, "bash", { command: "pnpm test" });
    expect(internal.getVerificationProblem()).toBeNull();
  });

  it("has notice copy for every hook kind the session can emit", async () => {
    // Both surfaces render from a fixed map keyed by hook kind; a kind with no
    // entry renders nothing at all, which is the silent-duplicate bug again.
    const { VERIFICATION_HOOK_NOTICE_TEXT } = await import("../ui/app-items.js");
    expect(VERIFICATION_HOOK_NOTICE_TEXT).toContain("verification");

    const appEvents = await fs.readFile(
      path.join(__dirname, "..", "..", "..", "..", "gg-app", "src", "useAgentEvents.ts"),
      "utf-8",
    );
    const presentation = appEvents.slice(
      appEvents.indexOf("HOOK_PRESENTATION"),
      appEvents.indexOf("function formatElapsed"),
    );
    for (const kind of ["ideal", "verification", "loop_break", "regrounding"]) {
      expect(presentation).toContain(`${kind}: {`);
    }
  });

  it("emits nothing at all when no code was touched", async () => {
    const { internal, events } = await makeSession();

    await simulateToolCall(internal, "read", { file_path: "src/a.ts" });
    await simulateToolCall(internal, "write", { file_path: "README.md" });

    expect(events).toEqual([]);
    expect(await internal.getHookFollowUpMessages()).toBeNull();
  });

  it("answers later question turns instead of re-hijacking them with the verification hook", async () => {
    // The live incident, replayed against the real session: code edited, the
    // check the agent actually ran did not count as evidence, and EVERY later
    // prompt — plain questions included — was answered by "Hook engaged"
    // plus a verification status instead of the user's question.
    const { internal, events } = await makeSession();

    await simulateToolCall(internal, "edit", { file_path: "src/a.ts" });
    // `make test` is a real check the evidence classifier cannot vouch for:
    // green output, exit 0 — but not bounded evidence.
    await simulateToolCall(internal, "bash", { command: "make test" });
    expect(internal.getVerificationProblem()).toContain("Unverified");
    // The work turn gets its one demand, as designed.
    expect(await internal.getHookFollowUpMessages()).not.toBeNull();

    // The next user prompt: a new run with no edits. The inherited debt must
    // NOT re-arm — no hold, no notice, the answer streams untouched.
    const before = events.length;
    internal.resetHookState("Explain the previous result");
    expect(await internal.getHookFollowUpMessages()).toBeNull();
    expect(events.length).toBe(before);
  });

  it("records neither pass nor failure for persistent-shell checks, however they exit", async () => {
    const { internal } = await makeSession();

    await simulateToolCall(internal, "edit", { file_path: "src/a.ts" });
    await simulateToolCall(internal, "bash", { command: "pnpm test", persist: true });
    // Not evidence — but not a FAILED check either: a false failure here
    // poisoned every later green run of a different command spelling.
    expect(internal.getVerificationProblem()).toContain("Unverified");
    expect(internal.getVerificationProblem()).not.toContain("failed");
  });
});
