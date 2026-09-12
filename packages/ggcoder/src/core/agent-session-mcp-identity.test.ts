import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentEvent, AgentTool, ToolContext } from "@kenkaiiii/gg-agent";
import type * as GgAgentModule from "@kenkaiiii/gg-agent";
import type * as McpModule from "./mcp/index.js";
import { useFakeHome } from "../test-support/fake-home.js";
import type { DeferredToolCatalog } from "./mcp/deferred-catalog.js";
import type { CachedTool } from "./mcp/catalog-cache.js";
import {
  createMcpToolIdentity,
  dedupeMcpToolDefinitions,
  getMcpToolIdentity,
  sameMcpToolIdentity,
  withMcpToolIdentity,
  type McpToolIdentity,
} from "./mcp/tool-identity.js";

vi.mock("@kenkaiiii/gg-agent", async () => {
  const actual = await vi.importActual<typeof GgAgentModule>("@kenkaiiii/gg-agent");
  return { ...actual, agentLoop: vi.fn(() => (async function* emptyLoop() {})()) };
});

vi.mock("./mcp/index.js", async () => {
  const actual = await vi.importActual<typeof McpModule>("./mcp/index.js");
  return {
    ...actual,
    getAllMcpServers: vi.fn(async () => []),
    MCPClientManager: vi.fn(function MCPClientManagerMock() {
      return {
        connectAll: vi.fn(async () => []),
        whenConnected: vi.fn(async () => ({ ok: true as const })),
        dispose: vi.fn(async () => {}),
      };
    }),
  };
});

type SessionHarness = {
  tools: AgentTool[];
  registeredTools: Map<string, AgentTool>;
  liveMcpTools: Map<string, AgentTool>;
  mcpToolIdentities: Map<string, McpToolIdentity>;
  mcpCatalog?: DeferredToolCatalog;
  claimMcpToolIdentity(tool: AgentTool): McpToolIdentity | undefined;
  addMcpTools(tools: AgentTool[]): void;
  addCachedMcpTools(tools: AgentTool[]): void;
  buildCachedMcpTool(identity: McpToolIdentity, cached: CachedTool): AgentTool;
  isToolAllowed(name: string, identity?: McpToolIdentity): boolean;
  forwardAgentEvent(event: AgentEvent): void;
};

let restoreHome: (() => void) | undefined;
let tempHome: string;
let tempProject: string;

const TOOL_CONTEXT = {
  signal: new AbortController().signal,
  toolCallId: "mcp-identity-test",
} as ToolContext;

