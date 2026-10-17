import { theme } from "./theme";
import { buildToolLineParts, toneColor } from "./tool-format";

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
 * The agent's current tool, as one floating line centred just above the
 * deck: what GG is doing right now, and nothing older. It changes in place as
 * each call starts and finishes (the wording fades across), and leaves when
 * the run ends. The status line below keeps the run's overall state; this is
 * the step. A failed call says so in words ("Ran tsc · 1 error").
 */
export function LiveToolPanel({ entries }: Props): React.ReactElement | null {
  // The newest running call, else the newest one to finish.
  const entry =
    [...entries].reverse().find((e) => e.status === "running") ?? entries[entries.length - 1];
  if (!entry) return null;
  const done = entry.status === "done";
  const parts = buildToolLineParts(entry.name, entry.args, {
    done,
    isError: entry.isError,
    result: entry.result,
    details: entry.details,
    displayName: entry.displayName,
  });
  // Colour alone doesn't reach screen readers; name the step's state in words.
  const statusLabel = done ? (entry.isError ? "Failed" : "Completed") : "Running";
  return (
    <div className="livetoolpanel" role="status" aria-live="polite">
      <div
        className="tool-pill"
        data-state={entry.isError ? "error" : done ? "done" : "running"}
        title={parts.map((p) => p.text).join("")}
      >
        <span className="visually-hidden">{statusLabel}: </span>
        <span className="tool-line">
          {parts.map((p, i) => (
            // Keyed on the wording so a status flip ("Delegating" to
            // "Delegated") fades in rather than switching. Blur-free: this is
            // one truncated line (see .fade-swap).
            <span
              key={`${i}:${p.text}`}
              className="fade-swap"
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
    </div>
  );
}
