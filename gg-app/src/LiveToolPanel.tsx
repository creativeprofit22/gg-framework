import { theme } from "./theme";
import { buildToolLineParts, toneColor } from "./tool-format";

// BLACK_CIRCLE — ⏺, matching the TUI status figure.
const DOT = "\u23FA";

/** Max rows shown at once — older entries roll off the top (mirrors TUI). */
export const LIVE_TOOL_PANEL_ROWS = 3;

/** A single tool action in the pinned feed — mirrors ggcoder's LiveToolEntry. */
export interface LiveToolEntry {
  toolCallId: string;
  /** Provider-facing alias used for tone/detail behavior and state keys. */
  name: string;
  args: Record<string, unknown>;
  status: "running" | "done";
  isError?: boolean;
  result?: string;
  details?: unknown;
  /** Exact source identity shown for identity-bearing MCP tools. */
  displayName?: string;
  mcpServerName?: string;
  mcpToolName?: string;
}

interface Props {
  entries: readonly LiveToolEntry[];
}

/**
 * Pinned, in-place panel of recent tool actions — a rolling window of the last
 * few calls shown directly above the activity bar. Mirrors the TUI
 * LiveToolPanel: tools (running AND done) live ONLY here, never in the
 * scrollback transcript. Each row is a status dot + bold tone-colored verb +
 * plain detail + dim inline summary. Done rows recolor the dot (green / red).
 */
export function LiveToolPanel({ entries }: Props): React.ReactElement | null {
  if (entries.length === 0) return null;
  const visible = entries.slice(-LIVE_TOOL_PANEL_ROWS);

  return (
    <div className="livetoolpanel">
      {visible.map((entry) => {
        const done = entry.status === "done";
        const parts = buildToolLineParts(entry.name, entry.args, {
          done,
          isError: entry.isError,
          result: entry.result,
          details: entry.details,
          displayName: entry.displayName,
        });
        const dotColor = done ? (entry.isError ? theme.error : theme.success) : theme.primary;
        const statusLabel = done ? (entry.isError ? "Failed" : "Completed") : "Running";
        return (
          <div className="tool-row" key={entry.toolCallId}>
            <span
              className={`tool-dot${done ? "" : " blink"}`}
              style={{ color: dotColor }}
              title={statusLabel}
              aria-hidden="true"
            >
              {DOT}
            </span>
            <span className="visually-hidden">{statusLabel}: </span>
            <span className="tool-line">
              {parts.map((p, i) => (
                <span
                  key={i}
                  style={{
                    color: p.dim ? theme.textDim : p.tone ? toneColor(p.tone) : theme.text,
                    fontWeight: p.bold ? 600 : 400,
                  }}
                >
                  {p.text}
                </span>
              ))}
            </span>
          </div>
        );
      })}
    </div>
  );
}
