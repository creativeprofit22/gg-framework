/**
 * What should happen to a programmatic submission (the commit button, the
 * Init-Git modal, the workspace folder picker) — as opposed to text the user
 * typed into the input, which `submit()` handles.
 *
 * This exists because the three states are easy to conflate and one of them was
 * wrong: a folder chosen from the native picker *while a run was in flight* was
 * silently dropped, so the dialog opened, the user picked a directory, and
 * nothing happened. Typed input never had that problem — it queues as steering.
 */
export type SubmitDisposition =
  /** Nothing to send, or the sidecar isn't ready yet. */
  | "ignore"
  /** Send immediately as a new run. */
  | "send"
  /** A run is in flight: queue as steering for the sidecar to inject mid-loop. */
  | "queue";

export function submitDisposition(
  text: string,
  ready: boolean,
  running: boolean,
): SubmitDisposition {
  if (!text.trim() || !ready) return "ignore";
  return running ? "queue" : "send";
}

/**
 * Should the bubble wear the "queued" look (dimmed, dashed border, pulsing
 * pill)?
 *
 * Queued styling is a promise that the message is WAITING. A prompt sent while
 * a question is on screen is not waiting: it releases the parked `ask_user`
 * call as it lands, so the agent consumes it within a frame or two. Dressing it
 * as queued made the bubble flash dim-and-dashed and then play the 300ms
 * promote animation immediately — a visible "broken, then fixed" render for a
 * message that was never really in the queue.
 */
export function showsQueuedBubble(
  disposition: SubmitDisposition,
  supersedesQuestion: boolean,
): boolean {
  return disposition === "queue" && !supersedesQuestion;
}

/**
 * Hide the same message from the queued strip above the composer.
 *
 * Same reason as the bubble, but the cost is worse: the strip is a SIBLING of
 * the transcript, so opening it (260ms) steals height from the thread and
 * closing it (220ms) gives it back. A message that supersedes a question is
 * consumed almost immediately, so the strip played open-then-shut in about half
 * a second and shoved the whole transcript up and back down with it.
 *
 * Matched by text and only ONE copy dropped: the sidecar assigns queue ids the
 * webview never sees, and messages the user genuinely queued — including an
 * identical repeat — must still be listed and cancellable.
 */
export function withoutSupersedingMessage<T extends { text: string }>(
  messages: readonly T[],
  supersedingText: string | null,
): readonly T[] {
  if (supersedingText === null) return messages;
  const index = messages.findIndex((m) => m.text === supersedingText);
  return index === -1 ? messages : [...messages.slice(0, index), ...messages.slice(index + 1)];
}
