import {
  isOpenAICodexAstraSession,
  type OpenAICodexAstraSessionState,
} from "./app-sidecar-context-profile.js";
import type { AppSidecarSessionMutationCoordinator } from "./app-sidecar-session-mutation.js";

export interface OpenAICodexFastMutationResult {
  status: 200 | 400 | 409 | 500;
  body: { error?: string; openAICodexFast?: boolean };
}

export function parseOpenAICodexFastBody(body: unknown): boolean | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const enabled = (body as { enabled?: unknown }).enabled;
  return typeof enabled === "boolean" ? enabled : null;
}

interface OpenAICodexFastMutationOptions {
  enabled: boolean;
  state: OpenAICodexAstraSessionState;
  running: boolean;
  mutations: AppSidecarSessionMutationCoordinator;
  switchFast(enabled: boolean): Promise<void>;
}

export async function runOpenAICodexFastRequest(
  options: Omit<OpenAICodexFastMutationOptions, "enabled"> & { body: unknown },
): Promise<OpenAICodexFastMutationResult> {
  const { body, ...mutationOptions } = options;
  const enabled = parseOpenAICodexFastBody(body);
  if (enabled === null) return { status: 400, body: { error: "enabled must be a boolean" } };
  return runOpenAICodexFastMutation({ ...mutationOptions, enabled });
}

export async function runOpenAICodexFastMutation(
  options: OpenAICodexFastMutationOptions,
): Promise<OpenAICodexFastMutationResult> {
  const { enabled, state, running, mutations, switchFast } = options;
  if (!isOpenAICodexAstraSession(state)) {
    return {
      status: 409,
      body: { error: "Fast is available only for GPT-6 Astra through OpenAI Codex OAuth." },
    };
  }
  if (running) {
    return { status: 409, body: { error: "Cannot change Fast while the agent is running." } };
  }

  const mutation = mutations.tryAcquire("openai-codex-fast");
  if (!mutation) return { status: 409, body: mutations.conflictBody() };

  try {
    try {
      await switchFast(enabled);
    } catch (error) {
      return {
        status: 500,
        body: {
          error: `Could not save Fast: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
    return { status: 200, body: { openAICodexFast: enabled } };
  } finally {
    mutation.release();
  }
}
