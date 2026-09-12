import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentTool, ToolContext } from "@kenkaiiii/gg-agent";
import type * as GgAgentModule from "@kenkaiiii/gg-agent";
import { createAppSidecarChatRoadmapSessionOptions } from "./app-sidecar-roadmap-session-options.js";
import { createChatAgent, switchChatAgent } from "./chat-agents/index.js";
import {
  RESEARCH_CHAT_ALLOWED_TOOL_NAMES,
  RESEARCH_CHAT_ALLOWED_TOOL_PREFIXES,
} from "./chat-agents/research.js";
import type { AgentSession } from "./core/agent-session.js";
import { DeferredToolCatalog } from "./core/mcp/deferred-catalog.js";
import { useFakeHome } from "./test-support/fake-home.js";
import { createToolSearchTool } from "./tools/tool-search.js";

const observedProviderToolNames = vi.hoisted(() => [] as string[][]);
const observedNativeWebSearch = vi.hoisted(() => [] as boolean[]);
const agentLoopMock = vi.hoisted(() =>
  vi.fn((_messages: unknown, options: { tools?: AgentTool[]; webSearch?: boolean }) => {
    observedProviderToolNames.push((options.tools ?? []).map((tool) => tool.name).sort());
    observedNativeWebSearch.push(options.webSearch === true);
    return (async function* emptyLoop() {})();
  }),
);

vi.mock("@kenkaiiii/gg-agent", async () => {
  const actual = await vi.importActual<typeof GgAgentModule>("@kenkaiiii/gg-agent");
  return { ...actual, agentLoop: agentLoopMock };
});

const REMOVED_RESEARCH_TOOLS = [
  "remember",
  "update_memory",
  "forget",
  "set_jiwa",
  "update_jiwa",
  "forget_jiwa",
  "delegate_to_agent",
] as const;

const PROVIDER_VISIBLE_RESEARCH_TOOL_NAMES = RESEARCH_CHAT_ALLOWED_TOOL_NAMES.filter(
  (name) => name !== "web_search",
);

const TOOL_CONTEXT = {
  signal: new AbortController().signal,
  toolCallId: "research-contract",
} as ToolContext;

function stubTool(name: string, description = name): AgentTool {
  return {
    name,
    description,
    parameters: z.record(z.string(), z.unknown()),
    execute: () => `${name} executed`,
  };
}

let restoreHome: (() => void) | undefined;
let tempHome: string;
let tempProject: string;

beforeEach(async () => {
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "research-contract-home-"));
  tempProject = await fs.mkdtemp(path.join(os.tmpdir(), "research-contract-project-"));
  restoreHome = useFakeHome(tempHome);
  observedProviderToolNames.length = 0;
  observedNativeWebSearch.length = 0;
  agentLoopMock.mockClear();
  await fs.mkdir(path.join(tempHome, ".gg"), { recursive: true });
  await fs.writeFile(
    path.join(tempHome, ".gg", "auth.json"),
    JSON.stringify({
      anthropic: {
        accessToken: "research-contract-access-token",
        refreshToken: "research-contract-refresh-token",
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

describe("app sidecar Research capability contract", () => {
  it("keeps provider, stale, late, direct, and deferred tool paths inside the read-only boundary", async () => {
    const catalog = new DeferredToolCatalog();
    catalog.add([
      stubTool("mcp__kencode-search__searchCode", "search public code"),
      stubTool("mcp__unknown-mutator__write", "mutate external code"),
    ]);

    const sessionHolder: { current?: AgentSession } = {};
    const toolSearch = createToolSearchTool(
      catalog,
      (tools) => {
        for (const tool of tools) sessionHolder.current!.registerTool(tool);
      },
      undefined,
      (name) =>
        (
          sessionHolder.current as unknown as {
            isToolCapabilityAllowed(toolName: string): boolean;
          }
        ).isToolCapabilityAllowed(name),
    );
    const roadmapTools = [stubTool("roadmap_inspect"), stubTool("roadmap_phase_draft")];
    const session = createChatAgent("general", {
      provider: "anthropic",
      model: "claude-test",
      cwd: tempProject,
      sessionsDir: path.join(tempHome, ".gg", "sessions"),
      transient: true,
      mcpEnabled: false,
      additionalTools: [
        ...REMOVED_RESEARCH_TOOLS.filter((name) => name !== "delegate_to_agent").map((name) =>
          stubTool(name),
        ),
        stubTool("steroids", "curated public code"),
        stubTool("ask_user", "request repository approval"),
        toolSearch,
      ],
      ...createAppSidecarChatRoadmapSessionOptions(roadmapTools),
    });
    sessionHolder.current = session;

    try {
      await session.initialize();
      const internals = session as unknown as {
        tools: AgentTool[];
        registeredTools: Map<string, AgentTool>;
      };
      const staleRemovedTools = new Map(
        REMOVED_RESEARCH_TOOLS.map((name) => [
          name,
          internals.tools.find((tool) => tool.name === name),
        ]),
      );
      for (const tool of staleRemovedTools.values()) expect(tool).toBeDefined();

      await switchChatAgent(session, "research", false);
      await session.prompt("Verify the current evidence.");

      expect(observedProviderToolNames.at(-1)).toEqual(
        [...PROVIDER_VISIBLE_RESEARCH_TOOL_NAMES].sort(),
      );
      expect(observedNativeWebSearch.at(-1)).toBe(true);
      expect(observedProviderToolNames.at(-1)).not.toEqual(
        expect.arrayContaining([...REMOVED_RESEARCH_TOOLS]),
      );

      for (const [name, tool] of staleRemovedTools) {
        await expect(tool?.execute({}, TOOL_CONTEXT)).rejects.toThrow(
          `${name} is unavailable while Research Agent is active`,
        );
      }

      session.registerTool(stubTool("late_mutator"));
      const lateMutator = internals.registeredTools.get("late_mutator");
      expect(lateMutator).toBeDefined();
      await expect(lateMutator?.execute({}, TOOL_CONTEXT)).rejects.toThrow(
        "late_mutator is unavailable while Research Agent is active",
      );

      const discovery = String(await toolSearch.execute({ query: "code" }, TOOL_CONTEXT));
      expect(discovery).not.toContain("mcp__kencode-search__searchCode");
      expect(discovery).not.toContain("mcp__unknown-mutator__write");
      expect(catalog.names()).toEqual([
        "mcp__kencode-search__searchCode",
        "mcp__unknown-mutator__write",
      ]);

      await session.prompt("Use the curated public-code evidence tool.");
      expect(observedProviderToolNames.at(-1)).toEqual(
        [...PROVIDER_VISIBLE_RESEARCH_TOOL_NAMES].sort(),
      );
      expect(
        observedProviderToolNames
          .at(-1)
          ?.every(
            (name) =>
              RESEARCH_CHAT_ALLOWED_TOOL_NAMES.includes(
                name as (typeof RESEARCH_CHAT_ALLOWED_TOOL_NAMES)[number],
              ) || RESEARCH_CHAT_ALLOWED_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix)),
          ),
      ).toBe(true);
    } finally {
      await session.dispose();
    }
  }, 20_000);
});
