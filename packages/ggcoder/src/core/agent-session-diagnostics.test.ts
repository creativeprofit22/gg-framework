import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent, AgentTool } from "@kenkaiiii/gg-agent";
import type { Message } from "@kenkaiiii/gg-ai";
import type { AgentSession } from "./agent-session.js";
import type { LspManager } from "./lsp/manager.js";
import { useFakeHome } from "../test-support/fake-home.js";
import { removeWhenReleased } from "./lsp/test-support.js";

interface Internals {
  tools: AgentTool[];
  lspManager: LspManager;
  trackHookEvent(event: AgentEvent): Promise<void>;
  getHookSteeringMessages(): Message[] | null;
  getHookFollowUpMessages(): Promise<Message[] | null>;
  eventBus: { on(event: string, callback: (data: Record<string, unknown>) => void): () => void };
}
let cwd: string;
let restoreHome: () => void;
let session: AgentSession;
let internal: Internals;
let id = 0;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gg-session-diagnostics-"));
  restoreHome = useFakeHome(cwd);
  await fs.mkdir(path.join(cwd, ".gg"));
  await fs.writeFile(
    path.join(cwd, ".gg", "settings.json"),
    JSON.stringify({ idealReviewEnabled: false }),
  );
  await fs.writeFile(path.join(cwd, "package.json"), '{"private":true}');
  await fs.writeFile(
    path.join(cwd, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, types: [] },
      include: ["*.ts"],
    }),
  );
  const { AgentSession: Session } = await import("./agent-session.js");
  session = new Session({
    provider: "anthropic",
    model: "claude-test",
    cwd,
    transient: true,
    projectCustomization: false,
    loadExtensions: false,
    systemPrompt: "test",
    allowedTools: ["read", "write", "edit", "bash"],
  });
  await session.initialize();
  internal = session as unknown as Internals;
});
afterEach(async () => {
  await session?.dispose();
  restoreHome?.();
  await removeWhenReleased(cwd);
});

async function execute(name: string, args: Record<string, unknown>): Promise<string> {
  const toolCallId = `diagnostics-${++id}`;
  const tool = internal.tools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Missing tool: ${name}`);
  await internal.trackHookEvent({ type: "tool_call_start", toolCallId, name, args });
  const result = await tool.execute(args, { toolCallId, signal: new AbortController().signal });
  const content = typeof result === "string" ? result : result.content;
  if (typeof content !== "string") throw new Error("Expected textual code-tool content");
  await internal.trackHookEvent({
    type: "tool_call_end",
    toolCallId,
    result: content,
    details: typeof result === "string" ? undefined : result.details,
    isError: false,
    durationMs: 0,
  });
  return content;
}

describe("GG App session asynchronous diagnostics", () => {
  it("does not add another model turn for silent diagnostics after a real passing typecheck", async () => {
    await execute("write", { file_path: "a.ts", content: "export const value: number = 1;\n" });
    await internal.lspManager.flushDiagnostics();
    internal.lspManager.drainDiagnostics();
    await execute("read", { file_path: "a.ts" });
    await execute("edit", { file_path: "a.ts", edits: [{ old_text: "= 1;", new_text: "= 2;" }] });
    const packageDir = fileURLToPath(new URL("../../", import.meta.url)).replace(/\\/g, "/");
    const projectDir = cwd.replace(/\\/g, "/");
    const check = await execute("bash", {
      command: `pnpm --dir "${packageDir}" exec tsc --noEmit --project "${projectDir}"`,
    });
    expect(check).toContain("Exit code: 0");
    expect(await internal.getHookFollowUpMessages()).toBeNull();
    expect(internal.lspManager.getLatestOutcome("a.ts")?.kind).toBe("timeout");
  }, 30_000);

  it("returns the real write before diagnostics and checks errors before allowing completion", async () => {
    const events: string[] = [];
    internal.eventBus.on("hook_armed", (event) =>
      events.push(`armed:${String(event.kind)}:${String(event.armed)}`),
    );
    internal.eventBus.on("hook", (event) => events.push(`hook:${String(event.kind)}`));
    const output = await execute("write", {
      file_path: "a.ts",
      content: 'export const value: number = "wrong";\n',
    });
    expect(output).toContain("Diagnostics queued");
    expect(internal.lspManager.hasQueuedDiagnostics()).toBe(true);
    expect(events).not.toContain("armed:verification:true");
    const followUp = await internal.getHookFollowUpMessages();
    expect(JSON.stringify(followUp)).toContain("Diagnostics in a.ts");
    expect(internal.lspManager.getLatestOutcome("a.ts")?.kind).toBe("diagnostics");
    expect(events).toContain("hook:verification");
    // Retain diagnostic delivery, without restoring the removed automatic test gate.
    expect(await internal.getHookFollowUpMessages()).toBeNull();
    expect(session.getVerificationEvidenceLedgerSnapshot().currentEvidence).toEqual([]);
  }, 30_000);

  it("delivers the latest edit's errors through steering without an output-polling tool", async () => {
    await execute("write", { file_path: "a.ts", content: "export const value: number = 1;\n" });
    await execute("read", { file_path: "a.ts" });
    const edit = await execute("edit", {
      file_path: "a.ts",
      edits: [{ old_text: "= 1;", new_text: '= "wrong";' }],
    });
    expect(edit).toContain("Diagnostics queued");
    await internal.lspManager.flushDiagnostics();
    expect(JSON.stringify(internal.getHookSteeringMessages())).toContain("Diagnostics in a.ts");
    expect(JSON.stringify(internal.getHookSteeringMessages())).not.toContain("Diagnostics in a.ts");
  }, 30_000);
});
