import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { AgentSessionOptions } from "./core/agent-session.js";
import type { ChatAgentOptions } from "./chat-agents/shared.js";
import type { ChatAgentId } from "./chat-agents/types.js";
import { APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT } from "./app-sidecar-roadmap-draft-tool-host.js";

type CodingRoadmapSessionOptions = Pick<
  AgentSessionOptions,
  "additionalTools" | "getSystemPromptTail"
>;

type ChatRoadmapSessionOptions = Pick<
  ChatAgentOptions,
  "additionalToolsByAgent" | "getSystemPromptTailForAgent"
>;

/** Preserve the app coding session's existing status + draft Roadmap wiring. */
export function createAppSidecarCodingRoadmapSessionOptions(
  statusTools: AgentTool[],
  draftTools: AgentTool[],
): CodingRoadmapSessionOptions {
  return {
    additionalTools: [...statusTools, ...draftTools],
    getSystemPromptTail: () => APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT,
  };
}

/** Scope draft-only Roadmap capability and intent steering to active Research chat. */
export function createAppSidecarChatRoadmapSessionOptions(
  draftTools: AgentTool[],
): ChatRoadmapSessionOptions {
  return {
    additionalToolsByAgent: { research: draftTools },
    getSystemPromptTailForAgent: (agentId: ChatAgentId) =>
      agentId === "research" ? APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT : "",
  };
}
