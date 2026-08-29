import { createParkedRequests, type ParkedRequests } from "./parked-requests.js";

/**
 * How long an `ask_user` call waits before giving up on the user. The whole
 * turn is blocked meanwhile, so this is bounded — but generously, since the
 * user may be reading the reply the question belongs to.
 */
export const ASK_USER_TIMEOUT_MS = 10 * 60_000;

/** One selectable answer. `value` is what the agent gets back; `label` is UI. */
export interface AskOption {
  label: string;
  value?: string;
  /** One short line under the label, for rows the user has to weigh up. */
  hint?: string;
  /** Marks the agent's recommendation. Tagged in the UI, never preselected. */
  recommended?: boolean;
}

export type AskQuestionKind = "confirm" | "choice" | "multi" | "text";

export interface AskQuestion {
  /** Stable key this question's answer is returned under. */
  id: string;
  question: string;
  kind: AskQuestionKind;
  /** Optional one-line elaboration shown under the question. */
  detail?: string;
  /** Choices for `choice`/`multi`. `confirm` defaults to Yes/No when omitted. */
  options?: AskOption[];
  /** Whether the free-text escape is offered (default true, forced on `text`). */
  allowOther?: boolean;
}

export interface AskUserRequest {
  questions: AskQuestion[];
}

/** The frame a host broadcasts so its UI can render the band. */
export interface AskUserPrompt extends AskUserRequest {
  id: string;
}

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
  timeoutMs?: number;
}): AskUserBridge {
  return createParkedRequests<AskUserRequest, AskUserResult>({
    idPrefix: "ask",
    broadcast: opts.broadcast,
    cancelValue: () => ({ action: "cancel" }),
    timeoutMs: opts.timeoutMs ?? ASK_USER_TIMEOUT_MS,
    ...(opts.onTimeout ? { onTimeout: opts.onTimeout } : {}),
  });
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
