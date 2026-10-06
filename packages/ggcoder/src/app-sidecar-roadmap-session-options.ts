import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { AgentSession, AgentSessionOptions } from "./core/agent-session.js";
import type { ChatAgentOptions } from "./chat-agents/shared.js";
import {
  APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT,
  APP_SIDECAR_ROADMAP_PHASE_SYSTEM_PROMPT,
} from "./app-sidecar-roadmap-draft-tool-host.js";

type CodingRoadmapSessionOptions = Pick<
  AgentSessionOptions,
  "additionalTools" | "getSystemPromptTail"
>;

type ChatRoadmapSessionOptions = Pick<ChatAgentOptions, "additionalToolsByAgent">;

type PhaseContextSource = Pick<AgentSession, "getActivePhaseContext">;

export interface PhaseScopedRoadmapWiring {
  /** Scopes default roadmap_inspect to the bound phase. */
  getActivePhaseId: () => string | undefined;
  /** Selects the lean bound-phase system prompt tail. */
  isPhaseBound: () => boolean;
}

/**
 * Derive phase-scoped Roadmap wiring from a session getter. The getter is read
 * lazily on every call so a replaced or newly bound session is always observed.
 */
export function createPhaseScopedRoadmapWiring(
  getSession: () => PhaseContextSource,
): PhaseScopedRoadmapWiring {
  return {
    getActivePhaseId: () => getSession().getActivePhaseContext()?.phase.id,
    isPhaseBound: () => getSession().getActivePhaseContext() !== undefined,
  };
}

/** Preserve the app coding session's existing status + draft Roadmap wiring. */
export function createAppSidecarCodingRoadmapSessionOptions(
  statusTools: AgentTool[],
  draftTools: AgentTool[],
  bindingTools: AgentTool[] = [],
  isPhaseBound: () => boolean = () => false,
): CodingRoadmapSessionOptions {
  return {
    additionalTools: [...statusTools, ...draftTools, ...bindingTools],
    // A bound phase session gets lean guidance that never asks for the whole Roadmap.
    getSystemPromptTail: () =>
      isPhaseBound()
        ? APP_SIDECAR_ROADMAP_PHASE_SYSTEM_PROMPT
        : APP_SIDECAR_ROADMAP_DRAFT_SYSTEM_PROMPT,
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
