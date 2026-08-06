import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { MCPClientManager, MCPClientManagerOptions } from "./client.js";
import { AgentSession } from "../agent-session.js";
import { SharedMcpClientPool } from "./shared-client-pool.js";
import type { MCPServerConfig } from "./types.js";

vi.mock("./defaults.js", () => ({
  getAllMcpServers: async (): Promise<MCPServerConfig[]> => [
    {
      name: "kencode-search",
      command: process.execPath,
      args: ["fake-kencode-server.js"],
    },
  ],
}));
interface FakeManagerState {
  child?: ChildProcess;
  connectCount: number;
  disposeCount: number;
}

const pools: SharedMcpClientPool[] = [];
const sessions: AgentSession[] = [];

function createProcessBackedPool(state: FakeManagerState): SharedMcpClientPool {
  const pool = new SharedMcpClientPool((_options: MCPClientManagerOptions) => {
    const tool: AgentTool = {
      name: "mcp__kencode-search__echo",
      description: "Echo a routing marker",
      parameters: {} as AgentTool["parameters"],
      execute: async (args) => String((args as { marker: string }).marker),
    };
    const manager = {
      connectAll: async () => {
        state.connectCount += 1;
        state.child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          stdio: "ignore",
        });
        return [tool];
      },
      whenConnected: async () => ({ ok: true as const }),
      dispose: async () => {
        state.disposeCount += 1;
        const child = state.child;
        if (!child || child.exitCode !== null) return;
        const exited = once(child, "exit");
        child.kill();
        await exited;
      },
    };
    return manager as unknown as MCPClientManager;
  });
  pools.push(pool);
  return pool;
}

const config: MCPServerConfig = {
  name: "kencode-search",
  command: process.execPath,
  args: ["fake-kencode-server.js"],
};

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
  await Promise.all(pools.splice(0).map((pool) => pool.dispose()));
});

