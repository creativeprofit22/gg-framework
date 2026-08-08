import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { z } from "zod";
import {
  commitChatResearchTransition,
  executeChatResearchHandoff,
  resolveChatResearchCommandRoute,
} from "./app-sidecar-chat-research-handoff.js";
import { APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT } from "./app-sidecar-roadmap-draft-tool-host.js";
import { createAppSidecarChatRoadmapSessionOptions } from "./app-sidecar-roadmap-session-options.js";
import { createChatAgent, parseChatAgentId, switchChatAgent } from "./chat-agents/index.js";
import type { AgentSession, AgentSessionOptions } from "./core/agent-session.js";
import { normalizeAppMarkersForHistory, resolveRestoredCommand } from "./core/session-history.js";

const tempDirs: string[] = [];
const originalAzureApiKey = process.env.AZURE_OPENAI_API_KEY;
const originalAzureBaseUrl = process.env.AZURE_OPENAI_BASE_URL;
const originalAzureDeployment = process.env.AZURE_OPENAI_DEPLOYMENT;

beforeEach(() => {
  process.env.AZURE_OPENAI_API_KEY = "research-restoration-key";
  process.env.AZURE_OPENAI_BASE_URL = "https://research.restoration/openai/v1/responses";
  process.env.AZURE_OPENAI_DEPLOYMENT = "research-restoration";
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          [
            `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Assistant reply" })}\n\n`,
            `data: ${JSON.stringify({
              type: "response.completed",
              response: { usage: { input_tokens: 10, output_tokens: 3 } },
            })}\n\n`,
          ].join(""),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    ),
  );
});

