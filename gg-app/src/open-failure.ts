/**
 * Turn a pane/daemon startup error into plain words. Internal lifecycle
 * messages (`pane '…' …`, other than a wrapped actionable cause) name pane IDs and generations that mean nothing to
 * the user, so they move under Details; actionable causes such as sign-in
 * stay in the visible sentence.
 */
export function describeOpenFailure(message: string): { summary: string; detail: string | null } {
  const cleaned = message
    .replace(/Run ["'`]?ggcoder login["'`]?/gi, "Use AI Providers to sign in")
    .replace(/ggcoder login/gi, "AI Providers")
    .trim();
  if (/^pane '[^']*' did not start in time$/.test(cleaned)) {
    return { summary: "This session took too long to start. Please try again.", detail: cleaned };
  }
  // The pane client wraps the daemon's own startup error, which may already be
  // user guidance (sign-in, provider, project path). Show that cause unless it
  // is itself an internal lifecycle message or the event's empty fallback.
  const wrapped = /^pane '[^']*' failed to start: (.+)$/s.exec(cleaned);
  const cause = wrapped?.[1]?.trim();
  if (cause && !/^pane '[^']*'/.test(cause) && cause.toLowerCase() !== "unknown error") {
    return { summary: `Couldn\u2019t open this session: ${cause}`, detail: null };
  }
  if (
    /^pane '[^']*'/.test(cleaned) ||
    /^failed to listen for pane '[^']*' readiness/.test(cleaned) ||
    cleaned === ""
  ) {
    return {
      summary: "Couldn\u2019t open this session. Please try again.",
      detail: cleaned || null,
    };
  }
  return { summary: `Couldn\u2019t open this session: ${cleaned}`, detail: null };
}
