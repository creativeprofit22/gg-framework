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
import os from "node:os";
import path from "node:path";
import type { Message } from "@kenkaiiii/gg-ai";
import { useFakeHome } from "../test-support/fake-home.js";
import type { AgentEvent } from "@kenkaiiii/gg-agent";
import type { AgentSession } from "./agent-session.js";

interface FlowInternals {
  getHookFollowUpMessages(): Message[] | null;
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
async function makeSession(): Promise<{ internal: FlowInternals; events: string[] }> {
  const { AgentSession: Session } = await import("./agent-session.js");
  session = new Session({
    provider: "anthropic",
    model: "claude-test",
    cwd: tmpProject,
    transient: true,
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
): Promise<void> {
  const toolCallId = `call-${Math.random().toString(36).slice(2)}`;
  await internal.trackHookEvent({
    type: "tool_call_start",
    toolCallId,
    name,
    args,
  } as unknown as AgentEvent);
  await internal.trackHookEvent({
    type: "tool_call_end",
    toolCallId,
    result: "",
    isError: false,
    durationMs: 1,
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
