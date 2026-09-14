import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stream, StreamResult, type ToolCall } from "@kenkaiiii/gg-ai";
import { AgentSession } from "./agent-session.js";
import { AuthStorage } from "./auth-storage.js";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { useFakeHome } from "../test-support/fake-home.js";
import { buildProgrammaticProfileProposal, persistProgrammaticProfile } from "./programmatic/profile.js";
import { PROGRAMMATIC_STATE_PATH } from "./programmatic/lifecycle.js";

// Only the network-facing provider stream is scripted. AgentSession and the agent loop are real.
vi.mock("@kenkaiiii/gg-ai", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()), stream: vi.fn(),
}));
let cwd: string;
let restore: () => void;
beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "programmatic-provider-"));
  restore = useFakeHome(path.join(cwd, "home"));
  vi.spyOn(AuthStorage.prototype, "resolveCredentials").mockResolvedValue({ accessToken: "fixture-not-a-real-credential", refreshToken: "", expiresAt: Number.MAX_SAFE_INTEGER });
  vi.mocked(stream).mockClear();
  vi.mocked(stream).mockImplementation(() => new StreamResult((async function* () {
    yield { type: "text_delta", text: "Scripted response." };
    return { message: { role: "assistant", content: "Scripted response." }, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
  })()));
});
afterEach(async () => {
  restore(); vi.restoreAllMocks(); await fs.rm(cwd, { recursive: true, force: true });
});
it("keeps non-coder sessions out of command discovery and assessment expansion", async () => {
  const session = new AgentSession({ cwd, provider: "anthropic", model: "claude-sonnet-5", transient: true,
    systemPrompt: "Fixture", mcpEnabled: false, coderSlashCommands: false });
  try {
    await session.initialize();
    await session.prompt("/programmatic focus");
    const request = vi.mocked(stream).mock.calls[0]![0];
    expect(request.messages.find((message) => message.role === "user")?.content).toBe("/programmatic focus");
    const search = (session as unknown as { tools: AgentTool[] }).tools.find((tool) => tool.name === "tool_search")!;
    const found = String(await search.execute({ query: "command_information" }, { signal: new AbortController().signal, toolCallId: "fixture" }));
    expect(found).not.toContain('"name":"command_information"');
    expect((session as unknown as { tools: AgentTool[] }).tools.some((tool) => tool.name === "command_information")).toBe(false);
    await expect(fs.stat(path.join(cwd, ".gg/programmatic"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await session.dispose(); }
});

it.each(["", "  café\n日本語  "])("delivers assessment %j through the real loop to a scripted provider", async (focus) => {
  const proposal = await buildProgrammaticProfileProposal(cwd);
  expect((await persistProgrammaticProfile(cwd, proposal.configurationFingerprint, proposal.profile)).ok).toBe(true);
  const session = new AgentSession({ cwd, provider: "anthropic", model: "claude-sonnet-5", transient: true, systemPrompt: "Fixture", mcpEnabled: false });
  try {
    await session.initialize();
    await session.prompt(`/programmatic ${focus}`);
    expect(stream).toHaveBeenCalled();
    const request = vi.mocked(stream).mock.calls[0]![0];
    const user = request.messages.find((message) => message.role === "user");
    const text = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content);
    expect(text).toContain("Untrusted advisory context");
    expect(text).toContain("empty argument object");
    expect(text).toContain(focus.trim() ? '"focus":"café\\n日本語"' : '"intent":"general-assessment"');
    expect(text).not.toContain('"filePath":');
  } finally { await session.dispose(); }
});

it.each([false, true])("rejects direct workflow steering during a held provider run with current setup=%s", async (approved) => {
  if (approved) {
    const proposal = await buildProgrammaticProfileProposal(cwd);
    expect((await persistProgrammaticProfile(cwd, proposal.configurationFingerprint, proposal.profile)).ok).toBe(true);
  }
  const profile = path.join(cwd, ".gg/programmatic/profile.json");
  const before = await fs.readFile(profile).catch(() => null);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  vi.mocked(stream).mockImplementation(() => new StreamResult((async function* () {
    started();
    await held;
    yield { type: "text_delta", text: "Held response" };
    return { message: { role: "assistant", content: "Held response" }, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
  })()));
  const session = new AgentSession({ cwd, provider: "openai", model: "gpt-5", transient: true, systemPrompt: "Fixture", mcpEnabled: false });
  let running: Promise<void> | undefined;
  try {
    await session.initialize();
    running = session.prompt("held request");
    await ready;
    const signal = vi.mocked(stream).mock.calls[0]![0].signal!;
    for (const command of ["/setup-programmatic", "/programmatic focus", "/programmatic-run"]) {
      expect(() => session.queueMessage(command)).toThrow("Wait for the current work to finish");
      expect(session.getQueuedCount()).toBe(0);
    }
    expect(stream).toHaveBeenCalledOnce();
    expect(signal.aborted).toBe(false);
    expect(session.queueMessage("ordinary first")).toBe(1);
    expect(session.queueMessage("ordinary second")).toBe(2);
    release();
    await running;
    const userText = session.getMessages().filter((message) => message.role === "user").map((message) => JSON.stringify(message.content)).join("\n");
    expect(userText).toMatch(/ordinary first[\s\S]*ordinary second/);
    expect(userText.match(/ordinary first/g)).toHaveLength(1);
    expect(userText).not.toContain("/programmatic");
    expect(session.getQueuedCount()).toBe(0);
    expect(await fs.readFile(profile).catch(() => null)).toEqual(before);
    await expect(fs.stat(path.join(cwd, PROGRAMMATIC_STATE_PATH))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    release();
    await running?.catch(() => {});
    await session.dispose();
  }
});

it("keeps real scanner inputs and lifecycle bytes identical with and without focus", async () => {
  await fs.mkdir(path.join(cwd, "src-tauri"));
  await fs.writeFile(path.join(cwd, "package.json"), '{"name":"fixture"}');
  await fs.writeFile(path.join(cwd, "src-tauri/Cargo.toml"), '[package]\nname="fixture"\n');
  await fs.writeFile(path.join(cwd, "src-tauri/tauri.conf.json"), '{"identifier":"dev.fixture"}');
  const proposal = await buildProgrammaticProfileProposal(cwd);
  expect((await persistProgrammaticProfile(cwd, proposal.configurationFingerprint, proposal.profile)).ok).toBe(true);
  const profilePath = path.join(cwd, ".gg/programmatic/profile.json");
  const approvedBytes = await fs.readFile(profilePath);
  const states: Buffer[] = [];
  for (const focus of ["", "packaging risks"]) {
    let turn = 0;
    vi.mocked(stream).mockImplementation(() => new StreamResult((async function* () {
      turn++;
      if (turn <= 2) {
        const toolCall: ToolCall = turn === 1
          ? { type: "tool_call", id: "discover", name: "tool_search", args: { query: "programmatic_scan" } }
          : { type: "tool_call", id: "scan", name: "programmatic_scan", args: {} };
        yield { type: "toolcall_done", id: toolCall.id, name: toolCall.name, args: toolCall.args };
        return { message: { role: "assistant", content: [toolCall] },
          stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
      }
      return { message: { role: "assistant", content: "Bounded scan complete." },
        stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
    })()));
    const session = new AgentSession({ cwd, provider: "anthropic", model: "claude-sonnet-5", transient: true, systemPrompt: "Fixture", mcpEnabled: false });
    try {
      await session.initialize();
      await session.prompt(`/programmatic ${focus}`);
      expect(turn).toBe(3);
      const calls = session.getMessages().flatMap((message) => message.role === "assistant" && Array.isArray(message.content)
        ? message.content.filter((block) => block.type === "tool_call" && block.name === "programmatic_scan") : []);
      expect(calls).toEqual([expect.objectContaining({ name: "programmatic_scan", args: {} })]);
      const results = session.getMessages().flatMap((message) => message.role === "tool" ? message.content : []);
      const scanResult = results.find((result) => result.toolCallId === "scan");
      expect(scanResult).toBeDefined();
      expect(scanResult!.isError ?? false).toBe(false);
      expect(JSON.parse(String(scanResult!.content))).toMatchObject({ ok: true, state_path: PROGRAMMATIC_STATE_PATH });
      states.push(await fs.readFile(path.join(cwd, PROGRAMMATIC_STATE_PATH)));
      expect(await fs.readFile(profilePath)).toEqual(approvedBytes);
    } finally { await session.dispose(); }
  }
  expect(states[1]).toEqual(states[0]);
});