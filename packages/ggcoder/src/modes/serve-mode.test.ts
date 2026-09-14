import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stream, StreamResult } from "@kenkaiiii/gg-ai";
import { AgentSession } from "../core/agent-session.js";
import type * as AgentSessionModule from "../core/agent-session.js";
import { AuthStorage } from "../core/auth-storage.js";
import { TelegramBot, type TelegramMessage } from "../core/telegram.js";
import { useFakeHome } from "../test-support/fake-home.js";
import { buildProgrammaticProfileProposal, persistProgrammaticProfile } from "../core/programmatic/profile.js";
import { startServeMode, type ServeController } from "./serve-mode.js";

// Keep the actual serve handler, command resolution and agent loop. Only replace
// transport/provider I/O and configure sessions for an isolated local fixture.
vi.mock("@kenkaiiii/gg-ai", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()), stream: vi.fn(),
}));
vi.mock("../core/agent-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof AgentSessionModule>();
  return { ...actual, AgentSession: class extends actual.AgentSession {
    constructor(options: ConstructorParameters<typeof actual.AgentSession>[0]) {
      super({ ...options, transient: true, systemPrompt: "Fixture", mcpEnabled: false });
    }
  } };
});
vi.mock("../core/telegram-config.js", () => ({ verifyBotToken: async () => ({ ok: true }) }));
vi.mock("../core/logger.js", () => ({ log: vi.fn(), closeLogger: vi.fn() }));

let cwd: string;
let restore: () => void;
let controller: ServeController;
let onText: (message: TelegramMessage) => void | Promise<void>;
const deliver = (text: string) => onText({ text, chatId: -123, chatType: "group", chatTitle: "Fixture" });

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "serve-commands-"));
  restore = useFakeHome(path.join(cwd, "home"));
  vi.spyOn(AuthStorage.prototype, "resolveCredentials").mockResolvedValue({ accessToken: "fixture", refreshToken: "", expiresAt: Number.MAX_SAFE_INTEGER });
  vi.spyOn(TelegramBot.prototype, "onText").mockImplementation((handler) => { onText = handler; });
  vi.spyOn(TelegramBot.prototype, "start").mockResolvedValue();
  vi.spyOn(TelegramBot.prototype, "stop").mockImplementation(() => {});
  vi.spyOn(TelegramBot.prototype, "send").mockResolvedValue();
  vi.spyOn(TelegramBot.prototype, "sendTyping").mockResolvedValue();
  vi.spyOn(AgentSession.prototype, "prompt");
  vi.mocked(stream).mockClear();
  vi.mocked(stream).mockImplementation(() => new StreamResult((async function* () {
    yield { type: "text_delta", text: "Scripted response." };
    return { message: { role: "assistant", content: "Scripted response." }, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
  })()));
  controller = await startServeMode({ cwd, provider: "anthropic", model: "claude-sonnet-5", version: "fixture", embedded: true,
    telegram: { botToken: "fixture", userId: 42 } });
});
afterEach(async () => {
  await controller?.stop();
  restore();
  vi.restoreAllMocks();
  await fs.rm(cwd, { recursive: true, force: true });
});

it("keeps mentioned help local and forwards setup to its real template", async () => {
  await deliver("/help@mybot");
  expect(AgentSession.prototype.prompt).not.toHaveBeenCalled();
  expect(stream).not.toHaveBeenCalled();
  expect(TelegramBot.prototype.send).toHaveBeenCalledWith(-123, expect.stringContaining("/setup-programmatic"));
  await deliver("/setup-programmatic@mybot");
  expect(AgentSession.prototype.prompt).toHaveBeenCalledExactlyOnceWith("/setup-programmatic");
  expect(stream).toHaveBeenCalledOnce();
  const request = vi.mocked(stream).mock.calls[0]![0];
  expect(request.messages.find((message) => message.role === "user")?.content).toContain("programmatic_profile");
  await expect(fs.stat(path.join(cwd, ".gg/programmatic/profile.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("returns setup guidance without a model run for mentioned assessment before approval", async () => {
  await deliver("/programmatic@mybot café\n日本語");
  expect(AgentSession.prototype.prompt).toHaveBeenCalledExactlyOnceWith("/programmatic café\n日本語");
  expect(stream).not.toHaveBeenCalled();
  expect(TelegramBot.prototype.send).toHaveBeenCalledWith(-123, expect.stringContaining("/setup-programmatic"));
});

it.each([" café\n日本語", "  café\t  details\n\n日本語  "])("preserves the exact suffix %j and approved advisory context", async (suffix) => {
  const proposal = await buildProgrammaticProfileProposal(cwd);
  expect((await persistProgrammaticProfile(cwd, proposal.configurationFingerprint, proposal.profile)).ok).toBe(true);
  await deliver(`/programmatic@mybot${suffix}`);
  expect(AgentSession.prototype.prompt).toHaveBeenCalledExactlyOnceWith(`/programmatic${suffix}`);
  expect(stream).toHaveBeenCalledOnce();
  const request = vi.mocked(stream).mock.calls[0]![0];
  const content = request.messages.find((message) => message.role === "user")?.content;
  expect(content).toContain(`## User Instructions\n\n${suffix.trim()}`);
  expect(content).toContain("Untrusted advisory context");
  expect(content).toContain(`"focus":${JSON.stringify(suffix.trim())}`);
  expect(content).toContain("empty argument object");
});

it("preserves custom command case and strips only the token's bot mention", async () => {
  await fs.mkdir(path.join(cwd, ".gg/commands"), { recursive: true });
  await fs.writeFile(path.join(cwd, ".gg/commands/MyCommand.md"), "Custom fixture body");
  await deliver("/MyCommand@mybot  café@other\n日本語");
  expect(AgentSession.prototype.prompt).toHaveBeenCalledExactlyOnceWith("/MyCommand  café@other\n日本語");
  expect(stream).toHaveBeenCalledOnce();
  expect(vi.mocked(stream).mock.calls[0]![0].messages.find((message) => message.role === "user")?.content)
    .toBe("Custom fixture body\n\n## User Instructions\n\ncafé@other\n日本語");
});

it("rejects mentioned generic commands while busy without forwarding or cancelling", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  vi.mocked(stream).mockImplementation(() => new StreamResult((async function* () {
    started();
    await held;
    yield { type: "text_delta", text: "Done" };
    return { message: { role: "assistant", content: "Done" }, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
  })()));
  const running = deliver("ordinary request");
  try {
    await ready;
    for (const command of ["/setup-programmatic@mybot", "/programmatic@mybot café\n日本語"]) {
      await deliver(command);
      expect(TelegramBot.prototype.send).toHaveBeenLastCalledWith(-123, expect.stringContaining("still processing"));
    }
    expect(AgentSession.prototype.prompt).toHaveBeenCalledExactlyOnceWith("ordinary request");
    expect(stream).toHaveBeenCalledOnce();
    expect(vi.mocked(stream).mock.calls[0]![0].signal?.aborted).toBe(false);
  } finally {
    release();
    await running;
  }
});
