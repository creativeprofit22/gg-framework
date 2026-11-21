/** A failure split into what the user reads and what support needs. */
export interface FailureCopy {
  summary: string;
  /** Technical cause, shown collapsed; null when the summary already says it. */
  detail: string | null;
}

const MAX_NAME_LENGTH = 60;

/** Quote a session name for a sentence, truncated so one long title can't swamp the banner. */
function quoteName(name: string): string {
  const flat = name.replace(/\s+/g, " ").trim();
  const short =
    flat.length > MAX_NAME_LENGTH ? `${flat.slice(0, MAX_NAME_LENGTH - 1).trimEnd()}\u2026` : flat;
  return `\u201c${short}\u201d`;
}

/**
 * Turn a pane/daemon startup error into plain words. Internal lifecycle
 * messages (`pane '…' …`, other than a wrapped actionable cause) name pane IDs and generations that mean nothing to
 * the user, so they move under Details; actionable causes such as sign-in
 * stay in the visible sentence. When `sessionName` is given, the summary names
 * the session so the user can tell which row failed.
 */
export function describeOpenFailure(message: string, sessionName?: string): FailureCopy {
  const name = sessionName?.trim() ? quoteName(sessionName) : null;
  const target = name ?? "this session";
  const cleaned = message
    .replace(/Run ["'`]?ggcoder login["'`]?/gi, "Use AI Providers to sign in")
    .replace(/ggcoder login/gi, "AI Providers")
    .trim();
  if (/^pane '[^']*' did not start in time$/.test(cleaned)) {
    const subject = name ?? "This session";
    return { summary: `${subject} took too long to start. Please try again.`, detail: cleaned };
  }
  // The pane client wraps the daemon's own startup error, which may already be
  // user guidance (sign-in, provider, project path). Show that cause unless it
  // is itself an internal lifecycle message or the event's empty fallback.
  const wrapped = /^pane '[^']*' failed to start: (.+)$/s.exec(cleaned);
  const cause = wrapped?.[1]?.trim();
  if (cause && !/^pane '[^']*'/.test(cause) && cause.toLowerCase() !== "unknown error") {
    return { summary: `Couldn\u2019t open ${target}: ${cause}`, detail: null };
  }
  if (
    /^pane '[^']*'/.test(cleaned) ||
    /^failed to listen for pane '[^']*' readiness/.test(cleaned) ||
    cleaned === ""
  ) {
    return {
      summary: `Couldn\u2019t open ${target}. Please try again.`,
      detail: cleaned || null,
    };
  }
  return { summary: `Couldn\u2019t open ${target}: ${cleaned}`, detail: null };
}

/**
 * Plain-words copy for a failed picker action (listing, adding a folder,
 * importing). The raw reason is kept for bug reports under Details rather than
 * leading the sentence.
 */
export function describeActionFailure(action: string, reason: unknown): FailureCopy {
  const raw = reason instanceof Error ? reason.message : reason == null ? "" : String(reason);
  const detail = raw.trim();
  return { summary: `Couldn\u2019t ${action}. Please try again.`, detail: detail || null };
}
