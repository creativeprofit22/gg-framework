import { randomUUID } from "node:crypto";
import {
  ASK_USER_MAX_PENDING,
  isAskUserPrompt,
  type AskUserSettledEvent,
  type AskUserRequest,
  type AskUserPrompt,
} from "@kenkaiiii/gg-core/desktop-session-ux";
export type {
  AskOption,
  AskQuestionKind,
  AskQuestion,
  AskUserRequest,
  AskUserPrompt,
} from "@kenkaiiii/gg-core/desktop-session-ux";
import type { AskQuestion } from "@kenkaiiii/gg-core/desktop-session-ux";

/**
 * Soft deadline for an `ask_user` call when someone is likely watching (a
 * plain interactive run). Past it the tool stops blocking: the agent proceeds
 * on its best guess while the question stays answerable in the app.
 */
export const ASK_USER_INTERACTIVE_DEADLINE_MS = 10 * 60_000;

/**
 * Soft deadline when nobody is watching — autopilot (Ken), task run-all
 * sweeps and scheduled prompts. Short, so an unattended run does not stall.
 */
export const ASK_USER_UNATTENDED_DEADLINE_MS = 2 * 60_000;

/**
 * The longest an `ask_user` call can block (the largest soft deadline). The
 * tool's own execution timeout is derived from this.
 */
export const ASK_USER_TIMEOUT_MS = Math.max(
  ASK_USER_INTERACTIVE_DEADLINE_MS,
  ASK_USER_UNATTENDED_DEADLINE_MS,
);

/** Pick the soft deadline for a run, by whether a human is likely watching. */
export function askSoftDeadlineMs(unattended: boolean): number {
  return unattended ? ASK_USER_UNATTENDED_DEADLINE_MS : ASK_USER_INTERACTIVE_DEADLINE_MS;
}

/**
 * The tool result when the run is stopped while the question is still open.
 * A stop defers the ask rather than cancelling it, so the card stays
 * answerable and a reply comes back via `formatLateAnswer`. Worded "may" because
 * the same text also repairs restored transcripts, where the card is gone.
 */
export const ASK_USER_INTERRUPTED_TEXT =
  "No answer yet: the run was stopped while it was still waiting on the user, so no answer " +
  "was received. Do not assume one. The question may still be open; a later reply arrives " +
  'as a message starting "Late answer to:", so do not ask the same question again.';

export type AskUserResult =
  | { action: "answer"; answers: Record<string, string | string[]> }
  /**
   * No answer. `superseded` means the user replied with a message of their own
   * instead of picking — the question is moot, but they are still talking.
   */
  | { action: "cancel"; superseded?: boolean }
  /**
   * No answer yet: the soft deadline passed or the run was stopped
   * (`deferAll`). The question stays open; a later answer is delivered to the
   * agent as a message (see `onLateAnswer`).
   */
  | { action: "deferred" };

/** An answer that arrived after the tool call had already moved on. */
export interface LateAskAnswer {
  prompt: AskUserPrompt;
  answers: Record<string, string | string[]>;
}

/**
 * Questions parked on the user. A question is either *pending* (the tool call
 * is blocked on it) or *deferred* (its soft deadline passed or the run that
 * asked it was stopped, the agent moved on, but the user can still answer it).
 */
export interface AskUserBridge {
  /**
   * Park a question: broadcasts it, resolves on answer, cancel or soft deadline.
   * `defer: false` keeps the pre-deadline contract for this question: the
   * deadline cancels it instead of leaving it open for a late answer.
   */
  park: (request: AskUserRequest, options?: AskParkOptions) => Promise<AskUserResult>;
  /**
   * Answer or dismiss an open question. A deferred question's answer goes to
   * `onLateAnswer`. False when the id is not open (settled, superseded, closed).
   */
  settle: (id: string, result: AskUserResult) => boolean;
  /**
   * Release every pending question with `result` (default: cancel) and close
   * every deferred one — for a superseding user message, teardown. Run abort
   * uses `deferAll` instead, so its questions stay answerable.
   */
  cancelAll: (result?: AskUserResult) => void;
  /**
   * The run stopped (abort, error) while questions were blocking it: release
   * every pending question but keep it answerable, as if its soft deadline had
   * passed. A later answer is delivered through `onLateAnswer`. Questions that
   * cannot be deferred (no `onLateAnswer`, or parked with `defer: false`) are
   * cancelled instead.
   */
  deferAll: () => void;
  /** Close deferred questions without touching a pending one (session reset). */
  closeDeferred: () => void;
  /** Questions the turn is currently blocked on. */
  readonly pendingCount: number;
  /** Questions past their soft deadline that can still be answered. */
  readonly deferredCount: number;
  /** Detached snapshots of blocking prompts; settled/deferred ones are never included. */
  readonly pendingRequests: AskUserPrompt[];
  /** Detached snapshots of deferred prompts that still accept a late answer. */
  readonly deferredRequests: AskUserPrompt[];
}

