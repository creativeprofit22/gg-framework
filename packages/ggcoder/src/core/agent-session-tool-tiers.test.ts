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
  const { AgentSession } = await import("./agent-session.js");
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
      expect(prompt).toContain("Available on demand (call `tool_search` to load):");

      const deferredHere = DEFERRED_TOOL_NAMES.filter((name) => prompt.includes(`- **${name}**:`));
      expect(deferredHere.length).toBeGreaterThan(0);
      for (const name of deferredHere) {
        expect(live, `${name} should not carry a schema`).not.toContain(name);
      }
      // Core tools are unaffected.
      for (const name of ["read", "edit", "bash", "grep", "code_nav"]) {
        expect(live).toContain(name);
      }
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

  it("keeps allow-listed, additional, and MCP tools eager while guarding late registration", async () => {
    const requested = [
      "read",
      "grep",
      "source_path",
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
      session.registerTool(stubTool("mcp__safe-search__query"));
      session.registerTool(stubTool("mcp__unsafe-search__query"));

      expect(liveToolNames(session)).toEqual(
        expect.arrayContaining(["late_allowed", "mcp__safe-search__query"]),
      );
      expect(liveToolNames(session)).not.toEqual(
        expect.arrayContaining(["late_blocked", "mcp__unsafe-search__query"]),
      );

      const registered = (session as unknown as { registeredTools: Map<string, AgentTool> })
        .registeredTools;
      await expect(registered.get("late_blocked")?.execute({}, TOOL_CONTEXT)).rejects.toThrow(
        "late_blocked is unavailable",
      );
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
      expect(String(session.getMessages()[0]?.content ?? "")).not.toContain("Available on demand");
    } finally {
      await session.dispose();
    }
  }, 20_000);
});
