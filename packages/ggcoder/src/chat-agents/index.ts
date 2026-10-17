import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { AgentSession } from "../core/agent-session.js";
import { createGeneralChatAgent, GENERAL_CHAT_SYSTEM_PROMPT } from "./general.js";
import {
  createResearchChatAgent,
  RESEARCH_CHAT_ALLOWED_TOOL_NAMES,
  RESEARCH_CHAT_ALLOWED_TOOL_PREFIXES,
  RESEARCH_CHAT_SYSTEM_PROMPT,
} from "./research.js";
import { createTherapistChatAgent, THERAPIST_CHAT_SYSTEM_PROMPT } from "./therapist.js";
import {
  buildChatAgentSystemPrompt,
  chatAgentSessionsDir,
  type ChatAgentOptions,
} from "./shared.js";
import { parseChatAgentId, type ChatAgentId } from "./types.js";

export { CHAT_AGENT_IDS, parseChatAgentId, type ChatAgentId } from "./types.js";
export { chatAgentSessionsDir } from "./shared.js";

export const CHAT_AGENT_LABELS: Record<ChatAgentId, string> = {
  general: "Brainstorm",
  therapist: "Therapist Agent",
  research: "Research Agent",
};

const CHAT_AGENT_PROMPTS: Record<ChatAgentId, string> = {
  general: GENERAL_CHAT_SYSTEM_PROMPT,
  therapist: THERAPIST_CHAT_SYSTEM_PROMPT,
  research: RESEARCH_CHAT_SYSTEM_PROMPT,
};

const delegationParameters = z.object({
  agent: z.enum(["general", "therapist", "research"]).describe("Agent to hand off to"),
});

interface ChatAgentController {
  current: ChatAgentId;
  switchTo: (agentId: ChatAgentId, notify: boolean) => Promise<boolean>;
}

const chatAgentControllers = new WeakMap<AgentSession, ChatAgentController>();

function createDelegationTool(
  getController: () => ChatAgentController,
): AgentTool<typeof delegationParameters> {
  return {
    name: "delegate_to_agent",
    description:
      "Hand the entire ongoing conversation to a different active agent. Therapist handles emotional support, reflection, coping, relationships, and wellbeing. Research handles evidence, sources, current information, comparisons, and deep analysis. Brainstorm handles ideation, problem framing, assumptions, tradeoffs, and broad conversation that no longer needs a specialist. This is a persistent handoff, not a one-off subtask.",
    parameters: delegationParameters,
    executionMode: "sequential",
    async execute({ agent }) {
      const controller = getController();
      if (agent === controller.current) {
        return `Already running as ${CHAT_AGENT_LABELS[controller.current]}; continue directly.`;
      }
      await controller.switchTo(agent, true);
      return `Handoff complete. ${CHAT_AGENT_LABELS[agent]} is now the active agent for this conversation. Continue from the full conversation history in that role.`;
    },
  };
}

/** Switch an existing chat session without resetting its conversation history. */
export async function switchChatAgent(
  session: AgentSession,
  agentId: ChatAgentId,
  notify = true,
): Promise<boolean> {
  const controller = chatAgentControllers.get(session);
  if (!controller) throw new Error("Session is not a chat agent");
  return controller.switchTo(agentId, notify);
}

export function createChatAgent(
  agentId: ChatAgentId,
  options: ChatAgentOptions,
  delegationEnabled = true,
): AgentSession {
  let session!: AgentSession;
  const { additionalToolsByAgent = {}, getSystemPromptTailForAgent, ...baseOptions } = options;
  const specialistSourceTools = new Map<string, AgentTool>();
  const specialistAgentsByTool = new Map<string, Set<ChatAgentId>>();
  for (const specialistId of ["general", "therapist", "research"] as const) {
    for (const tool of additionalToolsByAgent[specialistId] ?? []) {
      if (!specialistSourceTools.has(tool.name)) specialistSourceTools.set(tool.name, tool);
      const agents = specialistAgentsByTool.get(tool.name) ?? new Set<ChatAgentId>();
      agents.add(specialistId);
      specialistAgentsByTool.set(tool.name, agents);
    }
  }
  const specialistTools = [...specialistSourceTools].map<AgentTool>(([toolName, tool]) => ({
    ...tool,
    async execute(args, context) {
      const activeAgent = controller?.current ?? agentId;
      if (!specialistAgentsByTool.get(toolName)?.has(activeAgent)) {
        throw new Error(
          `${toolName} is unavailable while ${CHAT_AGENT_LABELS[activeAgent]} is active.`,
        );
      }
      return tool.execute(args, context);
    },
  }));
  const specialistToolNames = specialistTools.map((tool) => tool.name);
  const getSystemPromptTail = () =>
    [options.getSystemPromptTail?.(), getSystemPromptTailForAgent?.(controller?.current ?? agentId)]
      .filter((part): part is string => Boolean(part))
      .join("\n\n");
  const commonTools = options.additionalTools ?? [];
  const additionalTools = delegationEnabled
    ? [...commonTools, ...specialistTools, createDelegationTool(() => controller)]
    : [...commonTools, ...specialistTools].filter((tool) => tool.name !== "delegate_to_agent");
  const sessionOptions: ChatAgentOptions = {
    ...baseOptions,
    additionalTools,
    getSystemPromptTail: getSystemPromptTailForAgent
      ? getSystemPromptTail
      : options.getSystemPromptTail,
  };

  switch (agentId) {
    case "therapist":
      session = createTherapistChatAgent(sessionOptions);
      break;
    case "research":
      session = createResearchChatAgent(sessionOptions);
      break;
    case "general":
      session = createGeneralChatAgent(sessionOptions);
      break;
  }

  const applySpecialistToolPolicy = (activeAgent: ChatAgentId): void => {
    session.setToolAvailability(specialistToolNames, false);
    session.setToolAvailability(
      (additionalToolsByAgent[activeAgent] ?? []).map((tool) => tool.name),
      true,
    );
    session.setToolCapabilityPolicy(
      activeAgent === "research"
        ? {
            allowedToolNames: RESEARCH_CHAT_ALLOWED_TOOL_NAMES,
            allowedToolPrefixes: RESEARCH_CHAT_ALLOWED_TOOL_PREFIXES,
            unavailableMessage: (toolName) =>
              `${toolName} is unavailable while Research Agent is active.`,
          }
        : undefined,
    );
  };
  const controller: ChatAgentController = {
    current: agentId,
    async switchTo(nextAgent, notify) {
      if (nextAgent === controller.current) return false;
      controller.current = nextAgent;
      applySpecialistToolPolicy(nextAgent);
      session.setCustomSystemPrompt(
        buildChatAgentSystemPrompt(
          nextAgent,
          CHAT_AGENT_PROMPTS[nextAgent],
          options.cwd,
          delegationEnabled,
        ),
        `ggchat:${nextAgent}`,
      );
      if (notify) await options.onAgentChange?.(nextAgent);
      return true;
    },
  };
  applySpecialistToolPolicy(agentId);
  chatAgentControllers.set(session, controller);
  return session;
}

export function sessionsDirForChatAgent(coderSessionsDir: string, value: unknown): string {
  return chatAgentSessionsDir(coderSessionsDir, parseChatAgentId(value));
}
