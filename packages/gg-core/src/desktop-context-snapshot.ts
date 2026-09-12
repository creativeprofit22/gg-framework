import type { DesktopSessionUXState } from "./desktop-session-ux.js";
import type { OpenAICodexContextProfile } from "./model-registry.js";

/** Authoritative context state included in every desktop session snapshot. */
export interface DesktopContextSnapshot extends DesktopSessionUXState {
  accountId: string | null;
  openAICodexContextProfile: OpenAICodexContextProfile;
  openAICodexFast: boolean;
  contextTokens: number;
  contextWindow: number;
}
