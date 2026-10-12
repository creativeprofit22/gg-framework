/**
 * Shape of the sidecar's `ask_user` frame, kept free of Tauri imports so the
 * event machine (and its tests) can validate a frame without booting a webview.
 * The IPC call that answers one lives in `agent.ts`.
 */

import {
  isAskUserPrompt,
  type AskQuestion,
  type AskUserPrompt,
} from "@kenkaiiii/gg-core/desktop-session-ux";
import type { Item } from "./App";
export {
  isAskUserPrompt,
  type AskOption,
  type AskQuestion,
  type AskUserPrompt,
} from "@kenkaiiii/gg-core/desktop-session-ux";

export type AskAnswers = Record<string, string | string[]>;

/** Local edits only: undefined reopens a question and is never sent as an answer. */
export type AskAnswerDelta = Record<string, string | string[] | undefined>;

/**
 * Merge newly answered questions into a band's answers, and report whether the
 * band is now complete.
 *
 * The band is the unit of answer. `complete` is true only once EVERY question
 * has an answer, and the band then settles the parked tool call on its own.
 * A multi-question band's explicit Send (`sendNow`, handled by the pane's ask
 * answer handler) also settles it early with a partial answer set; each
 * question left open reaches the agent as "(no answer)" via the daemon's
 * `formatAskResult`. Keep that partial path: without it a card the user chose
 * not to finish would sit unsent and the turn would hang. An answer can arrive
 * from a click or from the composer, which is why this merge lives outside the
 * band component.
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
 * Whether an answer POST failed because nothing is waiting for it any more: the
 * run was stopped, the question timed out, or the daemon restarted. Retrying
 * cannot help, so the band must say it expired instead of staying clickable.
 */
export function isExpiredAskError(error: unknown): boolean {
  return /no question is awaiting an answer/i.test(String(error));
}

/**
 * Record answers for the band `itemId`. When that completes it, the answered
 * band leaves its spot and is re-added at the END of the conversation under a
 * fresh id, so the answer lands below everything the agent said meanwhile, the
 * way a sent prompt does (it rendered where the question was asked, often far
 * above the view, so it looked as if nothing was sent). The fresh id makes it a
 * new row: it dissolves in like any other. `answeredLive` tells the band it
 * mounted already answered because it was answered just now (its shimmer marks
 * that), not because it was restored. Returns the complete answers when this
 * call completed the band, so the caller can send them.
 */
export function answerAskItem<
  T extends {
    kind: string;
    id: number;
    sent?: boolean;
    answers?: AskAnswers;
    answeredLive?: boolean;
    prompt?: unknown;
  },
>(
  items: readonly T[],
  itemId: number,
  delta: AskAnswers,
  questionsOf: (item: T) => readonly AskQuestion[],
  nextId: () => number,
): { items: T[]; completed: AskAnswers | null } {
  const index = items.findIndex((it) => it.kind === "ask" && it.id === itemId && !it.sent);
  const item = items[index];
  if (index < 0 || item === undefined) return { items: [...items], completed: null };
  const { answers, complete } = mergeAskAnswers(item.answers, delta, questionsOf(item));
  if (!complete) {
    const next = [...items];
    next[index] = { ...item, answers };
    return { items: next, completed: null };
  }
  const rest = items.filter((_, i) => i !== index);
  return {
    items: [...rest, { ...item, id: nextId(), answers, sent: true, answeredLive: true }],
    completed: answers,
  };
}

/** The oldest question band still waiting on an answer, if any. */
export function firstOpenAskId<
  T extends { kind: string; id: number; sent?: boolean; cancelled?: boolean },
>(items: readonly T[]): number | null {
  return items.find((it) => it.kind === "ask" && !it.sent && !it.cancelled)?.id ?? null;
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
  return (
    a.id === b.id &&
    a.questions.length === b.questions.length &&
    a.questions.every((q, i) => {
      const other = b.questions[i]!;
      return (
        q.id === other.id &&
        q.question === other.question &&
        q.kind === other.kind &&
        q.detail === other.detail &&
        q.allowOther === other.allowOther &&
        (q.options === undefined
          ? other.options === undefined
          : other.options !== undefined &&
            q.options.length === other.options.length &&
            q.options.every((option, j) => {
              const compared = other.options![j]!;
              return (
                option.label === compared.label &&
                option.value === compared.value &&
                option.hint === compared.hint &&
                option.recommended === compared.recommended
              );
            }))
      );
    })
  );
}

/**
 * Reconcile display state only. Never send, infer, or replay an answer.
 *
 * `deferredPrompts` are questions no turn is blocked on that still accept a
 * late answer. `undefined` (a daemon that does not report them) preserves
 * deferred cards as they are; an array is authoritative for them too.
 */
