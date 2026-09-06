import { useEffect, useState } from "react";
import { openUrl, type GitHubCI } from "./agent";
import { ShimmerText } from "./ShimmerText";

/** Only runs observed in flight get a completion indicator; old history stays hidden. */
export function CIIndicator({ ci }: { ci?: GitHubCI | null }): React.ReactElement | null {
  const [trackedKey, setTrackedKey] = useState<string | null>(null);
  const [hiddenKey, setHiddenKey] = useState<string | null>(null);
  const key = ci?.key ?? null;
  const active = ci?.active ?? false;
  const failure = (ci?.failed ?? 0) > 0 || ci?.conclusion === "failure";
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
    if (!key || key !== trackedKey || active || failure || stale || hiddenKey === key) return;
    const timer = setTimeout(() => setHiddenKey(key), 10_000);
    return () => clearTimeout(timer);
  }, [key, trackedKey, active, failure, stale, hiddenKey]);

  if (!ci || hiddenKey === key || (!active && trackedKey !== key)) return null;
  const status = stale
    ? "unavailable"
    : failure
      ? "failed"
      : active
        ? "running"
        : ci.conclusion === "success"
          ? "passed"
          : "stopped";
  const count = ci.total > 0 ? `${ci.completed}/${ci.total}` : "queued";
  const label = stale ? "CI unavailable" : `CI ${count}${status === "running" ? "" : ` ${status}`}`;
  const description = stale
    ? "CI updates unavailable. Last known result may be out of date."
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
        {status === "running" ? (
          // In-flight runs shimmer (same sweep as "Hook engaged"); a red fail
          // stops the sweep and a full pass settles to static green.
          <ShimmerText base="var(--text-muted)" bright="#ffffff">
            {label}
          </ShimmerText>
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
