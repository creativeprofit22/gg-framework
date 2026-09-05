import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import type * as GgAgentModule from "@kenkaiiii/gg-agent";
import type * as CompactorModule from "./compaction/compactor.js";
import { useFakeHome } from "../test-support/fake-home.js";

const agentLoopMock = vi.hoisted(() => vi.fn());
const compactMock = vi.hoisted(() => vi.fn());

const sourceModelRegistry = new URL("../../../gg-core/src/model-registry.ts", import.meta.url).href;
vi.doMock("./model-registry.js", async () => {
  const [local, source] = await Promise.all([
    vi.importActual<typeof import("./model-registry.js")>("./model-registry.js"),
    import(sourceModelRegistry),
  ]);
  return { ...local, ...source };
});

vi.mock("@kenkaiiii/gg-agent", async () => {
  const actual = await vi.importActual<typeof GgAgentModule>("@kenkaiiii/gg-agent");
  return { ...actual, agentLoop: agentLoopMock };
});

vi.mock("./compaction/compactor.js", async () => {
  const actual = await vi.importActual<typeof CompactorModule>("./compaction/compactor.js");
  return { ...actual, compact: compactMock };
});

let restoreHome: (() => void) | undefined;
let tmpHome: string;
let tmpProject: string;

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value), "utf-8");
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "agent-context-profile-home-"));
  tmpProject = await fs.mkdtemp(path.join(os.tmpdir(), "agent-context-profile-project-"));
  restoreHome = useFakeHome(tmpHome);
  await writeJson(path.join(tmpHome, ".gg", "auth.json"), {
    openai: {
      accessToken: ["test", "token"].join("-"),
      refreshToken: ["test", "refresh"].join("-"),
      expiresAt: Date.now() + 3_600_000,
      accountId: "chatgpt-account",
    },
  });
  await writeJson(path.join(tmpHome, ".gg", "settings.json"), {
    autoCompact: false,
  });
  agentLoopMock.mockReset();
  compactMock.mockReset();
  agentLoopMock.mockImplementation(async function* (messages: Message[]) {
    messages.push({ role: "assistant", content: "done" });
    yield { type: "agent_done" };
  });
});

