import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { AgentSessionOptions } from "../core/agent-session.js";
import { createChatAgent, parseChatAgentId } from "./index.js";
import { RESEARCH_CHAT_SYSTEM_PROMPT } from "./research.js";
import { THERAPIST_CHAT_SYSTEM_PROMPT } from "./therapist.js";
import path from "node:path";

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

    await tool?.execute({ agent: "general" }, {
      signal: new AbortController().signal,
    } as never);
    expect(changed).toEqual(["therapist", "general"]);
    expect(agent.getMessages()[0]?.content).toContain("- Active agent: general");
  });

  it("defaults unknown persisted agent ids to General", () => {
    expect(parseChatAgentId("therapist")).toBe("therapist");
    expect(parseChatAgentId("research")).toBe("research");
    expect(parseChatAgentId("unknown")).toBe("general");
  });
});
