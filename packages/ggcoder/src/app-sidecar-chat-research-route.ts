import type { SlashCommandsResponse } from "@kenkaiiii/gg-core";
import {
  APP_SIDECAR_CHAT_COMMANDS,
  executeChatResearchHandoff,
  type ChatResearchHandoffOperations,
} from "./app-sidecar-chat-research-handoff.js";
import type { resolveChatResearchCommandRoute } from "./app-sidecar-chat-research-handoff.js";

export interface ChatResearchHttpResponse {
  status: number;
  body: unknown;
}

export interface AppSidecarChatResearchPromptOptions<Session> {
  route: ReturnType<typeof resolveChatResearchCommandRoute>;
  operations: ChatResearchHandoffOperations<Session>;
  claimStart(): boolean;
  respond(response: ChatResearchHttpResponse): void;
  runAgent(displayText: string, run: () => Promise<void>): Promise<void>;
}

/** Return the isolated chat catalog, or null so coding command discovery continues unchanged. */
export function appSidecarChatCommandsResponse(
  mode: "code" | "chat",
): SlashCommandsResponse | null {
  return mode === "chat"
    ? { commands: APP_SIDECAR_CHAT_COMMANDS.map((command) => ({ ...command, aliases: [...command.aliases] })) }
    : null;
}

/**
 * Execute a Research route already classified at the raw POST /prompt boundary.
 * Returns false only when the caller must continue through ordinary command expansion.
 */
export async function handleAppSidecarChatResearchPrompt<Session>(
  options: AppSidecarChatResearchPromptOptions<Session>,
): Promise<boolean> {
  const { route } = options;
  if (route.kind === "pass") return false;

  if (route.kind === "reject") {
    options.respond({ status: route.status, body: route.body });
    return true;
  }

  if (!options.claimStart()) {
    options.respond({
      status: 409,
      body: {
        error: "research_session_busy",
        message: "Wait for the current chat run to finish, then retry /research.",
      },
    });
    return true;
  }

  options.respond({ status: 202, body: { queued: false, count: 0 } });
  await options.runAgent(route.command.displayText, () =>
    executeChatResearchHandoff(route, options.operations),
  );
  return true;
}
