import { getContextWindow } from "./core/model-registry.js";
import type { AgentSessionState } from "./core/agent-session.js";

export function getAgentSessionContextWindow(
  state: Pick<
    AgentSessionState,
    "model" | "provider" | "accountId" | "openAICodexContextProfile"
  >,
): number {
  return getContextWindow(state.model, {
    provider: state.provider,
    accountId: state.accountId,
    openAICodexContextProfile: state.openAICodexContextProfile,
  });
}