afterEach(async () => {
  if (originalAzureApiKey === undefined) delete process.env.AZURE_OPENAI_API_KEY;
  else process.env.AZURE_OPENAI_API_KEY = originalAzureApiKey;
  if (originalAzureBaseUrl === undefined) delete process.env.AZURE_OPENAI_BASE_URL;
  else process.env.AZURE_OPENAI_BASE_URL = originalAzureBaseUrl;
  if (originalAzureDeployment === undefined) delete process.env.AZURE_OPENAI_DEPLOYMENT;
  else process.env.AZURE_OPENAI_DEPLOYMENT = originalAzureDeployment;
  vi.unstubAllGlobals();
  await Promise.all(
    tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function roadmapTools(): AgentTool[] {
  return ["roadmap_inspect", "roadmap_phase_draft"].map((name) => ({
    name,
    description: name,
    parameters: z.object({}),
    execute: () => name,
  }));
}

function chatOptions(root: string, sessionId?: string): Parameters<typeof createChatAgent>[1] {
  return {
    provider: "azure",
    model: "azure:research-restoration",
    baseUrl: "https://research.restoration/openai/v1/responses",
    cwd: path.join(root, "project"),
    sessionsDir: path.join(root, "coder-sessions"),
    ...(sessionId ? { sessionId } : {}),
    mcpEnabled: false,
    getSystemPromptTail: () => "shared memory sentinel",
    ...createAppSidecarChatRoadmapSessionOptions(roadmapTools()),
  };
}

const RESEARCH_PROHIBITED_TOOL_NAMES = [
  "edit",
  "write",
  "enter_plan",
  "exit_plan",
  "tasks",
  "subagent",
  "spawn_agent",
  "send_message",
  "followup_task",
  "wait_agent",
  "list_agents",
  "interrupt_agent",
] as const;

function prohibitedResearchTools(policy: { allTools: string[] }): string[] {
  return RESEARCH_PROHIBITED_TOOL_NAMES.filter((name) => policy.allTools.includes(name));
}

function policySnapshot(session: AgentSession): {
  allTools: string[];
  roadmapTools: string[];
  systemPrompt: string;
  conversation: unknown[];
} {
  const internals = session as unknown as { tools: AgentTool[]; opts: AgentSessionOptions };
  const allTools = internals.tools.map((tool) => tool.name).sort();
  return {
    allTools,
    roadmapTools: allTools.filter((name) => name.startsWith("roadmap_")).sort(),
    systemPrompt: String(session.getMessages()[0]?.content),
    conversation: session.getMessages().slice(1),
  };
}

describe("chat Research restart restoration", () => {
  it("restores the handoff and short command hint without losing history or Research boundaries", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-chat-research-restore-"));
    tempDirs.push(root);
    await fs.mkdir(path.join(root, "project"), { recursive: true });

    const live = createChatAgent("general", chatOptions(root));
    await live.initialize();
    await live.prompt("Brainstorm context sentinel");
    const sessionPath = live.getState().sessionPath;
    const route = resolveChatResearchCommandRoute({
      mode: "chat",
      text: "/research   approval UX",
      attachmentCount: 0,
      busy: false,
    });
    if (route.kind !== "start") throw new Error("expected Research route");

    const liveHistoryBeforeHandoff = live.getMessages().slice(1);
    await executeChatResearchHandoff(route, {
      session: live,
      commitResearchTransition: (session) =>
        commitChatResearchTransition({
          session,
          previousAgent: "general" as const,
          researchAgent: "research" as const,
          switchAgent: (active, nextAgent) => switchChatAgent(active, nextAgent, false),
          persistAgentHandoff: (active) =>
            active.persistAppMarker("agent_handoff", { chatAgent: "research" }),
        }),
      persistUserHint: (session, command) => session.persistAppMarker("user_hint", { command }, 1),
      prompt: (session, prompt) => session.prompt(prompt),
    });

    const livePolicy = policySnapshot(live);
    expect(live.getState().sessionPath).toBe(sessionPath);
    expect(livePolicy.conversation.slice(0, liveHistoryBeforeHandoff.length)).toEqual(
      liveHistoryBeforeHandoff,
    );
    expect(livePolicy.roadmapTools).toEqual(["roadmap_inspect", "roadmap_phase_draft"]);
    expect(prohibitedResearchTools(livePolicy)).toEqual([]);
    expect(livePolicy.systemPrompt).toContain(APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT);
    const persistedConversation = livePolicy.conversation;
    await live.dispose();

    const restarted = createChatAgent("general", chatOptions(root, sessionPath));
    try {
      await restarted.initialize();
      const markers = restarted.getAppMarkers();
      const handoff = [...markers].reverse().find((marker) => marker.kind === "agent_handoff");
      const restoredAgent = parseChatAgentId(handoff?.data.chatAgent);
      await switchChatAgent(restarted, restoredAgent, false);

      expect(restoredAgent).toBe("research");
      expect(restarted.getState().sessionPath).toBe(sessionPath);
      expect(restarted.getMessages().slice(1)).toEqual(persistedConversation);

      const normalizedMarkers = normalizeAppMarkersForHistory(
        markers,
        restarted.getMessages().filter((message) => message.role !== "system").length,
      );
      const hint = [...normalizedMarkers].reverse().find((marker) => marker.kind === "user_hint");
      expect(hint?.data.command).toBe("/research approval UX");
      expect(resolveRestoredCommand(String(hint?.data.command), route.continuationPrompt, [])).toBe(
        "/research approval UX",
      );

      const restoredResearchPolicy = policySnapshot(restarted);
      expect(restoredResearchPolicy.roadmapTools).toEqual([
        "roadmap_inspect",
        "roadmap_phase_draft",
      ]);
      expect(prohibitedResearchTools(restoredResearchPolicy)).toEqual([]);
      expect(restoredResearchPolicy.systemPrompt).toContain(
        APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT,
      );

      await switchChatAgent(restarted, "general", false);
      const brainstormPolicy = policySnapshot(restarted);
      expect(brainstormPolicy.roadmapTools).toEqual([]);
      expect(brainstormPolicy.allTools).toEqual(expect.arrayContaining(["edit", "write", "tasks"]));
      expect(brainstormPolicy.systemPrompt).not.toContain(APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT);
      expect(brainstormPolicy.conversation).toEqual(persistedConversation);

      await switchChatAgent(restarted, "research", false);
      const researchAgainPolicy = policySnapshot(restarted);
      expect(researchAgainPolicy.roadmapTools).toEqual(["roadmap_inspect", "roadmap_phase_draft"]);
      expect(prohibitedResearchTools(researchAgainPolicy)).toEqual([]);
      expect(researchAgainPolicy.systemPrompt).toContain(APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT);
      expect(researchAgainPolicy.conversation).toEqual(persistedConversation);
    } finally {
      await restarted.dispose();
    }
  }, 45_000);

  it.each(["switch", "marker"] as const)(
    "keeps live and restarted sessions on Brainstorm when the %s step fails",
    async (failurePoint) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-chat-research-rollback-"));
      tempDirs.push(root);
      await fs.mkdir(path.join(root, "project"), { recursive: true });

      const live = createChatAgent("general", chatOptions(root));
      await live.initialize();
      await live.prompt("Brainstorm context sentinel");
      const sessionPath = live.getState().sessionPath;
      const sessionManager = Reflect.get(live, "sessionManager") as {
        appendEntry: (...args: unknown[]) => Promise<unknown>;
      };
      const appendEntrySpy = vi.spyOn(sessionManager, "appendEntry");
      if (failurePoint === "marker") {
        appendEntrySpy.mockRejectedValueOnce(new Error("marker failed"));
      }

      await expect(
        commitChatResearchTransition({
          session: live,
          previousAgent: "general" as const,
          researchAgent: "research" as const,
          switchAgent: async (session, nextAgent) => {
            const changed = await switchChatAgent(session, nextAgent, false);
            if (failurePoint === "switch" && nextAgent === "research") {
              throw new Error("switch failed");
            }
            return changed;
          },
          persistAgentHandoff: (session) =>
            session.persistAppMarker("agent_handoff", { chatAgent: "research" }),
        }),
      ).rejects.toThrow(`${failurePoint} failed`);
      appendEntrySpy.mockRestore();

      expect(policySnapshot(live).roadmapTools).toEqual([]);
      expect(live.getAppMarkers().filter((marker) => marker.kind === "agent_handoff")).toEqual([]);
      await live.dispose();

      const restarted = createChatAgent("general", chatOptions(root, sessionPath));
      try {
        await restarted.initialize();
        const handoff = [...restarted.getAppMarkers()]
          .reverse()
          .find((marker) => marker.kind === "agent_handoff");
        const restoredAgent = parseChatAgentId(handoff?.data.chatAgent);
        await switchChatAgent(restarted, restoredAgent, false);

        expect(restoredAgent).toBe("general");
        expect(policySnapshot(restarted).roadmapTools).toEqual([]);
      } finally {
        await restarted.dispose();
      }
    },
    45_000,
  );
});