export function reconcilePendingAsks(
  items: Item[],
  prompts: readonly AskUserPrompt[],
  nextId: () => number,
  deferredPrompts?: readonly AskUserPrompt[],
): Item[] {
  const pending = new Map<string, { prompt: AskUserPrompt; deferred: boolean }>();
  for (const prompt of deferredPrompts ?? []) pending.set(prompt.id, { prompt, deferred: true });
  for (const prompt of prompts) pending.set(prompt.id, { prompt, deferred: false });
  const seen = new Set<string>();
  const card = (prompt: AskUserPrompt, deferred: boolean): Item =>
    deferred
      ? { kind: "ask", id: nextId(), prompt, deferred }
      : { kind: "ask", id: nextId(), prompt };
  const result = items.flatMap((item): Item[] => {
    if (item.kind !== "ask") return [item];
    const entry = pending.get(item.prompt.id);
    if (!entry) {
      if (item.sent || item.cancelled) return [item];
      if (item.deferred && deferredPrompts === undefined) return [item];
      return [{ ...item, cancelled: true }];
    }
    const { prompt, deferred } = entry;
    if (seen.has(prompt.id)) return [];
    seen.add(prompt.id);
    // Preserve row identity (including component-local drafts) only for the exact live prompt.
    if (!item.sent && !item.cancelled && sameAskPrompt(item.prompt, prompt)) {
      return [deferred && !item.deferred ? { ...item, deferred } : item];
    }
    return [card(prompt, deferred)];
  });
  for (const [id, { prompt, deferred }] of pending) {
    if (!seen.has(id)) result.push(card(prompt, deferred));
  }
  return result;
}

type AskItemLike = {
  kind: string;
  prompt?: unknown;
  sent?: boolean;
  cancelled?: boolean;
};

/** An unresolved question band whose prompt id is in `ids`. */
function isOpenAsk(it: AskItemLike, ids: ReadonlySet<string>): boolean {
  if (it.kind !== "ask" || it.sent === true || it.cancelled === true) return false;
  const prompt = it.prompt;
  if (typeof prompt !== "object" || prompt === null) return false;
  const id = (prompt as { id?: unknown }).id;
  return typeof id === "string" && ids.has(id);
}

/**
 * The question's soft deadline passed: the agent continued on its best guess,
 * but the band stays answerable — a later answer is sent as a message.
 */
export function markAskDeferred<T extends AskItemLike>(items: readonly T[], promptId: string): T[] {
  const ids = new Set([promptId]);
  return items.map((it) => (isOpenAsk(it, ids) ? { ...it, deferred: true } : it));
}

/**
 * On (re)connect: close every open question the sidecar can no longer take an
 * answer to (`open` is its list). After a daemon restart the old run is gone,
 * so its cards would otherwise stay up as buttons that reach no one.
 */
export function closeAsksNotIn<T extends AskItemLike>(
  items: readonly T[],
  open: readonly string[],
): T[] {
  const live = new Set(open);
  const stale = new Set<string>();
  for (const it of items) {
    if (it.kind !== "ask" || it.sent === true || it.cancelled === true) continue;
    const id = (it.prompt as { id?: unknown } | undefined)?.id;
    if (typeof id === "string" && !live.has(id)) stale.add(id);
  }
  return stale.size === 0 ? [...items] : closeAsks(items, [...stale]);
}

/** An open question as the sidecar lists it on (re)connect. */
export interface OpenAskPrompt {
  prompt: AskUserPrompt;
  deferred: boolean;
}

/** The sidecar's `openAskPrompts` list, dropping anything malformed. */
export function parseOpenAskPrompts(data: unknown): OpenAskPrompt[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { prompt, deferred } = entry as { prompt?: unknown; deferred?: unknown };
    return isAskUserPrompt(prompt) ? [{ prompt, deferred: deferred === true }] : [];
  });
}

/**
 * Show the cards for questions still waiting on the user that the transcript
 * has no card for. A reloaded window rebuilds its transcript from history,
 * which keeps the tool call but not the card, so the agent sat waiting on a
 * question nobody could see.
 */
export function withOpenAsks<T>(
  items: readonly T[],
  open: readonly OpenAskPrompt[],
  makeItem: (ask: OpenAskPrompt) => T,
): T[] {
  const shown = new Set<string>();
  for (const it of items as readonly AskItemLike[]) {
    if (it.kind !== "ask" || typeof it.prompt !== "object" || it.prompt === null) continue;
    const id = (it.prompt as { id?: unknown }).id;
    if (typeof id === "string") shown.add(id);
  }
  const missing = open.filter((ask) => !shown.has(ask.prompt.id));
  return missing.length === 0 ? [...items] : [...items, ...missing.map(makeItem)];
}

/** A transcript card for an open question listed by the sidecar. */
export function askItemFor(
  ask: OpenAskPrompt,
  id: number,
): { kind: "ask"; id: number; prompt: AskUserPrompt; deferred?: true } {
  return { kind: "ask", id, prompt: ask.prompt, ...(ask.deferred ? { deferred: true } : {}) };
}

/**
 * The sidecar closed questions nobody is waiting on any more (a newer question
 * or a new session superseded them). Their buttons would reach no one.
 */
export function closeAsks<T extends AskItemLike>(items: readonly T[], ids: readonly string[]): T[] {
  const closed = new Set(ids);
  return items.map((it) => (isOpenAsk(it, closed) ? { ...it, cancelled: true } : it));
}