export interface AskParkOptions {
  /** Allow this question to outlive its soft deadline (default: true when late answers are deliverable). */
  defer?: boolean;
}

export interface AskUserBridgeOptions {
  broadcast: (prompt: AskUserPrompt) => void;
  /** Soft deadline in ms, read when each question is parked. */
  timeoutMs?: number | (() => number);
  /**
   * The soft deadline passed. `deferred` is true when the question stays open
   * for a late answer, false when deferral is off and it was cancelled.
   */
  onTimeout?: (prompt: AskUserPrompt, deferred: boolean) => void;
  /** A pending question became deferred (soft deadline or `deferAll`). */
  onDeferred?: (prompt: AskUserPrompt) => void;
  /**
   * A deferred question was answered. Called at most once per question.
   * Without it there is nowhere to deliver a late answer, so the deadline
   * cancels the question instead of deferring it.
   */
  onLateAnswer?: (late: LateAskAnswer) => void;
  /** Deferred questions closed without an answer (superseded, cancelled, reset). */
  onClosed?: (ids: string[]) => void;
  /** A question was answered or dismissed (including a deferred one). Must not throw. */
  onSettled?: (event: AskUserSettledEvent) => void;
}

export function createAskUserBridge(opts: AskUserBridgeOptions): AskUserBridge {
  const pending = new Map<
    string,
    {
      prompt: AskUserPrompt;
      resolve: (result: AskUserResult) => void;
      timer: ReturnType<typeof setTimeout>;
      defer: boolean;
    }
  >();
  const deferred = new Map<string, AskUserPrompt>();
  // A delayed answer from a previous daemon/bridge can never address this one.
  const idPrefix = `ask-${randomUUID()}`;
  let seq = 0;

  const deadline = (): number => {
    const t = opts.timeoutMs;
    if (typeof t === "function") return t();
    return t ?? ASK_USER_INTERACTIVE_DEADLINE_MS;
  };

  const notifySettled = (id: string, result: AskUserResult): void => {
    if (result.action !== "deferred") opts.onSettled?.({ id, action: result.action });
  };

  const release = (id: string, result: AskUserResult): boolean => {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(result);
    notifySettled(id, result);
    return true;
  };

  const defer = (prompt: AskUserPrompt): void => {
    deferred.set(prompt.id, prompt);
    release(prompt.id, { action: "deferred" });
    opts.onDeferred?.(prompt);
  };

  const closeDeferred = (): void => {
    if (deferred.size === 0) return;
    const ids = [...deferred.keys()];
    deferred.clear();
    opts.onClosed?.(ids);
  };

  return {
    park: async (request, options) => {
      const detached = structuredClone(request);
      if (
        pending.size >= ASK_USER_MAX_PENDING ||
        !isAskUserPrompt({ ...detached, id: `${idPrefix}-${Number.MAX_SAFE_INTEGER}` })
      ) {
        throw new Error(
          "Question cannot be parked: invalid content or live-question limit exceeded.",
        );
      }
      const deferrable = (options?.defer ?? true) && opts.onLateAnswer !== undefined;
      return new Promise<AskUserResult>((resolve) => {
        // A newer question supersedes any older one still waiting past its
        // deadline: the agent has moved on to a new decision point.
        closeDeferred();
        const prompt: AskUserPrompt = { ...detached, id: `${idPrefix}-${++seq}` };
        const timer = setTimeout(() => {
          if (!pending.has(prompt.id)) return;
          opts.onTimeout?.(prompt, deferrable);
          if (!deferrable) {
            release(prompt.id, { action: "cancel" });
            return;
          }
          defer(prompt);
        }, deadline());
        timer.unref?.();
        pending.set(prompt.id, { prompt, resolve, timer, defer: deferrable });
        opts.broadcast(prompt);
      });
    },
    settle: (id, result) => {
      if (release(id, result)) return true;
      const prompt = deferred.get(id);
      if (!prompt) return false;
      deferred.delete(id);
      notifySettled(id, result);
      if (result.action === "answer") opts.onLateAnswer?.({ prompt, answers: result.answers });
      return true;
    },
    cancelAll: (result) => {
      for (const id of [...pending.keys()]) release(id, result ?? { action: "cancel" });
      closeDeferred();
    },
    deferAll: () => {
      for (const [id, entry] of [...pending.entries()]) {
        if (entry.defer) defer(entry.prompt);
        else release(id, { action: "cancel" });
      }
    },
    closeDeferred,
    get pendingCount() {
      return pending.size;
    },
    get deferredCount() {
      return deferred.size;
    },
    get pendingRequests() {
      return structuredClone([...pending.values()].map(({ prompt }) => prompt));
    },
    get deferredRequests() {
      return structuredClone([...deferred.values()]);
    },
  };
}

