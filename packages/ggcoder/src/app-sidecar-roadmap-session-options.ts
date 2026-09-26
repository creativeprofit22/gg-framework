import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { AgentSessionOptions } from "./core/agent-session.js";
import type { ChatAgentOptions } from "./chat-agents/shared.js";
import { APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT } from "./app-sidecar-roadmap-draft-tool-host.js";

type CodingRoadmapSessionOptions = Pick<
  AgentSessionOptions,
  "additionalTools" | "getSystemPromptTail"
>;

type ChatRoadmapSessionOptions = Pick<ChatAgentOptions, "additionalToolsByAgent">;

/** Preserve the app coding session's existing status + draft Roadmap wiring. */
export function createAppSidecarCodingRoadmapSessionOptions(
  statusTools: AgentTool[],
  draftTools: AgentTool[],
  bindingTools: AgentTool[] = [],
): CodingRoadmapSessionOptions {
  return {
    additionalTools: [...statusTools, ...draftTools, ...bindingTools],
    getSystemPromptTail: () => APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT,
  };
}

/** Scope read-only Roadmap inspection to active Research chat. */
export function createAppSidecarChatRoadmapSessionOptions(
  roadmapTools: AgentTool[],
): ChatRoadmapSessionOptions {
  return {
    additionalToolsByAgent: {
      research: roadmapTools.filter((tool) => tool.name === "roadmap_inspect"),
    },
  };
}
