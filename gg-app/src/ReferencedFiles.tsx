import { useLayoutEffect, useRef } from "react";
import { AtIcon, XIcon } from "@phosphor-icons/react";
import { theme } from "./theme";
import { pinSize, usePresenceList } from "./usePresenceList";

/** Exit duration of `.mention-bar.leaving` / `.mention-chip.leaving`: equal to `--dur-strip-out` in App.css; scripts/motion-tokens.test.mjs enforces it. */
const EXIT_MS = 220;

const keyOf = (p: string): string => p;

/**
 * Inline-code-styled chips for each `@`-referenced file. The paths are tracked
 * in state (not in the textarea text); removing a chip drops it from that state.
 * Chips animate in and out the same way as the attachment chips.
 */
export function ReferencedFiles({
  paths,
  onRemove,
}: {
  paths: readonly string[];
  onRemove: (path: string) => void;
}): React.ReactElement | null {
  const shown = usePresenceList(paths, keyOf, EXIT_MS);
  const empty = shown.length === 0;
  const barLeaving = !empty && shown.every((s) => s.leaving);
  const barRef = useRef<HTMLDivElement>(null);
  // Measure on mount (enter grows to this height) and again when the bar starts
  // leaving (exit folds from it).
  useLayoutEffect(() => pinSize(barRef.current), [barLeaving, empty]);

  if (empty) return null;
  return (
    <div ref={barRef} className={`mention-bar${barLeaving ? " leaving" : ""}`}>
      {shown.map(({ item: p, key, leaving }) => (
        <div
          key={key}
          ref={leaving ? pinSize : undefined}
          className={`mention-chip${leaving ? " leaving" : ""}`}
          inert={leaving}
          title={p}
          style={{ background: theme.surface1, borderColor: theme.border }}
        >
          <AtIcon size={11} className="mention-chip-at" style={{ color: theme.accent }} />
          <span className="mention-chip-name" style={{ color: theme.code }}>
            {p}
          </span>
          <button
            className="mention-chip-remove"
            aria-label={`Remove ${p}`}
            onClick={() => onRemove(p)}
          >
            <XIcon size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

// Preserve the frontend API; the same parser now enforces backend input policy.
export { appendReferencedFiles, parseReferencedFiles } from "@kenkaiiii/gg-core/referenced-files";
