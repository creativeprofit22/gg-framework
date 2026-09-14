import { AtSign, X } from "lucide-react";
import { theme } from "./theme";

/**
 * Inline-code-styled chips for each `@`-referenced file. The paths are tracked
 * in state (not in the textarea text); removing a chip drops it from that state.
 */
export function ReferencedFiles({
  paths,
  onRemove,
}: {
  paths: readonly string[];
  onRemove: (path: string) => void;
}): React.ReactElement | null {
  if (paths.length === 0) return null;
  return (
    <div className="mention-bar">
      {paths.map((p) => (
        <div
          key={p}
          className="mention-chip"
          title={p}
          style={{ background: theme.surface1, borderColor: theme.border }}
        >
          <AtSign size={11} className="mention-chip-at" style={{ color: theme.accent }} />
          <span className="mention-chip-name" style={{ color: theme.code }}>
            {p}
          </span>
          <button
            className="mention-chip-remove"
            aria-label={`Remove ${p}`}
            onClick={() => onRemove(p)}
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

// Preserve the frontend API; the same parser now enforces backend input policy.
export { appendReferencedFiles, parseReferencedFiles } from "@kenkaiiii/gg-core/referenced-files";