/**
 * A view of `bridge` whose questions never outlive their deadline. For
 * questions whose late answer must not arrive as a free-form user message —
 * e.g. host reviews that authorize side effects.
 */
/**
 * Whether a prompt sent to a busy session steers the run in flight. Only a
 * reply to a question the run is still blocked on (pending, not deferred) or a
 * Ken-sent correction steers; every other prompt waits in the visible queue.
 * Read it before superseding the questions: superseding empties `pending`.
 */
export function promptSteersRun(
  bridge: Pick<AskUserBridge, "pendingCount">,
  kenSent: boolean,
): boolean {
  return bridge.pendingCount > 0 || kenSent;
}

export function withoutDeferral(bridge: AskUserBridge): AskUserBridge {
  return {
    park: (request, options) => bridge.park(request, { ...options, defer: false }),
    settle: (id, result) => bridge.settle(id, result),
    cancelAll: (result) => bridge.cancelAll(result),
    deferAll: () => bridge.deferAll(),
    closeDeferred: () => bridge.closeDeferred(),
    get pendingCount() {
      return bridge.pendingCount;
    },
    get deferredCount() {
      return bridge.deferredCount;
    },
    get pendingRequests() {
      return bridge.pendingRequests;
    },
    get deferredRequests() {
      return bridge.deferredRequests;
    },
  };
}

/**
 * What the model reads when the soft deadline passes. Short on purpose; the
 * safety line is the part that matters — a guessed answer must never license
 * an action the user cannot take back.
 */
export const ASK_DEFERRED_RESULT =
  "No answer yet — the user has not responded. Do not wait and do not ask again: proceed " +
  "on your best judgment and state the assumption you made. The question stays open; a " +
  'later reply arrives as a message starting "Late answer to:". On a guessed answer do only ' +
  "safe, reversible work. Do NOT delete data, push, publish, deploy, pay, send messages or " +
  "take any other destructive, costly or externally visible action — leave those for the user.";

/**
 * Render the user's answers as the tool result the model reads.
 *
 * Questions are echoed alongside their answers so the model never has to
 * remember what `store` meant, and an unanswered question is stated as such
 * rather than silently missing.
 */
export function formatAskResult(questions: AskQuestion[], result: AskUserResult): string {
  if (result.action === "deferred") return ASK_DEFERRED_RESULT;
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

/**
 * Frame a late answer as a message to the agent. It names the question it
 * answers, because by now the agent has moved on and may have asked others.
 */
export function formatLateAnswer(late: LateAskAnswer): string {
  const body = late.prompt.questions
    .map((q) => {
      const answer = late.answers[q.id];
      const text = Array.isArray(answer) ? answer.join(", ") : answer;
      return `Late answer to: ${q.question}\n→ ${text?.trim() ? text.trim() : "(no answer)"}`;
    })
    .join("\n\n");
  return (
    `${body}\n\n` +
    "(You asked this earlier and continued on an assumption. If this answer differs, " +
    "adjust the affected work; if it matches, carry on.)"
  );
}

/** Where a late answer goes: the host's existing user-message queue. */
export interface LateAnswerSink {
  /** Queue a user message; drained as mid-run steering by a live run. */
  queueMessage: (text: string) => number;
  /** True while a run (or a run-owning cycle) can still drain the queue. */
  isBusy: () => boolean;
  /** The queue changed (so clients can refresh their queued strip). */
  onQueued?: () => void;
  /** No run is live: start one from the queue (the host's stranded-queue drain). */
  startIdleRun: () => void;
}

/**
 * Deliver a late answer through the existing queue rather than a new channel:
 * a live run drains it at its next steering boundary; an idle session runs it
 * as the next user turn.
 */
export function deliverLateAnswer(late: LateAskAnswer, sink: LateAnswerSink): void {
  sink.queueMessage(formatLateAnswer(late));
  sink.onQueued?.();
  if (!sink.isBusy()) sink.startIdleRun();
}
