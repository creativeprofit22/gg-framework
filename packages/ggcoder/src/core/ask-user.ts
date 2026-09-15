import { randomUUID } from "node:crypto";
import { ASK_USER_MAX_PENDING, isAskUserPrompt, type AskUserSettledEvent, type AskUserRequest, type AskUserPrompt } from "@kenkaiiii/gg-core/desktop-session-ux";
export type { AskOption, AskQuestionKind, AskQuestion, AskUserRequest, AskUserPrompt } from "@kenkaiiii/gg-core/desktop-session-ux";
import type { AskQuestion } from "@kenkaiiii/gg-core/desktop-session-ux";
import { createParkedRequests, type ParkedRequests } from "./parked-requests.js";

/**
 * How long an `ask_user` call waits before giving up on the user. The whole
 * turn is blocked meanwhile, so this is bounded — but generously, since the
 * user may be reading the reply the question belongs to.
 */
export const ASK_USER_TIMEOUT_MS = 10 * 60_000;

export type AskUserResult =
  | { action: "answer"; answers: Record<string, string | string[]> }
  /**
   * No answer. `superseded` means the user replied with a message of their own
   * instead of picking — the question is moot, but they are still talking.
   */
  | { action: "cancel"; superseded?: boolean };

export type AskUserBridge = ParkedRequests<AskUserRequest, AskUserResult>;

export function createAskUserBridge(opts: {
  broadcast: (prompt: AskUserPrompt) => void;
  onTimeout?: (prompt: AskUserPrompt) => void;
  onSettled?: (event: AskUserSettledEvent) => void;
  timeoutMs?: number;
}): AskUserBridge {
  // A delayed answer from a previous daemon/bridge can never address this one.
  const idPrefix = `ask-${randomUUID()}`;
  const bridge = createParkedRequests<AskUserRequest, AskUserResult>({
    idPrefix,
    broadcast: opts.broadcast,
    onSettled: (id, result) => opts.onSettled?.({ id, action: result.action }),
    cancelValue: () => ({ action: "cancel" }),
    timeoutMs: opts.timeoutMs ?? ASK_USER_TIMEOUT_MS,
    ...(opts.onTimeout ? { onTimeout: opts.onTimeout } : {}),
  });
  const park = bridge.park;
  bridge.park = async (request) => {
    const detached = structuredClone(request);
    if (bridge.pendingCount >= ASK_USER_MAX_PENDING ||
      !isAskUserPrompt({ ...detached, id: `${idPrefix}-${Number.MAX_SAFE_INTEGER}` })) {
      throw new Error("Question cannot be parked: invalid content or live-question limit exceeded.");
    }
    return park(detached);
  };
  return bridge;
}

/**
 * Render the user's answers as the tool result the model reads.
 *
 * Questions are echoed alongside their answers so the model never has to
 * remember what `store` meant, and an unanswered question is stated as such
 * rather than silently missing.
 */
export function formatAskResult(questions: AskQuestion[], result: AskUserResult): string {
  if (result.action === "cancel") {
    if (result.superseded) {
      return (
        "The user ignored the question and sent their own message instead. " +
        "It arrives next — treat it as their answer and continue. Do not ask this again."
      );
    }
    return (
      "The user did not answer (dismissed or timed out). Do not ask again — " +
      "state the assumption you are proceeding with, or stop and wait for them."
    );
  }
  const lines = questions.map((q) => {
    const answer = result.answers[q.id];
    const text = Array.isArray(answer) ? answer.join(", ") : answer;
    return `${q.question}\n→ ${text?.trim() ? text.trim() : "(no answer)"}`;
  });
  return `The user answered:\n\n${lines.join("\n\n")}`;
}
