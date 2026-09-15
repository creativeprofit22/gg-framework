/**
 * Shape of the sidecar's `ask_user` frame, kept free of Tauri imports so the
 * event machine (and its tests) can validate a frame without booting a webview.
 * The IPC call that answers one lives in `agent.ts`.
 */

import type { AskQuestion, AskUserPrompt } from "@kenkaiiii/gg-core/desktop-session-ux";
import type { Item } from "./App";
export { isAskUserPrompt, type AskOption, type AskQuestion, type AskUserPrompt } from "@kenkaiiii/gg-core/desktop-session-ux";

export type AskAnswers = Record<string, string | string[]>;

/** Local edits only: undefined reopens a question and is never sent as an answer. */
export type AskAnswerDelta = Record<string, string | string[] | undefined>;

/**
 * Merge newly answered questions into a band's answers, and report whether the
 * band is now complete.
 *
 * The band is the unit of answer: the parked tool call settles only once EVERY
 * question in it has one, so a half-filled form never lands on the agent. An
 * answer can arrive from a click or from the composer, which is why this rule
 * lives outside the band component.
 */
export function mergeAskAnswers(
  current: AskAnswers | undefined,
  delta: AskAnswerDelta,
  questions: readonly AskQuestion[],
): { answers: AskAnswers; complete: boolean } {
  const answers: AskAnswers = Object.fromEntries(
    Object.entries({ ...current, ...delta }).filter(
      (entry): entry is [string, string | string[]] => {
        const value = entry[1];
        return typeof value === "string"
          ? value.trim().length > 0
          : value !== undefined &&
              value.length > 0 &&
              value.every((pick) => pick.trim().length > 0);
      },
    ),
  );
  return {
    answers,
    complete: questions.every((q) => Object.prototype.hasOwnProperty.call(answers, q.id)),
  };
}

/**
 * Drop the question bands a freshly sent prompt supersedes.
 *
 * Sending a message of your own IS the answer: the sidecar releases the parked
 * tool call the moment that prompt arrives, so an open band is left pointing at
 * a question nobody is waiting on — its buttons would silently do nothing. A
 * band that already reached the agent (`sent`) or was closed by a cancelled run
 * (`cancelled`) is transcript history and stays put.
 */
export function dropSupersededAsks<T extends { kind: string; sent?: boolean; cancelled?: boolean }>(
  items: readonly T[],
): T[] {
  return items.filter((it) => !(it.kind === "ask" && it.sent !== true && it.cancelled !== true));
}

/** Compare the displayed contract, independent of JSON property order. */
function sameAskPrompt(a: AskUserPrompt, b: AskUserPrompt): boolean {
  return a.id === b.id && a.questions.length === b.questions.length && a.questions.every((q, i) => {
    const other = b.questions[i]!;
    return q.id === other.id && q.question === other.question && q.kind === other.kind &&
      q.detail === other.detail && q.allowOther === other.allowOther &&
      (q.options === undefined ? other.options === undefined :
        other.options !== undefined && q.options.length === other.options.length &&
        q.options.every((option, j) => {
          const compared = other.options![j]!;
          return option.label === compared.label && option.value === compared.value &&
            option.hint === compared.hint && option.recommended === compared.recommended;
        }));
  });
}

/** Reconcile display state only. Never send, infer, or replay an answer. */
export function reconcilePendingAsks(
  items: Item[],
  prompts: readonly AskUserPrompt[],
  nextId: () => number,
): Item[] {
  const pending = new Map(prompts.map((prompt) => [prompt.id, prompt]));
  const seen = new Set<string>();
  const result = items.flatMap((item): Item[] => {
    if (item.kind !== "ask") return [item];
    const prompt = pending.get(item.prompt.id);
    if (!prompt) return [item.sent || item.cancelled ? item : { ...item, cancelled: true }];
    if (seen.has(prompt.id)) return [];
    seen.add(prompt.id);
    // Preserve row identity (including component-local drafts) only for the exact live prompt.
    if (!item.sent && !item.cancelled && sameAskPrompt(item.prompt, prompt))
      return [item];
    return [{ kind: "ask", id: nextId(), prompt }];
  });
  for (const prompt of prompts) {
    if (!seen.has(prompt.id)) result.push({ kind: "ask", id: nextId(), prompt });
  }
  return result;
}