beforeEach(async () => {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-identity-home-"));
  tempProject = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-identity-project-"));
  restoreHome = useFakeHome(tempHome);
  await fs.mkdir(path.join(tempHome, ".gg"), { recursive: true });
  await fs.writeFile(
    path.join(tempHome, ".gg", "settings.json"),
    JSON.stringify({ deferredMcpTools: true, deferredBuiltinTools: false }),
    "utf-8",
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

async function createSession(extra: Record<string, unknown> = {}) {
  const { AgentSession } = await import("./agent-session.js");
  const session = new AgentSession({
    provider: "anthropic",
    model: "claude-test",
    cwd: tempProject,
    transient: true,
    projectCustomization: false,
    loadExtensions: false,
    orchestrationPrompt: false,
    selfCorrectionHooks: false,
    mcpEnabled: false,
    ...extra,
  });
  await session.initialize();
  return session;
}

function ordinaryTool(name: string, result = `${name} executed`): AgentTool {
  return {
    name,
    description: `${name} capability`,
    parameters: z.record(z.string(), z.unknown()),
    execute: vi.fn(async () => result),
  };
}

function mcpTool(
  identity: McpToolIdentity,
  execute: AgentTool["execute"] = vi.fn(async () => identity.toolName),
): AgentTool {
  return withMcpToolIdentity(
    {
      name: identity.providerName,
      description: `needle capability for ${identity.toolName}`,
      parameters: z.record(z.string(), z.unknown()),
      execute,
    },
    identity,
  );
}

function harness(session: unknown): SessionHarness {
  return session as SessionHarness;
}

describe("AgentSession MCP identity boundary", () => {
  it("adds exact source identity to an opaque-alias presentation event", async () => {
    const session = await createSession();
    const identity = createMcpToolIdentity("server name", "tool:name");
    expect(identity.providerName).toMatch(/^mcp__id__/);
    session.registerTool(mcpTool(identity));
    const listener = vi.fn();
    session.eventBus.on("tool_call_start", listener);

    harness(session).forwardAgentEvent({
      type: "tool_call_start",
      toolCallId: "opaque-call",
      name: identity.providerName,
      args: { query: "needle" },
    });

    expect(listener).toHaveBeenCalledWith({
      toolCallId: "opaque-call",
      name: identity.providerName,
      args: { query: "needle" },
      displayName: "server name / tool:name",
      mcpServerName: "server name",
      mcpToolName: "tool:name",
    });
  });
  it("uses one alias for cached/live forms and promotes the exact live identity", async () => {
    const session = await createSession();
    const internals = harness(session);
    const identity = createMcpToolIdentity("server name", "tool:name:日本語");
    const cached = internals.buildCachedMcpTool(identity, {
      toolName: identity.toolName,
      description: "needle cached capability",
      rawInputSchema: { type: "object" },
    });
    expect(getMcpToolIdentity(cached)).toEqual(identity);
    expect(internals.claimMcpToolIdentity(cached)).toEqual(identity);
    internals.addCachedMcpTools([cached]);

    const dispatch = vi.fn(async () => `called:${identity.toolName}`);
    const live = mcpTool(identity, dispatch);
    internals.addMcpTools([live]);

    const toolSearch = internals.registeredTools.get("tool_search");
    const result = String(await toolSearch?.execute({ query: "needle cached" }, TOOL_CONTEXT));
    expect(result).toContain(identity.providerName);

    const promoted = internals.registeredTools.get(identity.providerName);
    expect(promoted).toBeDefined();
    expect(sameMcpToolIdentity(promoted, identity)).toBe(true);
    await expect(promoted?.execute({ exact: true }, TOOL_CONTEXT)).resolves.toBe(
      `called:${identity.toolName}`,
    );
    expect(dispatch).toHaveBeenCalledWith({ exact: true }, TOOL_CONTEXT);
  });

  it("allows a captured cached wrapper only across same-identity live replacement", async () => {
    const session = await createSession();
    const internals = harness(session);
    const identity = createMcpToolIdentity("unsafe server", "tool:name");
    const cached = internals.buildCachedMcpTool(identity, {
      toolName: identity.toolName,
      description: "cached",
    });
    session.registerTool(cached);
    const captured = internals.registeredTools.get(identity.providerName)!;

    const liveExecute = vi.fn(async () => "live result");
    internals.addMcpTools([mcpTool(identity, liveExecute)]);

    await expect(captured.execute({ from: "stale" }, TOOL_CONTEXT)).resolves.toBe("live result");
    expect(liveExecute).toHaveBeenCalledWith({ from: "stale" }, TOOL_CONTEXT);
  });

  it("rejects captured wrappers after removal or a non-MCP same-name replacement", async () => {
    const identity = createMcpToolIdentity("unsafe server", "tool:name");

    const removedSession = await createSession();
    removedSession.registerTool(mcpTool(identity));
    const removedInternals = harness(removedSession);
    const removed = removedInternals.registeredTools.get(identity.providerName)!;
    removedInternals.registeredTools.delete(identity.providerName);
    await expect(removed.execute({}, TOOL_CONTEXT)).rejects.toThrow("no longer registered");

    const replacedSession = await createSession();
    replacedSession.registerTool(mcpTool(identity));
    const replacedInternals = harness(replacedSession);
    const captured = replacedInternals.registeredTools.get(identity.providerName)!;
    replacedSession.registerTool(ordinaryTool(identity.providerName, "ordinary wins"));
    await expect(captured.execute({}, TOOL_CONTEXT)).rejects.toThrow("no longer registered");
    await expect(
      replacedInternals.registeredTools.get(identity.providerName)?.execute({}, TOOL_CONTEXT),
    ).resolves.toBe("ordinary wins");
  });

  it("keeps legacy-sanitizer collisions independently callable in either connection order", async () => {
    const firstIdentity = createMcpToolIdentity("alpha beta", "search tool");
    const secondIdentity = createMcpToolIdentity("alpha-beta", "search-tool");
    expect(firstIdentity.providerName).not.toBe(secondIdentity.providerName);

    for (const identities of [
      [firstIdentity, secondIdentity],
      [secondIdentity, firstIdentity],
    ]) {
      const session = await createSession();
      const internals = harness(session);
      internals.addMcpTools(identities.map((identity) => mcpTool(identity)));
      expect([...internals.liveMcpTools.keys()].sort()).toEqual(
        [firstIdentity.providerName, secondIdentity.providerName].sort(),
      );
      for (const identity of identities) {
        await expect(
          internals.liveMcpTools.get(identity.providerName)?.execute({}, TOOL_CONTEXT),
        ).resolves.toBe(identity.toolName);
      }
    }
  });

  it("keeps duplicate declarations from entering the session catalog", async () => {
    const session = await createSession();
    const internals = harness(session);
    const definitions = dedupeMcpToolDefinitions([
      { name: "duplicate" },
      { name: "unrelated" },
      { name: "duplicate" },
    ]);
    internals.addMcpTools(
      definitions.map(({ name }) => mcpTool(createMcpToolIdentity("server", name))),
    );

    expect([...internals.liveMcpTools.keys()]).toEqual(["mcp__server__unrelated"]);
    expect(internals.liveMcpTools.has("mcp__server__duplicate")).toBe(false);
  });

  it("never overwrites a host tool with a colliding MCP readable alias", async () => {
    const session = await createSession();
    const internals = harness(session);
    const identity = createMcpToolIdentity("ordinary", "tool");
    const host = ordinaryTool(identity.providerName, "host result");
    session.registerTool(host);

    internals.addMcpTools([mcpTool(identity)]);

    expect(internals.liveMcpTools.has(identity.providerName)).toBe(false);
    await expect(
      internals.registeredTools.get(identity.providerName)?.execute({}, TOOL_CONTEXT),
    ).resolves.toBe("host result");
  });

  it("keeps ordinary mcp__ tools during GLM cleanup while removing identity-bearing MCP tools", async () => {
    await fs.writeFile(
      path.join(tempHome, ".gg", "settings.json"),
      JSON.stringify({ deferredMcpTools: false, deferredBuiltinTools: false }),
      "utf-8",
    );
    const ordinary = ordinaryTool("mcp__ordinary__host", "ordinary survived");
    const session = await createSession({ mcpEnabled: true, additionalTools: [ordinary] });
    try {
      const internals = harness(session);
      const identity = createMcpToolIdentity("server name", "remote tool");
      internals.addMcpTools([mcpTool(identity)]);
      expect(internals.registeredTools.has(identity.providerName)).toBe(true);

      await session.switchModel("glm", "glm-test");

      expect(internals.registeredTools.has(identity.providerName)).toBe(false);
      await expect(
        internals.registeredTools.get(ordinary.name)?.execute({}, TOOL_CONTEXT),
      ).resolves.toBe("ordinary survived");
    } finally {
      await session.dispose();
    }
  }, 20_000);

  it("drops delayed old-generation tools and keeps close reporting on the fresh manager", async () => {
    const { getAllMcpServers, MCPClientManager } = await import("./mcp/index.js");
    vi.mocked(getAllMcpServers).mockResolvedValue([
      { name: "provider-server", command: "fake-mcp", args: [] },
    ]);

    let resolveOldConnection!: (tools: AgentTool[]) => void;
    const oldConnection = new Promise<AgentTool[]>((resolve) => {
      resolveOldConnection = resolve;
    });
    const oldDispose = vi.fn(async () => {});
    const oldManager = {
      connectAll: vi.fn(() => oldConnection),
      whenConnected: vi.fn(async () => ({ ok: true as const })),
      dispose: oldDispose,
    };

    let freshDisposed = false;
    const closeReports: string[] = [];
    const freshIdentity = createMcpToolIdentity("provider-server", "fresh-tool");
    const freshManager = {
      connectAll: vi.fn(async () => [mcpTool(freshIdentity)]),
      whenConnected: vi.fn(async () => ({ ok: true as const })),
      dispose: vi.fn(async () => {
        freshDisposed = true;
      }),
      reportUnexpectedClose: (serverName: string) => {
        if (!freshDisposed) closeReports.push(serverName);
      },
    };

    vi.mocked(MCPClientManager)
      .mockImplementationOnce(function OldMcpManager() {
        return oldManager as unknown as InstanceType<typeof MCPClientManager>;
      })
      .mockImplementationOnce(function FreshMcpManager() {
        return freshManager as unknown as InstanceType<typeof MCPClientManager>;
      });

    const session = await createSession({
      mcpEnabled: undefined,
      backgroundMcpConnect: true,
    });
    try {
      await vi.waitFor(() => expect(oldManager.connectAll).toHaveBeenCalledOnce());

      await session.switchModel("glm", "glm-test");
      expect(oldDispose).toHaveBeenCalledOnce();
      expect(freshManager.connectAll).toHaveBeenCalledOnce();

      const oldIdentity = createMcpToolIdentity("provider-server", "old-tool");
      resolveOldConnection([mcpTool(oldIdentity)]);
      await vi.waitFor(() => expect(oldDispose).toHaveBeenCalledTimes(2));

      const internals = harness(session);
      expect(internals.liveMcpTools.has(oldIdentity.providerName)).toBe(false);
      expect(internals.liveMcpTools.has(freshIdentity.providerName)).toBe(true);

      freshManager.reportUnexpectedClose("provider-server");
      expect(closeReports).toEqual(["provider-server"]);
    } finally {
      await session.dispose();
    }
  }, 20_000);

  it("discovers and invokes a persisted MCP tool immediately after a live reload", async () => {
    const { getAllMcpServers, MCPClientManager } = await import("./mcp/index.js");
    const config = { name: "live-server", command: "fake-mcp", args: [] };
    const identity = createMcpToolIdentity(config.name, "live-tool");
    const startupDispose = vi.fn(async () => {});
    const addedDispose = vi.fn(async () => {});
    const removedDispose = vi.fn(async () => {});
    const manager = (tools: AgentTool[], dispose: () => Promise<void>) => ({
      connectAll: vi.fn(async () => tools),
      whenConnected: vi.fn(async () => ({ ok: true as const })),
      dispose,
    });

    vi.mocked(getAllMcpServers)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([config])
      .mockResolvedValueOnce([]);
    vi.mocked(MCPClientManager)
      .mockImplementationOnce(function StartupMcpManager() {
        return manager([], startupDispose) as unknown as InstanceType<typeof MCPClientManager>;
      })
      .mockImplementationOnce(function AddedMcpManager() {
        return manager([mcpTool(identity)], addedDispose) as unknown as InstanceType<
          typeof MCPClientManager
        >;
      })
      .mockImplementationOnce(function RemovedMcpManager() {
        return manager([], removedDispose) as unknown as InstanceType<typeof MCPClientManager>;
      });

    const session = await createSession({ mcpEnabled: true, backgroundMcpConnect: false });
    try {
      const internals = harness(session);
      expect(internals.registeredTools.has(identity.providerName)).toBe(false);

      await session.reloadMcpServers();
      expect(startupDispose).toHaveBeenCalledOnce();
      expect(internals.registeredTools.has(identity.providerName)).toBe(false);

      const toolSearch = internals.registeredTools.get("tool_search");
      const discovery = String(await toolSearch?.execute({ query: "live-tool" }, TOOL_CONTEXT));
      expect(discovery).toContain(identity.providerName);
      const added = internals.registeredTools.get(identity.providerName);
      expect(added).toBeDefined();
      await expect(added?.execute({}, TOOL_CONTEXT)).resolves.toBe(identity.toolName);

      await session.reloadMcpServers();
      expect(addedDispose).toHaveBeenCalledOnce();
      expect(internals.registeredTools.has(identity.providerName)).toBe(false);
      expect(internals.liveMcpTools.has(identity.providerName)).toBe(false);
      await expect(added?.execute({}, TOOL_CONTEXT)).rejects.toThrow("no longer registered");
    } finally {
      await session.dispose();
    }
  }, 20_000);

  it("authorizes opaque aliases from metadata, never by parsing provider names", async () => {
    const session = await createSession({
      allowedTools: ["read"],
      allowedMcpServers: ["unsafe server"],
    });
    const internals = harness(session);
    const allowedIdentity = createMcpToolIdentity("unsafe server", "tool:name");
    const blockedIdentity = createMcpToolIdentity("other server", "tool:name");

    expect(allowedIdentity.providerName).toMatch(/^mcp__id__/);
    expect(internals.isToolAllowed(allowedIdentity.providerName, allowedIdentity)).toBe(true);
    expect(internals.isToolAllowed(blockedIdentity.providerName, blockedIdentity)).toBe(false);
    expect(internals.isToolAllowed("mcp__unsafe server__fabricated")).toBe(false);
  });
});
