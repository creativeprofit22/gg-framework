import { useLayoutEffect, useRef } from "react";
import { FileTextIcon, FilmStripIcon, XIcon } from "@phosphor-icons/react";
import { theme } from "./theme";
import type { PendingAttachment } from "./attachments";
import { pinSize, usePresenceList } from "./usePresenceList";

/** Exit duration of `.attach-bar.leaving` / `.attach-chip.leaving`: equal to `--dur-strip-out` in App.css; scripts/motion-tokens.test.mjs enforces it. */
const EXIT_MS = 220;

const keyOf = (a: PendingAttachment): string => String(a.id);

/**
 * Staged attachment chips shown above the chat input. Images show a thumbnail;
 * videos/files show an icon + name. Each has a remove button. Chips pop in when
 * added and collapse out when removed (or sent); the bar itself grows open and
 * folds shut so the composer glides instead of jumping.
 */
export function AttachmentBar({
  attachments,
  onRemove,
  onOpenImage,
}: {
  attachments: PendingAttachment[];
  onRemove: (id: number) => void;
  /** Open an image chip's preview (a data URL) in the default image viewer. */
  onOpenImage: (previewUrl: string) => void;
}): React.ReactElement | null {
  const shown = usePresenceList(attachments, keyOf, EXIT_MS);
  const empty = shown.length === 0;
  const barLeaving = !empty && shown.every((p) => p.leaving);
  const barRef = useRef<HTMLDivElement>(null);
  // Measure on mount (enter grows to this height) and again when the bar starts
  // leaving (exit folds from it).
  useLayoutEffect(() => pinSize(barRef.current), [barLeaving, empty]);

  if (empty) return null;
  return (
    <div ref={barRef} className={`attach-bar${barLeaving ? " leaving" : ""}`}>
      {shown.map(({ item: a, key, leaving }) => (
        <div
          key={key}
          ref={leaving ? pinSize : undefined}
          className={`attach-chip${leaving ? " leaving" : ""}`}
          title={a.name}
          inert={leaving}
        >
          {a.previewUrl ? (
            <button
              type="button"
              className="attach-thumb-open"
              aria-label={`Open ${a.name}`}
              onClick={() => a.previewUrl && onOpenImage(a.previewUrl)}
            >
              <img className="attach-thumb" src={a.previewUrl} alt="" />
            </button>
          ) : (
            <span className="attach-icon" style={{ color: theme.textMuted }}>
              {a.kind === "video" ? <FilmStripIcon size={16} /> : <FileTextIcon size={16} />}
            </span>
          )}
          <span className="attach-name">{a.name}</span>
          <button
            className="attach-remove"
            aria-label={`Remove ${a.name}`}
            onClick={() => onRemove(a.id)}
          >
            <XIcon size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
