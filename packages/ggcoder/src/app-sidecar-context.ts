import type { DesktopContextSnapshot } from "@kenkaiiii/gg-core";
import type { DesktopSessionUXState } from "@kenkaiiii/gg-core/desktop-session-ux";
import { getContextWindow } from "./core/model-registry.js";
import type { AgentSessionState } from "./core/agent-session.js";

interface ContextSnapshotSession {
  getState(): Pick<
    AgentSessionState,
    | "accountId"
    | "openAICodexContextProfile"
    | "openAICodexFast"
    | "openAICodexContextProfileEligibility"
  >;
  getContextUsage(): { used: number; size: number };
}

export function getAgentSessionContextSnapshot(
  session: ContextSnapshotSession,
): DesktopContextSnapshot & DesktopSessionUXState {
  const state = session.getState();
  const usage = session.getContextUsage();
  return {
    accountId: state.accountId ?? null,
    openAICodexContextProfile: state.openAICodexContextProfile,
    openAICodexFast: state.openAICodexFast,
    openAICodexContextProfileEligibility: state.openAICodexContextProfileEligibility,
    contextTokens: usage.used,
    contextWindow: usage.size,
  };
}

export function getAgentSessionContextWindow(
  state: Pick<AgentSessionState, "model" | "provider" | "accountId" | "openAICodexContextProfile">,
): number {
  return getContextWindow(state.model, {
    provider: state.provider,
    accountId: state.accountId,
    openAICodexContextProfile: state.openAICodexContextProfile,
  });
}
