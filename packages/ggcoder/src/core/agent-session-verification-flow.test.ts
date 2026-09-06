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

interface FlowInternals {
  sessionPath: string;
  processManager: ProcessManager;
  getHookFollowUpMessages(): Message[] | null;
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

async function simulateToolCall(
  internal: FlowInternals,
  name: string,
  args: Record<string, unknown>,
  result = name === "bash" ? "Exit code: 0\n" : "",
): Promise<void> {
  const toolCallId = `call-${Math.random().toString(36).slice(2)}`;
  await internal.trackHookEvent({
    type: "tool_call_start",
    toolCallId,
    name,
    args,
  } as unknown as AgentEvent);
  const exitMatch = /^Exit code:\s*(-?\d+)(?:\s|$)/.exec(result);
  const exitCode = exitMatch ? Number(exitMatch[1]) : undefined;
  await internal.trackHookEvent({
    type: "tool_call_end",
    toolCallId,
    result,
    isError: false,
    durationMs: 1,
    details:
      name === "bash" && exitCode !== undefined
        ? { bashDiagnostics: { reason: exitCode === 0 ? "completed" : "nonZeroExit", exitCode } }
        : undefined,
  } as unknown as AgentEvent);
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
    const followUp = internal.getHookFollowUpMessages();
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
    expect(internal.getHookFollowUpMessages()).toBeNull();
    expect(events.filter((e) => e === "hook:verification")).toHaveLength(1);
  });

  it("stays silent end to end when the run verified its own edit", async () => {
    const { internal, events } = await makeSession();

    await simulateToolCall(internal, "edit", { file_path: "src/a.ts" });
    await simulateToolCall(internal, "bash", { command: "cd pkg && npm test" });

    // Disarmed by the verification, so no draft is ever held back.
    expect(events).toEqual(["hook_armed:verification:true", "hook_armed:verification:false"]);
    expect(internal.getHookFollowUpMessages()).toBeNull();
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
    } as unknown as AgentEvent);
    expect(internal.getVerificationProblem()).toContain("Unverified");
    await simulateToolCall(internal, "bash", { command: "pnpm test" });
    expect(internal.getVerificationProblem()).toBeNull();
  });

  it("does not let a check finishing after an intervening edit verify that edit", async () => {
    const { internal } = await makeSession();
    await simulateToolCall(internal, "edit", { file_path: "src/foo.ts" });
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
    await simulateToolCall(resumed.internal, "bash", { command: "pnpm test" });
    expect(resumed.internal.getVerificationProblem()).toBeNull();
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
    expect(internal.getHookFollowUpMessages()).toBeNull();
  });
});