describe("SharedMcpClientPool", () => {
  it("shares one process across concurrent session leases and shuts it down exactly once", async () => {
    const state: FakeManagerState = { connectCount: 0, disposeCount: 0 };
    const pool = createProcessBackedPool(state);

    const build = pool.acquire(config, {});
    const mentor = pool.acquire(config, {});
    const autopilot = pool.acquire(config, {});
    const [buildTools, mentorTools, autopilotTools] = await Promise.all([
      build.tools,
      mentor.tools,
      autopilot.tools,
    ]);

    expect(state.connectCount).toBe(1);
    expect(state.child?.exitCode).toBeNull();
    await expect(
      Promise.all([
        buildTools[0]!.execute({ marker: "build" }, {} as never),
        mentorTools[0]!.execute({ marker: "mentor" }, {} as never),
        autopilotTools[0]!.execute({ marker: "autopilot" }, {} as never),
      ]),
    ).resolves.toEqual(["build", "mentor", "autopilot"]);

    await Promise.all([build.release(), mentor.release()]);
    expect(state.disposeCount).toBe(0);
    expect(state.child?.exitCode).toBeNull();

    await autopilot.release();
    expect(state.disposeCount).toBe(1);
    expect(state.child?.killed).toBe(true);

    await autopilot.release();
    await pool.dispose();
    expect(state.disposeCount).toBe(1);
  });

  it("shares one MCP config lease across base, Ken, and autopilot while conversation state stays local", async () => {
    const state: FakeManagerState = { connectCount: 0, disposeCount: 0 };
    const pool = createProcessBackedPool(state);
    const createSession = (systemPrompt: string) => {
      const session = new AgentSession({
        provider: "openai",
        model: "gpt-5.5-codex",
        cwd: process.cwd(),
        systemPrompt,
        transient: true,
        allowedTools: ["read"],
        allowedMcpServers: ["kencode-search"],
        sharedMcpPool: pool,
        projectCustomization: false,
        globalSubagents: false,
        loadExtensions: false,
        coderSlashCommands: false,
        selfCorrectionHooks: false,
        orchestrationPrompt: false,
      });
      sessions.push(session);
      return session;
    };
    const base = createSession("base conversation");
    const ken = createSession("Ken conversation");
    const autopilot = createSession("autopilot conversation");

    await Promise.all([base.initialize(), ken.initialize(), autopilot.initialize()]);

    // One manager connection means all three sessions acquired the same
    // config-keyed pool entry instead of spawning one process per conversation.
    expect(state.connectCount).toBe(1);
    expect(state.child?.exitCode).toBeNull();
    const toolNames = (session: AgentSession) =>
      (session as unknown as { tools: AgentTool[] }).tools.map((tool) => tool.name);
    expect(toolNames(base)).toContain("mcp__kencode-search__echo");
    expect(toolNames(ken)).toContain("mcp__kencode-search__echo");
    expect(toolNames(autopilot)).toContain("mcp__kencode-search__echo");

    const baseMessages = base.getMessages();
    const kenMessages = ken.getMessages();
    const autopilotMessages = autopilot.getMessages();
    expect(baseMessages).not.toBe(kenMessages);
    expect(kenMessages).not.toBe(autopilotMessages);
    baseMessages.push({ role: "user", content: "base-only marker" });
    kenMessages.push({ role: "user", content: "Ken-only marker" });
    autopilotMessages.push({ role: "user", content: "autopilot-only marker" });
    expect(baseMessages.map((message) => message.content)).toContain("base-only marker");
    expect(baseMessages.map((message) => message.content)).not.toContain("Ken-only marker");
    expect(kenMessages.map((message) => message.content)).toContain("Ken-only marker");
    expect(kenMessages.map((message) => message.content)).not.toContain("autopilot-only marker");
    expect(autopilotMessages.map((message) => message.content)).toContain("autopilot-only marker");
    expect(autopilotMessages.map((message) => message.content)).not.toContain("base-only marker");

    await base.dispose();
    expect(state.disposeCount).toBe(0);
    expect(state.child?.exitCode).toBeNull();
    await ken.dispose();
    expect(state.disposeCount).toBe(0);
    expect(state.child?.exitCode).toBeNull();
    await autopilot.dispose();
    expect(state.disposeCount).toBe(1);
    expect(state.child?.killed).toBe(true);
  }, 60_000);

  it("routes three concurrent deferred activations through one shared process", async () => {
    const state: FakeManagerState = { connectCount: 0, disposeCount: 0 };
    const pool = createProcessBackedPool(state);
    const activations: Promise<unknown>[] = [];
    const createDeferredSession = () => {
      const session = new AgentSession({
        provider: "openai",
        model: "gpt-5.5-codex",
        cwd: process.cwd(),
        systemPrompt: "deferred shared MCP lifecycle test",
        transient: true,
        backgroundMcpConnect: true,
        sharedMcpPool: pool,
        projectCustomization: false,
        globalSubagents: false,
        loadExtensions: false,
        coderSlashCommands: false,
        selfCorrectionHooks: false,
        orchestrationPrompt: false,
      });
      sessions.push(session);

      const internals = session as unknown as {
        tools: AgentTool[];
        mcpManager?: MCPClientManager;
        cachedMcpToolServers: Map<string, string>;
        addCachedMcpTools(tools: AgentTool[]): void;
        seedMcpCatalogFromCache(servers: MCPServerConfig[]): Promise<void>;
      };
      internals.seedMcpCatalogFromCache = async () => {
        // Make a wrong session-local route fail immediately instead of waiting
        // for MCPClientManager.whenConnected's production timeout.
        if (internals.mcpManager) {
          internals.mcpManager.whenConnected = async () => ({
            ok: false,
            error: "routed through the session-local manager",
          });
        }
        internals.cachedMcpToolServers.set("mcp__kencode-search__echo", "kencode-search");
        internals.addCachedMcpTools([
          {
            name: "mcp__kencode-search__echo",
            description: "Echo a routing marker",
            parameters: {} as AgentTool["parameters"],
            execute: async () => "cached stub",
          },
        ]);
        const toolSearch = internals.tools.find((tool) => tool.name === "tool_search");
        expect(toolSearch).toBeDefined();
        activations.push(
          Promise.resolve(toolSearch!.execute({ query: "echo routing marker" }, {} as never)),
        );
      };
      return session;
    };

    const deferredSessions = [
      createDeferredSession(),
      createDeferredSession(),
      createDeferredSession(),
    ];
    await Promise.all(deferredSessions.map((session) => session.initialize()));
    await vi.waitFor(() => expect(activations).toHaveLength(3));

    const results = await Promise.all(activations);
    expect(results).toEqual([
      expect.stringContaining("1 tool(s) now available"),
      expect.stringContaining("1 tool(s) now available"),
      expect.stringContaining("1 tool(s) now available"),
    ]);
    expect(state.connectCount).toBe(1);
    expect(state.child?.exitCode).toBeNull();
  }, 60_000);
});
