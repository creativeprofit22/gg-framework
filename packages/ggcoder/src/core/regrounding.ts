import type { Message } from "@kenkaiiii/gg-ai";

/**
 * Post-compaction re-grounding hook.
 *
 * Compaction summarizes earlier context, which is a known drift point: the
 * model can quietly lose the verbatim original ask or a subtle constraint.
 * After a compaction this run, inject the original request verbatim (the one
 * piece of ground truth the summary may have lossily rewritten) so the model
 * re-anchors before its next step. Fires at most once per compaction event.
 *
 * Per the "introspection alone fails" research, this injects concrete
 * evidence (the literal original request) rather than asking the model to
 * "think harder".
 */

export interface RegroundingState {
  /** A compaction/overflow-compaction happened during this run. */
  compactionOccurred: boolean;
  /** A re-grounding message was already injected for this compaction. */
  alreadyInjected: boolean;
}

export function shouldReground(state: RegroundingState): boolean {
  return state.compactionOccurred && !state.alreadyInjected;
}

export function buildRegroundingMessage(originalRequest: string): Message {
  const trimmed = originalRequest.trim();
  const pin =
    trimmed.length > 0
      ? `\n\nThe user's original request was:\n\n  ${trimmed}\n\n`
      : " The original request is in the earlier messages that remain. ";
  return {
    role: "user",
    provenance: { source: "runtime", kind: "continuation", visibility: "hidden" },
    content:
      "Re-ground. The conversation was just compacted, so earlier detail is now a summary and " +
      "easy to drift from." +
      pin +
      "Before continuing, re-anchor on two things: that original request, and the specific " +
      "objective you're working on right now. Verify your next step still serves the original " +
      "ask \u2014 not a reshaped or narrowed version of it. If the summary dropped a constraint, " +
      "file, or requirement you were tracking, recover it from the messages that remain before " +
      "acting. Then continue. Do not restate this note; just proceed correctly.",
  };
}
