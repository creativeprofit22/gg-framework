import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream, StreamResult, type Provider } from "@kenkaiiii/gg-ai";
import type { AgentSession, AgentSessionOptions } from "../core/agent-session.js";
import { AuthStorage } from "../core/auth-storage.js";
import { QWEN_UNATTENDED_ERROR, isUnattendedExecution } from "../core/provider-execution-policy.js";
import { useFakeHome } from "../test-support/fake-home.js";
import { runRpcMode } from "./rpc-mode.js";

const captured = vi.hoisted(() => ({ options: [] as AgentSessionOptions[] }));

vi.mock("../core/claude-code-version.js", () => ({
  getClaudeCliUserAgent: async () => "rpc-test-fixture",
}));

vi.mock("@kenkaiiii/gg-ai", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  stream: vi.fn(),
}));

// Keep initialize, prompt, compact, switchModel and disposal real. Only disable
// unrelated external services and persistence; never inject execution intent.
vi.mock("../core/agent-session.js", async (original) => {
  const actual = await original<{ AgentSession: typeof AgentSession }>();
  return {
    ...actual,
    AgentSession: class extends actual.AgentSession {
      constructor(options: AgentSessionOptions) {
        captured.options.push({ ...options });
        super({ ...options, transient: true, mcpEnabled: false, allowedTools: ["read"] });
      }
    },
  };
});

const createInterface = readline.createInterface;
let cwd: string;
let restoreHome: () => void;
let frames: Record<string, unknown>[];

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "rpc-execution-"));
  restoreHome = useFakeHome(path.join(cwd, "home"));
  vi.stubEnv("GG_AGENT_UNATTENDED", undefined);
  vi.stubEnv("GG_SUBAGENT_DEPTH", undefined);
  vi.stubEnv("GG_APP_DEV_AUTH_FILE", undefined);
  vi.stubEnv("GG_APP_NATIVE_DEBUG_AUTH_ALLOWED", undefined);
  vi.stubEnv("QWEN_CLOUD_TOKEN_PLAN_KEY", "sk-sp-rpc-fixture-not-a-real-key");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected network request");
    }),
  );
  vi.spyOn(AuthStorage.prototype, "resolveCredentials").mockResolvedValue({
    accessToken: "rpc-fixture-not-a-real-key",
    refreshToken: "",
    expiresAt: Number.MAX_SAFE_INTEGER,
  });
  vi.mocked(stream).mockReset();
  vi.mocked(stream).mockImplementation(
    () =>
      new StreamResult(
        (async function* () {
          yield { type: "text_delta", text: "Done." };
          return {
            message: { role: "assistant", content: "Done." },
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        })(),
      ),
  );
  captured.options.length = 0;
  frames = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    frames.push(JSON.parse(String(chunk)) as Record<string, unknown>);
    return true;
  });
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`Unexpected RPC exit: ${code}`);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  restoreHome();
  await fs.rm(cwd, { recursive: true, force: true });
});

async function run(provider: Provider, commands: Record<string, unknown>[]) {
  // Supply lines at the stdio boundary, exercising runRpcMode's parser and
  // dispatcher rather than calling AgentSession methods directly.
  vi.spyOn(readline, "createInterface").mockImplementation(() =>
    createInterface({
      input: Readable.from(commands.map((command) => `${JSON.stringify(command)}\n`)),
      terminal: false,
    }),
  );
  await runRpcMode({
    cwd,
    provider,
    model: provider === "qwen-cloud" ? "qwen-cloud/qwen3.8-max" : "claude-sonnet-4-6",
    systemPrompt: "Fixture: respond briefly without tools.",
    maxTurns: 1,
  });
  expect(frames.some((frame) => frame.type === "ready")).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
}

const prompt = { id: "prompt", command: "prompt", text: "Explain the code." };
const compact = { id: "compact", command: "compact" };
const switchToQwen = {
  id: "switch",
  command: "switch_model",
  provider: "qwen-cloud",
  model: "qwen-cloud/qwen3.8-max",
};

describe("RPC execution intent at the real session boundary", () => {
  it.each([
    { name: "prompt", provider: "qwen-cloud", commands: [prompt], id: "prompt" },
    { name: "compact", provider: "qwen-cloud", commands: [compact], id: "compact" },
    {
      name: "switch then prompt",
      provider: "anthropic",
      commands: [switchToQwen, prompt],
      id: "prompt",
    },
    {
      name: "switch then compact",
      provider: "anthropic",
      commands: [switchToQwen, compact],
      id: "compact",
    },
  ] as const)(
    "rejects marked $name before credentials or inference",
    async ({ provider, commands, id }) => {
      vi.stubEnv("GG_AGENT_UNATTENDED", "1");
      // Explicit intent wins even when launched through a trusted worker.
      vi.stubEnv("GG_SUBAGENT_DEPTH", "1");
      await run(provider, [...commands]);
      expect(frames).toContainEqual({
        id,
        type: "error",
        message: `Error: ${QWEN_UNATTENDED_ERROR}`,
      });
      expect(captured.options[0]?.unattended).toBe(true);
      expect(AuthStorage.prototype.resolveCredentials).not.toHaveBeenCalled();
      expect(stream).not.toHaveBeenCalled();
      if (provider === "anthropic") {
        expect(frames).toContainEqual(expect.objectContaining({ id: "switch", type: "result" }));
      }
      expect(isUnattendedExecution()).toBe(false);
    },
  );

  it.each([undefined, "1"])("allows user-driven Qwen RPC with worker depth %s", async (depth) => {
    vi.stubEnv("GG_SUBAGENT_DEPTH", depth);
    await run("qwen-cloud", [prompt, compact]);
    expect(captured.options[0]?.unattended).toBe(false);
    expect(frames).toContainEqual({ id: "prompt", type: "result", data: { status: "done" } });
    expect(frames).toContainEqual({ id: "compact", type: "result", data: { status: "compacted" } });
    expect(AuthStorage.prototype.resolveCredentials).toHaveBeenCalled();
    expect(stream).toHaveBeenCalled();
    expect(
      vi.mocked(stream).mock.calls.every(([request]) => request.provider === "qwen-cloud"),
    ).toBe(true);
  });

  it("allows another provider under the unattended marker", async () => {
    vi.stubEnv("GG_AGENT_UNATTENDED", "1");
    await run("anthropic", [prompt, compact]);
    expect(captured.options[0]?.unattended).toBe(true);
    expect(frames).toContainEqual({ id: "prompt", type: "result", data: { status: "done" } });
    expect(frames).toContainEqual({ id: "compact", type: "result", data: { status: "compacted" } });
    expect(stream).toHaveBeenCalled();
  });

  it("does not leak a marked RPC session's intent into a later user-driven session", async () => {
    vi.stubEnv("GG_AGENT_UNATTENDED", "1");
    await run("qwen-cloud", [prompt]);
    expect(frames).toContainEqual({
      id: "prompt",
      type: "error",
      message: `Error: ${QWEN_UNATTENDED_ERROR}`,
    });
    expect(AuthStorage.prototype.resolveCredentials).not.toHaveBeenCalled();
    vi.stubEnv("GG_AGENT_UNATTENDED", undefined);
    frames = [];
    await run("qwen-cloud", [prompt]);
    expect(captured.options.map((options) => options.unattended)).toEqual([true, false]);
    expect(frames).toContainEqual({ id: "prompt", type: "result", data: { status: "done" } });
    expect(stream).toHaveBeenCalled();
    expect(isUnattendedExecution()).toBe(false);
  });
});
