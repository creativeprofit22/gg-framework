export const CHAT_AGENT_IDS = ["general", "therapist", "research"] as const;

export type ChatAgentId = (typeof CHAT_AGENT_IDS)[number];

export function parseChatAgentId(value: unknown): ChatAgentId {
  return typeof value === "string" && CHAT_AGENT_IDS.includes(value as ChatAgentId)
    ? (value as ChatAgentId)
    : "general";
}