afterEach(async () => {
  restoreHome?.();
  await fs.rm(tmpHome, { recursive: true, force: true });
  await fs.rm(tmpProject, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("AgentSession OpenAI Codex context profiles", () => {
  it("guards lowering and preserves the selected profile through compaction and resume", async () => {
    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "openai",
      model: "gpt-6-astra",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
      mcpEnabled: false,
      projectCustomization: false,
      selfCorrectionHooks: false,
    });
    await session.initialize();

    expect(session.getState().openAICodexContextProfile).toBe("stable");
    await session.prompt("small stable turn");
    expect(agentLoopMock.mock.calls[0]?.[1]).toMatchObject({ maxTokens: 128_000 });
    expect(session.getContextUsage()).toMatchObject({
      size: 272_000,
      openAICodexContextProfile: "stable",
    });

    await session.switchOpenAICodexContextProfile("experimental");
    expect(session.getContextUsage()).toMatchObject({
      size: 872_000,
      openAICodexContextProfile: "experimental",
    });
    await session.switchOpenAICodexContextProfile("stable");
    expect(session.getState().openAICodexContextProfile).toBe("stable");
    await session.switchOpenAICodexContextProfile("experimental");
    await session.switchOpenAICodexFast(true);

    await session.prompt("x".repeat(1_100_000));
    expect(agentLoopMock.mock.calls[1]?.[1]).toMatchObject({ maxTokens: 128_000 });
    expect(session.getContextUsage().used).toBeGreaterThan(272_000);
    await expect(session.switchOpenAICodexContextProfile("stable")).rejects.toThrow(
      /Compact or start a new session/,
    );
    expect(session.getState().openAICodexContextProfile).toBe("experimental");

    compactMock.mockResolvedValue({
      messages: [
        { role: "system", content: "test system prompt" },
        { role: "user", content: "compacted summary" },
      ],
      result: {
        compacted: true,
        originalCount: 5,
        newCount: 2,
        tokensBeforeEstimate: 300_000,
        tokensAfterEstimate: 10,
      },
    });
    await session.compact();
    const checkpointPath = session.getState().sessionPath;
    const checkpointHeader = JSON.parse(
      (await fs.readFile(checkpointPath, "utf-8")).split("\n")[0]!,
    );
    expect(checkpointHeader.openAICodexContextProfile).toBe("experimental");
    expect(checkpointHeader.openAICodexFast).toBe(true);
    const { getAgentSessionContextWindow } = await import("../app-sidecar-context.js");
    expect(getAgentSessionContextWindow(session.getState())).toBe(872_000);
    await session.dispose();

    const resumed = new AgentSession({
      provider: "openai",
      model: "gpt-6-astra",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
      sessionId: checkpointPath,
      mcpEnabled: false,
      projectCustomization: false,
      selfCorrectionHooks: false,
    });
    await resumed.initialize();
    expect(resumed.getContextUsage()).toMatchObject({
      size: 872_000,
      openAICodexContextProfile: "experimental",
    });
    expect(resumed.getState().openAICodexFast).toBe(true);
    expect(getAgentSessionContextWindow(resumed.getState())).toBe(872_000);

    await resumed.switchOpenAICodexContextProfile("stable");
    expect(resumed.getContextUsage()).toMatchObject({
      size: 272_000,
      openAICodexContextProfile: "stable",
    });
    await resumed.dispose();
  });

  it("hydrates OAuth identity and applies Fast only to Astra OAuth", async () => {
    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "openai",
      model: "gpt-6-astra",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
      mcpEnabled: false,
      projectCustomization: false,
      selfCorrectionHooks: false,
    });
    await session.initialize();

    expect(session.getState()).toMatchObject({
      accountId: "chatgpt-account",
      openAICodexFast: false,
    });
    await session.switchOpenAICodexFast(true);
    await session.prompt("fast turn");
    expect(agentLoopMock.mock.calls[0]?.[1]).toMatchObject({ serviceTier: "fast" });

    await session.switchModel("openai", "gpt-5.6-sol");
    expect(session.getState().openAICodexFast).toBe(true);
    await session.prompt("unsupported turn");
    expect(agentLoopMock.mock.calls[1]?.[1]?.serviceTier).toBeUndefined();

    await session.switchModel("openai", "gpt-6-astra");
    await session.prompt("fast again");
    expect(agentLoopMock.mock.calls[2]?.[1]).toMatchObject({ serviceTier: "fast" });
    await session.dispose();
  });

  it("refreshes shared OpenAI identity without refreshing an expired token", async () => {
    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "openai",
      model: "gpt-6-astra",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
      mcpEnabled: false,
      projectCustomization: false,
      selfCorrectionHooks: false,
    });
    await session.initialize();
    expect(session.getState().accountId).toBe("chatgpt-account");

    const authPath = path.join(tmpHome, ".gg", "auth.json");
    const storedAuth = JSON.parse(await fs.readFile(authPath, "utf-8")) as {
      openai: { expiresAt: number; accountId: string };
    };
    await writeJson(authPath, {});
    await session.refreshStoredAuthState();
    expect(session.getState().accountId).toBeUndefined();

    storedAuth.openai.expiresAt = 0;
    storedAuth.openai.accountId = "new-account";
    await writeJson(authPath, storedAuth);
    await session.refreshStoredAuthState();
    expect(session.getState().accountId).toBe("new-account");
    await session.dispose();
  });

  it("clears live OAuth identity when shared credentials switch to an API key", async () => {
    const authPath = path.join(tmpHome, ".gg", "auth.json");
    agentLoopMock.mockImplementationOnce(async function* (
      messages: Message[],
      options: GgAgentModule.AgentOptions,
    ) {
      expect(options).toMatchObject({
        serviceTier: "fast",
        serviceTierRequiresAccountId: true,
      });
      const resolveCredentials = options.resolveCredentials;
      if (!resolveCredentials) throw new Error("missing credential resolver");
      await expect(resolveCredentials()).resolves.toMatchObject({
        accountId: "chatgpt-account",
      });

      await writeJson(authPath, {
        openai: {
          accessToken: ["test", "api", "key"].join("-"),
          refreshToken: "",
          expiresAt: Date.now() + 3_600_000,
        },
      });
      const live = await resolveCredentials();
      expect(Object.prototype.hasOwnProperty.call(live, "accountId")).toBe(true);
      expect(live.accountId).toBeUndefined();

      messages.push({ role: "assistant", content: "done" });
      yield { type: "agent_done" };
    });

    const { AgentSession } = await import("./agent-session.js");
    const session = new AgentSession({
      provider: "openai",
      model: "gpt-6-astra",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
      mcpEnabled: false,
      projectCustomization: false,
      selfCorrectionHooks: false,
    });
    await session.initialize();
    await session.switchOpenAICodexFast(true);
    await session.prompt("credential transition");

    expect(session.getState().accountId).toBeUndefined();
    await session.dispose();
  });

  it("omits Fast for a restored API-key session", async () => {
    const [{ AgentSession }, { SessionManager }] = await Promise.all([
      import("./agent-session.js"),
      import("./session-manager.js"),
    ]);
    await writeJson(path.join(tmpHome, ".gg", "auth.json"), {
      openai: {
        accessToken: ["test", "api", "key"].join("-"),
        refreshToken: "",
        expiresAt: Date.now() + 3_600_000,
      },
    });
    const manager = new SessionManager(path.join(tmpHome, ".gg", "sessions"));
    const stored = await manager.create(tmpProject, "openai", "gpt-6-astra", {
      openAICodexFast: true,
    });
    const session = new AgentSession({
      provider: "openai",
      model: "gpt-6-astra",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
      sessionId: stored.path,
      mcpEnabled: false,
      projectCustomization: false,
      selfCorrectionHooks: false,
    });
    await session.initialize();

    expect(session.getState()).toMatchObject({ accountId: undefined, openAICodexFast: true });
    await session.prompt("api-key turn");
    expect(agentLoopMock.mock.calls[0]?.[1]?.serviceTier).toBeUndefined();
    await session.dispose();
  });

  it("defaults legacy headers without a profile to stable and Fast off", async () => {
    const [{ AgentSession }, { SessionManager }] = await Promise.all([
      import("./agent-session.js"),
      import("./session-manager.js"),
    ]);
    const manager = new SessionManager(path.join(tmpHome, ".gg", "sessions"));
    const legacy = await manager.create(tmpProject, "openai", "gpt-6-astra");
    await manager.appendEntry(legacy.path, {
      type: "message",
      id: "legacy-message",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "legacy session" },
    });

    const resumed = new AgentSession({
      provider: "openai",
      model: "gpt-6-astra",
      cwd: tmpProject,
      systemPrompt: "test system prompt",
      sessionId: legacy.path,
      mcpEnabled: false,
      projectCustomization: false,
      selfCorrectionHooks: false,
    });
    await resumed.initialize();

    expect(resumed.getContextUsage()).toMatchObject({
      size: 272_000,
      openAICodexContextProfile: "stable",
    });
    expect(resumed.getState().openAICodexFast).toBe(false);
    const { getAgentSessionContextWindow } = await import("../app-sidecar-context.js");
    expect(getAgentSessionContextWindow(resumed.getState())).toBe(272_000);
    await resumed.dispose();
  });
});
