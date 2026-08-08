import {
  APP_SIDECAR_CHAT_COMMANDS,
  executeChatResearchHandoff,
  resolveChatResearchCommandRoute,
  type ChatResearchHandoffOperations,
} from "./app-sidecar-chat-research-handoff.js";

export interface ChatResearchHttpResponse {
  status: number;
  body: unknown;
}

export interface AppSidecarChatResearchPromptOptions<Session> {
  mode: "code" | "chat";
  text: string;
  attachmentCount: number;
  busy: boolean;
  operations: ChatResearchHandoffOperations<Session>;
  claimStart(): boolean;
  respond(response: ChatResearchHttpResponse): void;
  runAgent(displayText: string, run: () => Promise<void>): Promise<void>;
}

/** Return the isolated chat catalog, or null so coding command discovery continues unchanged. */
export function appSidecarChatCommandsResponse(
  mode: "code" | "chat",
): { commands: typeof APP_SIDECAR_CHAT_COMMANDS } | null {
  return mode === "chat" ? { commands: APP_SIDECAR_CHAT_COMMANDS } : null;
}

/**
 * Own the `/research` branch at the parsed POST /prompt boundary.
 * Returns false only when the caller must continue through its ordinary prompt path.
 */
export async function handleAppSidecarChatResearchPrompt<Session>(
  options: AppSidecarChatResearchPromptOptions<Session>,
): Promise<boolean> {
  const route = resolveChatResearchCommandRoute({
    mode: options.mode,
    text: options.text,
    attachmentCount: options.attachmentCount,
    busy: options.busy,
  });
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
