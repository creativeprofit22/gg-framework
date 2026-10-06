import type { PromptSegment } from "./agent";

/** Hint text for a corrected term: what the user originally said, then the note. */
export function termHint(seg: { original: string; note?: string | undefined }): string {
  const said = `you said: \u201c${seg.original}\u201d`;
  return seg.note ? `${said}\n${seg.note}` : said;
}

/**
 * Render a sequence of enhanced-prompt segments. Plain `text` segments render
 * verbatim; `term` segments are highlighted with a tooltip teaching what the
 * user originally said. The tooltip comes from the app-wide TooltipLayer (via
 * `title`), which portals it above everything and keeps it inside the window,
 * so terms on the first visible line or near a pane edge are not clipped.
 * `data-tooltip-tap` lets a tap or click toggle the hint, for touch users.
 */
export function EnhancedSegments({ segments }: { segments: PromptSegment[] }): React.ReactElement {
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.kind === "text") return <span key={i}>{seg.text}</span>;
        return (
          <span key={i} className="enh-term" tabIndex={0} title={termHint(seg)} data-tooltip-tap="">
            {seg.text}
          </span>
        );
      })}
    </>
  );
}
