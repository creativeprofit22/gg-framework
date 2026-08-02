import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { MCPClientManager, MCPClientManagerOptions } from "./client.js";
import { AgentSession } from "../agent-session.js";
import { SharedMcpClientPool } from "./shared-client-pool.js";
import type { MCPServerConfig } from "./types.js";

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

  it("backs multiple AgentSessions with one shared process while keeping their tool sets local", async () => {
    const state: FakeManagerState = { connectCount: 0, disposeCount: 0 };
    const pool = createProcessBackedPool(state);
    const createSession = () => {
      const session = new AgentSession({
        provider: "openai",
        model: "gpt-5.5-codex",
        cwd: process.cwd(),
        systemPrompt: "shared MCP lifecycle test",
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
    const build = createSession();
    const mentor = createSession();
    const autopilot = createSession();
    const blocked = new AgentSession({
      provider: "openai",
      model: "gpt-5.5-codex",
      cwd: process.cwd(),
      systemPrompt: "shared MCP policy test",
      transient: true,
      allowedTools: ["read"],
      sharedMcpPool: pool,
      projectCustomization: false,
      globalSubagents: false,
      loadExtensions: false,
      coderSlashCommands: false,
      selfCorrectionHooks: false,
      orchestrationPrompt: false,
    });
    sessions.push(blocked);

    await Promise.all([
      build.initialize(),
      mentor.initialize(),
      autopilot.initialize(),
      blocked.initialize(),
    ]);
    expect(state.connectCount).toBe(1);
    const toolNames = (session: AgentSession) =>
      (session as unknown as { tools: AgentTool[] }).tools.map((tool) => tool.name);
    expect(toolNames(build)).toContain("mcp__kencode-search__echo");
    expect(toolNames(mentor)).toContain("mcp__kencode-search__echo");
    expect(toolNames(autopilot)).toContain("mcp__kencode-search__echo");
    expect(toolNames(blocked)).not.toContain("mcp__kencode-search__echo");

    await build.dispose();
    await mentor.dispose();
    expect(state.disposeCount).toBe(0);
    await autopilot.dispose();
    expect(state.disposeCount).toBe(1);
  }, 60_000);
});
