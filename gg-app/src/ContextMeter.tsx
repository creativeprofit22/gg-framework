import { theme } from "./theme";

function contextColor(pct: number): string {
  if (pct >= 80) return theme.error;
  if (pct >= 50) return theme.warning;
  return theme.success;
}

function calculatedContextPercent(contextTokens: number, contextWindow?: number): number {
  if (!contextWindow || contextWindow <= 0 || contextTokens <= 0) return 0;
  return Math.round((contextTokens / contextWindow) * 100);
}

export function getContextPercent(contextTokens: number, contextWindow?: number): number {
  return Math.min(100, calculatedContextPercent(contextTokens, contextWindow));
}

function contextWindowLabel(contextWindow: number): string {
  if (contextWindow === 272_000) return "272K";
  if (contextWindow === 872_000) return "872K";
  return `${Math.round(contextWindow / 1_000).toLocaleString("en-US")}K`;
}

export function ContextMeter({
  used,
  window,
}: {
  used: number;
  window: number;
}): React.ReactElement {
  const safeUsed = Math.max(0, Math.round(used));
  const calculatedPercent = calculatedContextPercent(safeUsed, window);
  const pct = getContextPercent(safeUsed, window);
  const label = `${safeUsed.toLocaleString("en-US")} / ${contextWindowLabel(window)} · ${calculatedPercent}%`;
  return (
    <span
      aria-label={`Context used: ${label}`}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={pct}
      className="ctx-meter"
      role="meter"
      style={{ color: contextColor(calculatedPercent) }}
    >
      <span className="ctx-meter-bar" aria-hidden="true">
        <span className="ctx-meter-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="ctx-meter-label">{label}</span>
    </span>
  );
}
