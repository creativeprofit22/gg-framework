import {
  assertOpenAICodexContextProfileFitsUsage,
  getContextWindow,
  type OpenAICodexContextProfile,
} from "@kenkaiiii/gg-core/models";
import type { AppSidecarSessionMutationCoordinator } from "./app-sidecar-session-mutation.js";

interface ContextProfileSessionState {
  provider: string;
  model: string;
  accountId?: string;
}

export interface ContextProfileMutationResult {
  status: 200 | 400 | 409 | 500;
  body: {
    error?: string;
    openAICodexContextProfile?: OpenAICodexContextProfile;
    contextWindow?: number;
  };
}

export function parseContextProfileBody(body: unknown): OpenAICodexContextProfile | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const profile = (body as { profile?: unknown }).profile;
  return profile === "stable" || profile === "experimental" ? profile : null;
}

interface ContextProfileMutationOptions {
  profile: OpenAICodexContextProfile;
  state: ContextProfileSessionState;
  running: boolean;
  activeUsage: number;
  mutations: AppSidecarSessionMutationCoordinator;
  switchProfile: (profile: OpenAICodexContextProfile) => Promise<void>;
}

export async function runContextProfileRequest(
  options: Omit<ContextProfileMutationOptions, "profile"> & { body: unknown },
): Promise<ContextProfileMutationResult> {
  const { body, ...mutationOptions } = options;
  const profile = parseContextProfileBody(body);
  if (!profile) {
    return { status: 400, body: { error: 'profile must be "stable" or "experimental"' } };
  }
  return runContextProfileMutation({ ...mutationOptions, profile });
}

export async function runContextProfileMutation(
  options: ContextProfileMutationOptions,
): Promise<ContextProfileMutationResult> {
  const { profile, state, running, activeUsage, mutations, switchProfile } = options;
  if (state.provider !== "openai" || state.model !== "gpt-6-astra" || !state.accountId) {
    return {
      status: 409,
      body: {
        error: "Context profiles are available only for GPT-6 Astra through OpenAI Codex OAuth.",
      },
    };
  }
  if (running) {
    return {
      status: 409,
      body: { error: "Cannot change context profile while the agent is running." },
    };
  }

  const mutation = mutations.tryAcquire("context-profile");
  if (!mutation) return { status: 409, body: mutations.conflictBody() };

  try {
    try {
      assertOpenAICodexContextProfileFitsUsage(state.model, profile, activeUsage);
    } catch (error) {
      return {
        status: 409,
        body: { error: error instanceof Error ? error.message : String(error) },
      };
    }

    try {
      await switchProfile(profile);
    } catch (error) {
      return {
        status: 500,
        body: {
          error: `Could not save the context profile: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }

    const contextWindow = getContextWindow(state.model, {
      provider: "openai",
      accountId: state.accountId,
      openAICodexContextProfile: profile,
    });
    return {
      status: 200,
      body: { openAICodexContextProfile: profile, contextWindow },
    };
  } finally {
    mutation.release();
  }
}
