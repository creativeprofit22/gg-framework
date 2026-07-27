import { theme } from "./theme";
import { ShimmerText } from "./ShimmerText";

// BLACK_CIRCLE — ⏺, matching the rest of the app's status figures.
const DOT = "\u23FA";

interface Props {
  status: "running" | "done" | "sync-failed";
  originalCount?: number;
  newCount?: number;
  message?: string;
  guidance?: string;
}

/**
 * Context-compaction notice in the transcript. While compacting it shows a
 * shimmering one-liner (mirrors the hook/plan aesthetic); when done it settles
 * into a quiet dimmed summary with the before → after message counts.
 */
export function CompactionNotice({
  status,
  originalCount,
  newCount,
  message,
  guidance,
}: Props): React.ReactElement {
  const running = status === "running";
  const failed = status === "sync-failed";
  const color = running ? theme.secondary : failed ? theme.error : theme.success;

  const summary =
    originalCount != null && newCount != null
      ? `Compacted context · ${originalCount} → ${newCount} messages`
      : "Compacted context";

  return (
    <div className="assistant-msg">
      <span className={`assistant-dot${running ? " blink" : ""}`} style={{ color }}>
        {DOT}
      </span>
      <div className="assistant-text">
        {running ? (
          <ShimmerText base={theme.secondary} bright="#ddd6fe">
            Compacting context…
          </ShimmerText>
        ) : failed ? (
          <span style={{ color: theme.error }}>
            {message ?? "Context compacted, but the phase checkpoint did not sync."}
            {guidance ? ` ${guidance}` : " Retry after fixing Project Notes."}
          </span>
        ) : (
          <span style={{ color: theme.textDim }}>{summary}</span>
        )}
      </div>
    </div>
  );
}
