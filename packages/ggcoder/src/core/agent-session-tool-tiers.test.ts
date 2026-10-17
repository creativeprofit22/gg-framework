import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentTool, ToolContext } from "@kenkaiiii/gg-agent";
import type * as GgAgentModule from "@kenkaiiii/gg-agent";
import type * as McpModule from "./mcp/index.js";
import { useFakeHome } from "../test-support/fake-home.js";
import { DEFERRED_TOOL_NAMES } from "../tools/tool-tiers.js";
import { AgentSession } from "./agent-session.js";
import {
  buildProgrammaticProfileProposal,
  persistProgrammaticProfile,
} from "./programmatic/profile.js";

vi.mock("@kenkaiiii/gg-agent", async () => {
  const actual = await vi.importActual<typeof GgAgentModule>("@kenkaiiii/gg-agent");
  return { ...actual, agentLoop: vi.fn(() => (async function* emptyLoop() {})()) };
});

vi.mock("./mcp/index.js", async () => {
  const actual = await vi.importActual<typeof McpModule>("./mcp/index.js");
  return {
    ...actual,
    MCPClientManager: vi.fn(function MCPClientManagerMock() {
      return { connectAll: vi.fn(async () => []), dispose: vi.fn(async () => {}) };
    }),
  };
});

let restoreHome: (() => void) | undefined;
let tempHome: string;
let tempProject: string;

beforeEach(async () => {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "tiers-home-"));
  tempProject = await fs.mkdtemp(path.join(os.tmpdir(), "tiers-project-"));
  restoreHome = useFakeHome(tempHome);
  await fs.mkdir(path.join(tempHome, ".gg"), { recursive: true });
  await fs.writeFile(
    path.join(tempHome, ".gg", "auth.json"),
    JSON.stringify({
      anthropic: {
        accessToken: "test-token",
        refreshToken: "test-refresh",
        expiresAt: Date.now() + 3_600_000,
      },
    }),
  );
});

afterEach(async () => {
  restoreHome?.();
  await Promise.all([
    fs.rm(tempHome, { recursive: true, force: true }),
    fs.rm(tempProject, { recursive: true, force: true }),
  ]);
  vi.clearAllMocks();
});

async function writeSettings(settings: Record<string, unknown>): Promise<void> {
  await fs.writeFile(
    path.join(tempHome, ".gg", "settings.json"),
    JSON.stringify(settings),
    "utf-8",
  );
}

async function createUninitializedSession(extra: Record<string, unknown> = {}) {
  return new AgentSession({
    provider: "anthropic",
    model: "claude-test",
    cwd: tempProject,
    transient: true,
    projectCustomization: false,
    loadExtensions: false,
    orchestrationPrompt: false,
    selfCorrectionHooks: false,
    ...extra,
  });
}

async function createSession(extra: Record<string, unknown> = {}) {
  const session = await createUninitializedSession(extra);
  await session.initialize();
  return session;
}

it("blocks a fresh project's direct assessment before entering the model loop", async () => {
  const session = await createUninitializedSession();
  try {
    expect(await session.willStartAgentRun("/programmatic")).toBe(false);
    expect(await session.willExpandPromptTemplate("/programmatic")).toBe(false);
    expect(await fs.readdir(tempProject)).toEqual([]);
  } finally {
    await session.dispose();
  }
});

it("passes validated focus and bounded metadata to the agent request without writing setup", async () => {
  const proposal = await buildProgrammaticProfileProposal(tempProject);
  expect(
    (
      await persistProgrammaticProfile(
        tempProject,
        proposal.configurationFingerprint,
        proposal.profile,
      )
    ).ok,
  ).toBe(true);
  const profilePath = path.join(tempProject, ".gg/programmatic/profile.json");
  const before = await fs.readFile(profilePath);
  const session = await createSession();
  try {
    expect(await session.willStartAgentRun(`/programmatic ${"x".repeat(4001)}`)).toBe(false);
    await session.prompt("/programmatic   café\n日本語  ");
    const prompt = String(
      session.getMessages().find((message) => message.role === "user")?.content,
    );
    expect(prompt).toContain("## User Instructions\n\ncafé\n日本語");
    const context = JSON.parse(prompt.slice(prompt.indexOf('{"assessment":')));
    expect(context.assessment).toEqual({ version: 1, focus: "café\n日本語" });
    expect(context.commands.entries.length).toBeGreaterThan(0);
    expect(
      context.commands.entries.every((entry: Record<string, unknown>) => !("prompt" in entry)),
    ).toBe(true);
    expect(prompt).toContain(
      "The host already attempted the permitted `programmatic_scan({})` exactly once; do not call it again.",
    );
    expect(await fs.readFile(profilePath)).toEqual(before);
  } finally {
    await session.dispose();
  }
});

