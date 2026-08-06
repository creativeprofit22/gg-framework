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
