import { theme } from "./theme";
import { ShimmerText } from "./ShimmerText";

// BLACK_CIRCLE — ⏺, matching the rest of the app's status figures.
const DOT = "\u23FA";

interface Props {
  status: "running" | "done";
  originalCount?: number;
  newCount?: number;
}

/**
 * Context-compaction notice in the transcript. While compacting it shows a
 * shimmering one-liner (mirrors the hook/plan aesthetic); when done it settles
 * into a quiet dimmed summary with the before → after message counts.
 */
export function CompactionNotice({ status, originalCount, newCount }: Props): React.ReactElement {
  const running = status === "running";
  const color = running ? theme.secondary : theme.success;

  const summary =
    originalCount != null && newCount != null
      ? `Compacted context · ${originalCount} → ${newCount} messages`
      : "Compacted context";

  return (
    <div className="assistant-msg" data-swap-row="">
      <span className={`assistant-dot${running ? " blink" : ""}`} style={{ color }}>
        {DOT}
      </span>
      <div className="assistant-text">
        {running ? (
          <ShimmerText base={theme.secondary} bright="#ddd6fe">
            Compacting context…
          </ShimmerText>
        ) : (
          <span style={{ color: theme.textDim }}>{summary}</span>
        )}
      </div>
    </div>
  );
}