/** The live tool array is private; tiering is precisely a claim about it. */
function liveToolNames(session: unknown): string[] {
  return (session as { tools: { name: string }[] }).tools.map((tool) => tool.name);
}

function stubTool(name: string): AgentTool {
  return {
    name,
    description: name,
    parameters: z.object({}),
    execute: () => `${name} executed`,
  };
}

const TOOL_CONTEXT = {
  signal: new AbortController().signal,
  toolCallId: "tool-tier-test",
} as ToolContext;

describe("AgentSession built-in tool tiering", () => {
  it("keeps deferred schemas out of the live set but names them in the prompt", async () => {
    const session = await createSession();
    try {
      const live = liveToolNames(session);
      const prompt = String(session.getMessages()[0]?.content ?? "");

      expect(live).toContain("tool_search");
      expect(prompt).toContain("On demand (call by name;");

      const deferredHere = DEFERRED_TOOL_NAMES.filter((name) => prompt.includes(`- **${name}**:`));
      expect(deferredHere.length).toBeGreaterThan(0);
      for (const name of deferredHere) {
        expect(live, `${name} should not carry a schema`).not.toContain(name);
      }
      // Core tools are unaffected.
      for (const name of ["read", "edit", "bash", "grep"]) {
        expect(live).toContain(name);
      }

      const proposal = await buildProgrammaticProfileProposal(tempProject);
      expect(
        (
          await persistProgrammaticProfile(
            tempProject,
            proposal.configurationFingerprint,
            proposal.profile,
          )
        ).ok,
      ).toBe(true);
      await session.prompt("/programmatic");
      const commandPrompt = String(
        session.getMessages().find((message) => message.role === "user")?.content,
      );
      expect(commandPrompt).toContain("The host supplies permitted assessment tools");
    } finally {
      await session.dispose();
    }
  }, 20_000);

  it("keeps host-provided additional tools eager without a static allow-list", async () => {
    const session = await createSession({ additionalTools: [stubTool("roadmap_inspect")] });
    try {
      expect(liveToolNames(session)).toContain("roadmap_inspect");
      expect(String(session.getMessages()[0]?.content ?? "")).not.toContain(
        "- **roadmap_inspect**:",
      );
    } finally {
      await session.dispose();
    }
  }, 20_000);

  it("promotes capability-allowed deferred tools when policy is set before initialize", async () => {
    const session = await createUninitializedSession();
    session.setToolCapabilityPolicy({ allowedToolNames: ["read", "source_path"] });
    await session.initialize();
    try {
      expect(liveToolNames(session)).toContain("source_path");
      expect(liveToolNames(session)).not.toContain("screenshot");
    } finally {
      await session.dispose();
    }
  }, 20_000);

  it("hides unavailable deferred tools from tool_search", async () => {
    const session = await createUninitializedSession();
    session.setToolAvailability(["screenshot"], false);
    await session.initialize();
    try {
      const toolSearch = (session as unknown as { tools: AgentTool[] }).tools.find(
        (tool) => tool.name === "tool_search",
      );
      const result = String(
        await toolSearch?.execute({ query: "capture screenshot" }, TOOL_CONTEXT),
      );
      expect(result).not.toContain("screenshot:");
      expect(liveToolNames(session)).not.toContain("screenshot");
    } finally {
      await session.dispose();
    }
  }, 20_000);

  it("keeps a session's chosen built-ins in the core set, in their original order", async () => {
    // GG Goals orchestrates: tools it relies on must not need a tool_search turn.
    const plain = await createSession();
    const kept = await createSession({ coreTools: ["web_fetch", "find"] });
    try {
      const before = liveToolNames(plain);
      const after = liveToolNames(kept);
      expect(before).not.toContain("web_fetch");
      expect(before).not.toContain("find");
      expect(after).toContain("web_fetch");
      expect(after).toContain("find");
      // Everything else is unchanged and keeps its relative order.
      expect(after.filter((name) => name !== "web_fetch" && name !== "find")).toEqual(before);
      // Offered once, not also as a deferred catalog entry.
      const prompt = String(kept.getMessages()[0]?.content ?? "");
      expect(prompt).not.toContain("- **web_fetch**:");
      expect(prompt).not.toContain("- **find**:");
    } finally {
      await plain.dispose();
      await kept.dispose();
    }
  }, 20_000);

  it("never creates .gg folders in a sub-agent worker's folder", async () => {
    // Regression: GG Goals' workers left empty .gg/agents, commands and
    // skills folders in the user's attached folders.
    const worker = await createSession({ projectCustomization: true, subagentWorker: true });
    try {
      await expect(fs.stat(path.join(tempProject, ".gg"))).rejects.toThrow();
    } finally {
      await worker.dispose();
    }
    const owner = await createSession({ projectCustomization: true });
    try {
      expect((await fs.stat(path.join(tempProject, ".gg", "skills"))).isDirectory()).toBe(true);
    } finally {
      await owner.dispose();
    }
  }, 20_000);

  it("offers only a fixed sub-agent team when one is given, instead of discovering agents", async () => {
    // GG Goals' workers are its own team, never GG Coder's or the user's.
    const team = [
      {
        name: "goal-builder",
        description: "Makes changes.",
        tools: ["read", "write"],
        model: "inherit",
        systemPrompt: "Build.",
        source: "bundled" as const,
      },
    ];
    const plain = await createSession({ coreTools: ["spawn_agent"], globalSubagents: true });
    const goals = await createSession({ coreTools: ["spawn_agent"], subAgents: team });
    const spawnDescription = (session: unknown): string =>
      (session as { tools: { name: string; description: string }[] }).tools.find(
        (t) => t.name === "spawn_agent",
      )?.description ?? "";
    try {
      expect(spawnDescription(goals)).toContain("- goal-builder: Makes changes.");
      expect(spawnDescription(goals)).not.toContain("- bee:");
      expect(spawnDescription(plain)).toContain("- bee:");
      expect(spawnDescription(plain)).not.toContain("goal-builder");
    } finally {
      await plain.dispose();
      await goals.dispose();
    }
  }, 20_000);

  it("leaves out a session's withheld tools entirely, keeping the rest and their tiering", async () => {
    // GG Goals never edits or runs anything: it never has those tools, so it
    // can't reach for a shell to look around.
    const plain = await createSession();
    const without = ["edit", "write", "bash", "ui_adopt"];
    const goals = await createSession({ withoutTools: without });
    try {
      const before = liveToolNames(plain);
      const after = liveToolNames(goals);
      for (const name of without) expect(after).not.toContain(name);
      expect(after).toEqual(before.filter((name) => !without.includes(name)));
      expect(after).toContain("tool_search");
      // Not offered on demand either.
      const prompt = String(goals.getMessages()[0]?.content ?? "");
      expect(prompt).not.toContain("- **ui_adopt**:");
      expect(String(plain.getMessages()[0]?.content ?? "")).toContain("- **ui_adopt**:");
    } finally {
      await plain.dispose();
      await goals.dispose();
    }
  }, 20_000);

  it("discovers UI libraries in a normal session and executes the promoted tool offline", async () => {
    const session = await createSession();
    try {
      const prompt = String(session.getMessages()[0]?.content ?? "");
      expect(prompt).toContain("**ui_registry**");
      expect(prompt).toContain("**ui_adopt**");
      const tools = (session as unknown as { tools: AgentTool[] }).tools;
      const originalNames = tools.map((tool) => tool.name);
      const context = { signal: new AbortController().signal, toolCallId: "ui-discovery-test" };
      await tools
        .find((tool) => tool.name === "tool_search")!
        .execute({ query: "ui_registry ui_adopt Bklit Kokonut Motion" }, context);
      expect(tools.slice(0, originalNames.length).map((tool) => tool.name)).toEqual(originalNames);
      expect(tools.map((tool) => tool.name)).toContain("ui_registry");
      expect(tools.map((tool) => tool.name)).toContain("ui_adopt");
      const result = await tools
        .find((tool) => tool.name === "ui_registry")!
        .execute({ action: "motion" }, context);
      expect(JSON.parse(String(result)).kind).toBe("animation-api");
    } finally {
      await session.dispose();
    }
  }, 20_000);

  it("loads wait_agent as soon as spawn_agent succeeds, skipping the tool_search turn", async () => {
    // spawn_agent only exists when an agent is defined.
    await fs.mkdir(path.join(tempHome, ".gg", "agents"), { recursive: true });
    await fs.writeFile(
      path.join(tempHome, ".gg", "agents", "owl.md"),
      "---\nname: owl\ndescription: Read-only helper\ntools: read\n---\nYou read code.\n",
    );
    const session = await createSession({ globalSubagents: true });
    try {
      const tools = (session as unknown as { tools: AgentTool[] }).tools;
      expect(liveToolNames(session)).not.toContain("wait_agent");
      // spawn_agent is deferred too; the agent loop loads it on first call.
      expect(liveToolNames(session)).not.toContain("spawn_agent");
      const resolve = (
        session as unknown as { promoteDeferredBuiltin(name: string): AgentTool | undefined }
      ).promoteDeferredBuiltin.bind(session);
      const spawn = resolve("spawn_agent")!;
      expect(liveToolNames(session).at(-1)).toBe("spawn_agent");
      expect(tools.at(-1)).toBe(spawn);
      const context = { signal: new AbortController().signal, toolCallId: "spawn-promote-test" };
      const subAgents = (
        session as unknown as { subAgentManager: { spawn: (...a: unknown[]) => Promise<unknown> } }
      ).subAgentManager;
      const spawnSpy = vi.spyOn(subAgents, "spawn");

      // A spawn that starts nothing fails and must not change the tool list.
      spawnSpy.mockRejectedValueOnce(new Error("At most 8 agents may run at once"));
      await expect(
        spawn.execute({ tasks: [{ task_name: "x", task: "y" }] }, context),
      ).rejects.toThrow(/No agent started/);
      expect(liveToolNames(session)).not.toContain("wait_agent");

      const before = liveToolNames(session);
      spawnSpy.mockResolvedValue({ agent_id: "abcd1234", task_name: "scan", state: "running" });
      await spawn.execute({ tasks: [{ task_name: "scan", task: "look" }] }, context);

      const after = liveToolNames(session);
      // Appended once, after every existing tool, so the cached prefix holds.
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.filter((name) => name === "wait_agent")).toEqual(["wait_agent"]);
      await spawn.execute({ tasks: [{ task_name: "scan2", task: "look" }] }, context);
      expect(liveToolNames(session)).toEqual(after);
      // The prompt index stops advertising it once it carries its own schema.
      const index = (
        session as unknown as { deferredToolNamesForPrompt(live: string[]): string[] }
      ).deferredToolNamesForPrompt(after);
      expect(index).not.toContain("wait_agent");
    } finally {
      await session.dispose();
    }
  }, 20_000);

  it("loads a deferred built-in called by name, and the task tools once bash backgrounds", async () => {
    const session = await createSession();
    try {
      const resolve = (
        session as unknown as { promoteDeferredBuiltin(name: string): AgentTool | undefined }
      ).promoteDeferredBuiltin.bind(session);
      const before = liveToolNames(session);
      expect(before).not.toContain("find");
      expect(before).not.toContain("task_output");

      expect(resolve("find")?.name).toBe("find");
      expect(resolve("not_a_tool")).toBeUndefined();
      expect(liveToolNames(session)).toEqual([...before, "find"]);

      const tools = (session as unknown as { tools: AgentTool[] }).tools;
      const bash = tools.find((tool) => tool.name === "bash");
      const context = { signal: new AbortController().signal, toolCallId: "bg-promote-test" };
      await bash?.execute({ command: "true" }, context);
      expect(liveToolNames(session)).not.toContain("task_output");
      const bg = await bash?.execute({ command: "true", run_in_background: true }, context);
      const id = /id="([^"]+)"/.exec(String(bg))?.[1];
      expect(liveToolNames(session).slice(-3)).toEqual(["task_output", "task_send", "task_stop"]);
      if (id) {
        const output = tools.find((tool) => tool.name === "task_output");
        await output?.execute({ id, wait_ms: 5_000 }, context);
      }
    } finally {
      await session.dispose();
    }
  }, 20_000);

  it("registers tool_search even with no MCP server connected", async () => {
    const session = await createSession();
    try {
      expect(liveToolNames(session).filter((n) => n === "tool_search")).toHaveLength(1);
    } finally {
      await session.dispose();
    }
  }, 20_000);

  it("appends tool_search after the core tools, never reordering them", async () => {
    const session = await createSession();
    try {
      const live = liveToolNames(session);
      expect(live.indexOf("tool_search")).toBe(live.length - 1);
      expect(live.indexOf("read")).toBeLessThan(live.indexOf("edit"));
    } finally {
      await session.dispose();
    }
  }, 20_000);

  it("keeps allow-listed and additional tools eager while guarding late registration", async () => {
    const requested = [
      "read",
      "grep",
      "source_path",
      "programmatic_command",
      "screenshot",
      "allowed_extra",
      "late_allowed",
    ];
    const session = await createSession({
      allowedTools: requested,
      allowedMcpServers: ["safe-search"],
      additionalTools: [stubTool("allowed_extra"), stubTool("blocked_extra")],
    });
    try {
      const live = liveToolNames(session);
      for (const name of requested.filter((name) => name !== "late_allowed")) {
        expect(live, `${name} missing`).toContain(name);
      }
      expect(live).not.toContain("blocked_extra");
      expect(live).not.toContain("tool_search");
      expect(String(session.getMessages()[0]?.content ?? "")).not.toContain("Available on demand");

      session.registerTool(stubTool("late_allowed"));
      session.registerTool(stubTool("late_blocked"));
      // Prefix-like ordinary tools carry no MCP identity metadata and must not
      // inherit an MCP server allow-list merely by choosing a matching name.
      session.registerTool(stubTool("mcp__safe-search__query"));
      session.registerTool(stubTool("mcp__unsafe-search__query"));

      expect(liveToolNames(session)).toContain("late_allowed");
      expect(liveToolNames(session)).not.toEqual(
        expect.arrayContaining([
          "late_blocked",
          "mcp__safe-search__query",
          "mcp__unsafe-search__query",
        ]),
      );

      const registered = (session as unknown as { registeredTools: Map<string, AgentTool> })
        .registeredTools;
      await expect(registered.get("late_blocked")?.execute({}, TOOL_CONTEXT)).rejects.toThrow(
        "late_blocked is unavailable",
      );
      await expect(
        registered.get("mcp__safe-search__query")?.execute({}, TOOL_CONTEXT),
      ).rejects.toThrow("mcp__safe-search__query is unavailable");
      await expect(
        registered.get("mcp__unsafe-search__query")?.execute({}, TOOL_CONTEXT),
      ).rejects.toThrow("mcp__unsafe-search__query is unavailable");
    } finally {
      await session.dispose();
    }
  }, 20_000);

  it("ships every built-in eagerly when deferredBuiltinTools is off", async () => {
    await writeSettings({ deferredBuiltinTools: false });
    const session = await createSession();
    try {
      const live = liveToolNames(session);
      expect(live).toContain("source_path");
      expect(live).toContain("screenshot");
      expect(live).toContain("programmatic_scan");
      expect(live).not.toContain("tool_search");
      expect(String(session.getMessages()[0]?.content ?? "")).not.toContain("Available on demand");

      const proposal = await buildProgrammaticProfileProposal(tempProject);
      expect(
        (
          await persistProgrammaticProfile(
            tempProject,
            proposal.configurationFingerprint,
            proposal.profile,
          )
        ).ok,
      ).toBe(true);
      await session.prompt("/programmatic");
      const commandPrompt = String(
        session.getMessages().find((message) => message.role === "user")?.content,
      );
      expect(commandPrompt).toContain(
        "The host already attempted the permitted `programmatic_scan({})` exactly once; do not call it again.",
      );
      expect(commandPrompt).not.toContain("tool_search");
    } finally {
      await session.dispose();
    }
  }, 20_000);
});
