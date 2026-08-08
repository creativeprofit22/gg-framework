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
import { RESEARCH_CHAT_SYSTEM_PROMPT } from "./research.js";
import { THERAPIST_CHAT_SYSTEM_PROMPT } from "./therapist.js";

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

  it("configures Research with a cached isolated prompt and the full toolset", () => {
    const options = optionsFor("research");
    expect(options.systemPrompt).toContain(RESEARCH_CHAT_SYSTEM_PROMPT);
    expect(options.systemPrompt).toContain("- Active agent: research");
    expect(options.systemPrompt).toMatch(/- Current date: \d{4}-\d{2}-\d{2}/);
    expect(options.promptCacheKeyPrefix).toBe("ggchat:research");
    expect(options.sessionRootDir).toBe(path.resolve("/tmp/gg/chat-sessions/research"));
    expect(options.allowedTools).toBeUndefined();
    expect(options.additionalTools?.map((tool) => tool.name)).toContain("delegate_to_agent");
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

  it("scopes app Roadmap draft tools and steering to active Research across live switches", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-chat-roadmap-policy-"));
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
      getSystemPromptTail: () => "shared memory sentinel",
      ...createAppSidecarChatRoadmapSessionOptions(roadmapTools),
    });
    const internals = agent as unknown as {
      tools: AgentTool[];
      opts: AgentSessionOptions;
    };
    const scopedNames = () =>
      internals.tools
        .map((tool) => tool.name)
        .filter((name) => name.startsWith("roadmap_"))
        .sort();
    const allNames = () => internals.tools.map((tool) => tool.name).sort();
    const systemPrompt = () => String(agent.getMessages()[0]?.content);

    try {
      await agent.initialize();
      const brainstormTools = allNames();
      expect(scopedNames()).toEqual([]);
      expect(systemPrompt()).toContain("shared memory sentinel");
      expect(systemPrompt()).not.toContain(APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT);

      await switchChatAgent(agent, "research", false);
      expect(scopedNames()).toEqual(["roadmap_inspect", "roadmap_phase_draft"]);
      expect(allNames().filter((name) => !name.startsWith("roadmap_"))).toEqual(
        brainstormTools.filter((name) => !name.startsWith("roadmap_")),
      );
      const staleInspectTool = internals.tools.find((tool) => tool.name === "roadmap_inspect");
      expect(staleInspectTool).toBeDefined();
      const [researchPrefix, researchTail] = systemPrompt().split("<!-- uncached -->");
      expect(researchPrefix).not.toContain(APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT);
      expect(researchTail).toContain("shared memory sentinel");
      expect(researchTail).toContain(APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT);

      await switchChatAgent(agent, "therapist", false);
      expect(scopedNames()).toEqual([]);
      expect(allNames()).toEqual(brainstormTools);
      expect(systemPrompt()).not.toContain(APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT);
      await expect(
        staleInspectTool?.execute(
          {},
          { signal: new AbortController().signal, toolCallId: "stale-inspect" },
        ),
      ).rejects.toThrow("roadmap_inspect is unavailable while Therapist Agent is active");

      await switchChatAgent(agent, "research", false);
      expect(scopedNames()).toEqual(["roadmap_inspect", "roadmap_phase_draft"]);
      await switchChatAgent(agent, "general", false);
      expect(scopedNames()).toEqual([]);
      expect(allNames()).toEqual(brainstormTools);
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
