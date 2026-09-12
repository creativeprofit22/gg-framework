import { formatInterval } from "./scheduleCommand";

/**
 * Compact countdown to the next run. Seconds are shown under a minute so the
 * popover visibly ticks rather than sitting on a stale "1m" — otherwise an
 * imminent run looks indistinguishable from a stalled one.
 */
export function nextRunLabel(nextRunAt: number, now: number): string {
  const remaining = nextRunAt - now;
  if (remaining <= 0) return "due now";
  const seconds = Math.round(remaining / 1000);
  if (seconds < 60) return `in ${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  return `in ${formatInterval(remaining)}`;
}
