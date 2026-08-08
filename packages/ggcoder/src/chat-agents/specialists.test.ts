import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT } from "../app-sidecar-roadmap-draft-tool-host.js";
import { createAppSidecarChatRoadmapSessionOptions } from "../app-sidecar-roadmap-session-options.js";
import type { AgentSessionOptions } from "../core/agent-session.js";
import { GENERAL_CHAT_SYSTEM_PROMPT } from "./general.js";
import { CHAT_AGENT_LABELS, createChatAgent, parseChatAgentId, switchChatAgent } from "./index.js";
import {
  RESEARCH_CHAT_ALLOWED_TOOL_NAMES,
  RESEARCH_CHAT_ALLOWED_TOOL_PREFIXES,
  RESEARCH_CHAT_SYSTEM_PROMPT,
} from "./research.js";
import { THERAPIST_CHAT_SYSTEM_PROMPT } from "./therapist.js";

const RESEARCH_REMOVED_TOOL_NAMES = [
  "remember",
  "update_memory",
  "forget",
  "set_jiwa",
  "update_jiwa",
  "forget_jiwa",
  "delegate_to_agent",
] as const;

const RESEARCH_PROHIBITED_TOOL_NAMES = [
  "bash",
  "edit",
  "write",
  "enter_plan",
  "exit_plan",
  "tasks",
  "task_output",
  "task_send",
  "task_stop",
  "subagent",
  "spawn_agent",
  "send_message",
  "followup_task",
  "wait_agent",
  "list_agents",
  "interrupt_agent",
  "generate_image",
  ...RESEARCH_REMOVED_TOOL_NAMES,
] as const;

function optionsFor(agentId: "therapist" | "research"): AgentSessionOptions {
  const agent = createChatAgent(agentId, {
    provider: "anthropic",
    model: "claude-test",
    cwd: "/tmp/workspace",
    sessionsDir: "/tmp/gg/sessions",
  });
  return (agent as unknown as { opts: AgentSessionOptions }).opts;
}

