import { useEffect, useState } from "react";
import { openUrl, type GitHubCI } from "./agent";
import { ShimmerText } from "./ShimmerText";

const sinceFormat = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

function refusedSince(ci: GitHubCI): string | null {
  const at = ci.lastSuccessAt ? Date.parse(ci.lastSuccessAt) : NaN;
  return Number.isFinite(at) ? sinceFormat.format(at) : null;
}

/**
 * Only runs observed in flight get a completion indicator; old history stays hidden.
 * CI that GitHub refused to start always shows and can't be dismissed: nothing ran.
 */
export function CIIndicator({ ci }: { ci?: GitHubCI | null }): React.ReactElement | null {
  const [trackedKey, setTrackedKey] = useState<string | null>(null);
  const [hiddenKey, setHiddenKey] = useState<string | null>(null);
  const key = ci?.key ?? null;
  const active = ci?.active ?? false;
  const refused = ci?.conclusion === "not_started";
  const failure = !refused && ((ci?.failed ?? 0) > 0 || ci?.conclusion === "failure");
  const stale = ci?.stale ?? false;

  useEffect(() => {
    if (active && !stale) {
      setTrackedKey(key);
      setHiddenKey(null);
    } else {
      // A different commit/run invalidates observation of the previous one.
      // Stale snapshots cannot establish that this pane saw a run in flight.
      setTrackedKey((previous) => (previous === key ? previous : null));
    }
  }, [key, active, stale]);

  useEffect(() => {
    if (!key || key !== trackedKey || active || failure || refused || stale || hiddenKey === key)
      return;
    const timer = setTimeout(() => setHiddenKey(key), 10_000);
    return () => clearTimeout(timer);
  }, [key, trackedKey, active, failure, refused, stale, hiddenKey]);

  // The same key can be reclassified as refused after a dismissal; refused CI is never hideable.
  if (!ci || (hiddenKey === key && !refused) || (!active && !refused && trackedKey !== key))
    return null;
  const status = stale
    ? "unavailable"
    : refused
      ? "not-started"
      : failure
        ? "failed"
        : active
          ? "running"
          : ci.conclusion === "success"
            ? "passed"
            : "stopped";
  const count = ci.total > 0 ? `${ci.completed}/${ci.total}` : "queued";
  const since = refused ? refusedSince(ci) : null;
  const refusedLabel = since ? `CI hasn't run since ${since}` : "CI not starting";
  const streak = ci.notStartedStreak ?? 0;
  const label = stale
    ? "CI unavailable"
    : refused
      ? refusedLabel
      : `CI ${count}${status === "running" ? "" : ` ${status}`}`;
  const description = stale
    ? "CI updates unavailable. Last known result may be out of date."
    : refused
      ? `${refusedLabel}: GitHub refused to start it (${
          streak > 0
            ? `${streak >= 10 ? "10+" : streak} run${streak === 1 ? "" : "s"} in a row; `
            : ""
        }check billing or spending limit).`
      : `CI ${status}: ${ci.completed} of ${ci.total} jobs complete${failure ? `, ${ci.failed} failed` : ""}.`;

  return (
    <span className="chat-head-ci" data-status={status} role="status" aria-live="polite">
      <span className="chat-head-sep" aria-hidden="true">
        {"│"}
      </span>
      <button
        type="button"
        className="chat-head-github chat-head-ci-link"
        title={`${description} Open GitHub Actions`}
        aria-label={`${description} Open GitHub Actions`}
        onClick={() => void openUrl(ci.url)}
      >
        {status === "not-started" && (
          <svg
            className="chat-head-ci-icon"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
            <path d="M12 9v4M12 17h.01" />
          </svg>
        )}
        {status === "running" ? (
          // In-flight runs shimmer (same sweep as "Hook engaged"); a red fail
          // stops the sweep and a full pass settles to static green.
          <ShimmerText base="var(--text-muted)">{label}</ShimmerText>
        ) : (
          label
        )}
      </button>
      {!active && failure && (
        <button
          type="button"
          className="chat-head-link chat-head-ci-dismiss"
          title="Dismiss CI failure"
          aria-label="Dismiss CI failure"
          onClick={() => setHiddenKey(key)}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
      )}
    </span>
  );
}