describe("specialist chat agents", () => {
  it("configures Therapist with a cached isolated prompt and the full toolset", () => {
    const options = optionsFor("therapist");
    expect(options.systemPrompt).toContain(THERAPIST_CHAT_SYSTEM_PROMPT);
    expect(options.systemPrompt).toContain("- Active agent: therapist");
    expect(options.promptCacheKeyPrefix).toBe("ggchat:therapist");
    expect(options.sessionRootDir).toBe(path.resolve("/tmp/gg/chat-sessions/therapist"));
    expect(options.allowedTools).toBeUndefined();
    expect(options.additionalTools?.map((tool) => tool.name)).toContain("delegate_to_agent");
    expect(options.systemPrompt).toContain("hand the entire conversation");
    expect(options.systemPrompt).toContain("not a one-off subtask");
    expect(options.systemPrompt).toContain("Durable memory curation:");
    expect(options.selfCorrectionHooks).toBe(false);
  });

  it("configures Research with a cached isolated read-only prompt", () => {
    const options = optionsFor("research");
    expect(options.systemPrompt).toContain(RESEARCH_CHAT_SYSTEM_PROMPT);
    expect(options.systemPrompt).toContain("- Active agent: research");
    expect(options.systemPrompt).toMatch(/- Current date: \d{4}-\d{2}-\d{2}/);
    expect(options.promptCacheKeyPrefix).toBe("ggchat:research");
    expect(options.sessionRootDir).toBe(path.resolve("/tmp/gg/chat-sessions/research"));
    expect(options.allowedTools).toBeUndefined();
    expect(options.additionalTools?.map((tool) => tool.name)).toContain("delegate_to_agent");
    expect(options.systemPrompt).toContain("available read-only research tools");
    expect(options.systemPrompt).toContain("Do not edit or create files");
    expect(options.systemPrompt).not.toContain("Durable memory curation:");
    expect(options.systemPrompt).not.toContain("Jiwa curation:");
    expect(options.systemPrompt).not.toContain("delegate_to_agent");
    for (const toolName of RESEARCH_REMOVED_TOOL_NAMES) {
      expect(options.systemPrompt).not.toContain(toolName);
    }
    expect(RESEARCH_CHAT_ALLOWED_TOOL_NAMES).toEqual([
      "read",
      "find",
      "grep",
      "code_search",
      "ls",
      "source_path",
      "web_fetch",
      "web_search",
      "tool_search",
      "roadmap_inspect",
      "roadmap_phase_draft",
    ]);
    expect(RESEARCH_CHAT_ALLOWED_TOOL_PREFIXES).toEqual(["mcp__kencode-search__"]);
  });

  it("retains memory tools and dynamic context when handoff is disabled", () => {
    const memoryTool: AgentTool = {
      name: "remember",
      description: "test memory tool",
      parameters: z.object({}),
      execute: () => "remembered",
    };
    const getSystemPromptTail = () => "current memories";
    const delegated = createChatAgent(
      "research",
      {
        provider: "anthropic",
        model: "claude-test",
        cwd: "/tmp/workspace",
        sessionsDir: "/tmp/gg/sessions",
        additionalTools: [memoryTool],
        getSystemPromptTail,
      },
      false,
    );
    const options = (delegated as unknown as { opts: AgentSessionOptions }).opts;
    expect(options.additionalTools?.map((tool) => tool.name)).toEqual(["remember"]);
    expect(options.getSystemPromptTail).toBe(getSystemPromptTail);
  });

  it("hands off the live session while preserving its conversation", async () => {
    const changed: string[] = [];
    const agent = createChatAgent("general", {
      provider: "anthropic",
      model: "claude-test",
      cwd: "/tmp/workspace",
      sessionsDir: "/tmp/gg/sessions",
      onAgentChange: (agentId) => {
        changed.push(agentId);
      },
    });
    const internals = agent as unknown as {
      opts: AgentSessionOptions;
      messages: Array<{ role: "system" | "user"; content: string }>;
    };
    internals.messages = [
      { role: "system", content: String(internals.opts.systemPrompt) },
      { role: "user", content: "existing conversation sentinel" },
    ];
    const tool = internals.opts.additionalTools?.find(
      (candidate) => candidate.name === "delegate_to_agent",
    );

    const result = await tool?.execute({ agent: "therapist" }, {
      signal: new AbortController().signal,
    } as never);

    expect(String(result)).toContain("Therapist Agent is now the active agent");
    expect(changed).toEqual(["therapist"]);
    expect(agent.getMessages()).toHaveLength(2);
    expect(agent.getMessages()[1]?.content).toBe("existing conversation sentinel");
    expect(agent.getMessages()[0]?.content).toContain(THERAPIST_CHAT_SYSTEM_PROMPT);
    expect(agent.getMessages()[0]?.content).toContain("- Active agent: therapist");

    const returnResult = await tool?.execute({ agent: "general" }, {
      signal: new AbortController().signal,
    } as never);
    expect(String(returnResult)).toContain("Brainstorm is now the active agent");
    expect(changed).toEqual(["therapist", "general"]);
    expect(agent.getMessages()[0]?.content).toContain(GENERAL_CHAT_SYSTEM_PROMPT);
    expect(agent.getMessages()[0]?.content).toContain("- Active agent: general");
    expect(internals.opts.promptCacheKeyPrefix).toBe("ggchat:general");
  });

  it("enforces positive Research capabilities across live and late tool registrations", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-chat-roadmap-policy-"));
    const makeTool = (name: string): AgentTool => ({
      name,
      description: name,
      parameters: z.object({}),
      execute: () => `${name} executed`,
    });
    const contextToolNames = RESEARCH_REMOVED_TOOL_NAMES.filter(
      (name) => name !== "delegate_to_agent",
    );
    const futureMutator = makeTool("future_mutating_tool");
    const roadmapTools: AgentTool[] = [
      {
        name: "roadmap_inspect",
        description: "inspect",
        parameters: z.object({}),
        execute: () => "inspected",
      },
      {
        name: "roadmap_phase_draft",
        description: "draft",
        parameters: z.object({}),
        execute: () => "drafted",
      },
    ];
    const agent = createChatAgent("general", {
      provider: "anthropic",
      model: "claude-test",
      cwd: root,
      sessionsDir: path.join(root, "sessions"),
      transient: true,
      mcpEnabled: false,
      additionalTools: [...contextToolNames.map(makeTool), futureMutator],
      getSystemPromptTail: () => "shared memory sentinel",
      ...createAppSidecarChatRoadmapSessionOptions(roadmapTools),
    });
    const internals = agent as unknown as {
      tools: AgentTool[];
      messages: Array<{ role: "system" | "user"; content: string }>;
      opts: AgentSessionOptions;
    };
    const scopedNames = () =>
      internals.tools
        .map((tool) => tool.name)
        .filter((name) => name.startsWith("roadmap_"))
        .sort();
    const allNames = () => internals.tools.map((tool) => tool.name).sort();
    const prohibitedNames = () =>
      RESEARCH_PROHIBITED_TOOL_NAMES.filter((name) => allNames().includes(name));
    const unexpectedResearchTools = () =>
      allNames().filter(
        (name) =>
          !RESEARCH_CHAT_ALLOWED_TOOL_NAMES.includes(
            name as (typeof RESEARCH_CHAT_ALLOWED_TOOL_NAMES)[number],
          ) && !RESEARCH_CHAT_ALLOWED_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix)),
      );
    const systemPrompt = () => String(agent.getMessages()[0]?.content);

    try {
      await agent.initialize();
      internals.messages.push({ role: "user", content: "conversation sentinel" });
      const conversation = agent.getMessages().slice(1);
      const brainstormTools = allNames();
      const staleFutureMutator = internals.tools.find(
        (tool) => tool.name === "future_mutating_tool",
      );
      const staleRemovedTools = new Map(
        RESEARCH_REMOVED_TOOL_NAMES.map((name) => [
          name,
          internals.tools.find((tool) => tool.name === name),
        ]),
      );
      const expectedResearchTools = RESEARCH_CHAT_ALLOWED_TOOL_NAMES.filter(
        (name) => brainstormTools.includes(name) || name.startsWith("roadmap_"),
      ).sort();
      expect(staleFutureMutator).toBeDefined();
      for (const tool of staleRemovedTools.values()) expect(tool).toBeDefined();
      expect(scopedNames()).toEqual([]);
      expect(allNames()).toEqual(expect.arrayContaining(["bash", "edit", "write", "tasks"]));
      expect(systemPrompt()).toContain("shared memory sentinel");
      expect(systemPrompt()).not.toContain(APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT);

      await switchChatAgent(agent, "research", false);
      expect(scopedNames()).toEqual(["roadmap_inspect", "roadmap_phase_draft"]);
      expect(prohibitedNames()).toEqual([]);
      expect(unexpectedResearchTools()).toEqual([]);
      expect(allNames()).toEqual(expectedResearchTools);
      expect(systemPrompt()).not.toContain("Durable memory curation:");
      expect(systemPrompt()).not.toContain("Jiwa curation:");
      expect(systemPrompt()).not.toContain("delegate_to_agent");
      await expect(
        staleFutureMutator?.execute(
          {},
          { signal: new AbortController().signal, toolCallId: "stale-future" },
        ),
      ).rejects.toThrow("future_mutating_tool is unavailable while Research Agent is active");
      for (const [name, tool] of staleRemovedTools) {
        await expect(
          tool?.execute({}, { signal: new AbortController().signal, toolCallId: `stale-${name}` }),
        ).rejects.toThrow(`${name} is unavailable while Research Agent is active`);
      }
      expect(agent.getMessages().slice(1)).toEqual(conversation);

      const lateMutator = makeTool("late_future_mutating_tool");
      const unknownMcp = makeTool("mcp__unknown-mutator__write");
      const kencodeMcp = makeTool("mcp__kencode-search__searchCode");
      agent.registerTool(lateMutator);
      agent.registerTool(unknownMcp);
      agent.registerTool(kencodeMcp);
      expect(allNames()).not.toContain("late_future_mutating_tool");
      expect(allNames()).not.toContain("mcp__unknown-mutator__write");
      expect(allNames()).toEqual(
        [...expectedResearchTools, "mcp__kencode-search__searchCode"].sort(),
      );

      const staleInspectTool = internals.tools.find((tool) => tool.name === "roadmap_inspect");
      expect(staleInspectTool).toBeDefined();
      const [researchPrefix, researchTail] = systemPrompt().split("<!-- uncached -->");
      expect(researchPrefix).not.toContain(APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT);
      expect(researchTail).toContain("shared memory sentinel");
      expect(researchTail).toContain(APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT);

      await switchChatAgent(agent, "therapist", false);
      expect(scopedNames()).toEqual([]);
      const expandedRegistry = [
        ...brainstormTools,
        "late_future_mutating_tool",
        "mcp__unknown-mutator__write",
        "mcp__kencode-search__searchCode",
      ].sort();
      expect(allNames()).toEqual(expandedRegistry);
      const staleLateMutator = internals.tools.find(
        (tool) => tool.name === "late_future_mutating_tool",
      );
      const staleUnknownMcp = internals.tools.find(
        (tool) => tool.name === "mcp__unknown-mutator__write",
      );
      expect(agent.getMessages().slice(1)).toEqual(conversation);
      expect(allNames()).toEqual(expect.arrayContaining(["bash", "edit", "write", "tasks"]));
      expect(systemPrompt()).not.toContain(APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT);
      await expect(
        staleInspectTool?.execute(
          {},
          { signal: new AbortController().signal, toolCallId: "stale-inspect" },
        ),
      ).rejects.toThrow("roadmap_inspect is unavailable under the active host policy");

      await switchChatAgent(agent, "research", false);
      expect(scopedNames()).toEqual(["roadmap_inspect", "roadmap_phase_draft"]);
      expect(prohibitedNames()).toEqual([]);
      expect(unexpectedResearchTools()).toEqual([]);
      expect(allNames()).not.toContain("late_future_mutating_tool");
      expect(allNames()).not.toContain("mcp__unknown-mutator__write");
      expect(allNames()).toContain("mcp__kencode-search__searchCode");
      await expect(
        staleLateMutator?.execute(
          {},
          { signal: new AbortController().signal, toolCallId: "stale-late" },
        ),
      ).rejects.toThrow("late_future_mutating_tool is unavailable while Research Agent is active");
      await expect(
        staleUnknownMcp?.execute(
          {},
          { signal: new AbortController().signal, toolCallId: "stale-mcp" },
        ),
      ).rejects.toThrow(
        "mcp__unknown-mutator__write is unavailable while Research Agent is active",
      );
      expect(agent.getMessages().slice(1)).toEqual(conversation);

      await switchChatAgent(agent, "general", false);
      expect(scopedNames()).toEqual([]);
      expect(allNames()).toEqual(expandedRegistry);
      expect(agent.getMessages().slice(1)).toEqual(conversation);
      expect(systemPrompt()).not.toContain(APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT);
    } finally {
      await agent.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("presents the compatible general id publicly as Brainstorm", () => {
    expect(CHAT_AGENT_LABELS.general).toBe("Brainstorm");
    expect(parseChatAgentId("general")).toBe("general");
    expect(parseChatAgentId("therapist")).toBe("therapist");
    expect(parseChatAgentId("research")).toBe("research");
    expect(parseChatAgentId("unknown")).toBe("general");
  });
});
