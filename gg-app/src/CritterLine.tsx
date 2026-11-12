import { useMemo, useState } from "react";
import { theme } from "./theme";
import { ShimmerText } from "./ShimmerText";
import { renderCritterFrame, type CritterDef } from "./critter-sprites";

/** Where a critter row stands: drives the sprite's pose and the text colour. */
export type CritterTone = "working" | "done" | "failed" | "stopped";

/**
 * Text colour per tone: critter pink while busy, green when clear, red on
 * failure, amber when the user called the critters back (not their fault).
 */
export const CRITTER_TONE_COLOR: Readonly<Record<CritterTone, string>> = {
  working: theme.critter,
  done: theme.success,
  failed: theme.error,
  stopped: theme.warning,
};

/**
 * One transcript line led by a little critter in the assistant-dot gutter, in
 * the "Hook engaged" style: bold tone-coloured text that shimmers while the
 * critter works. The sprite hops while working, stands when done or stopped
 * and tips over on failure. Shared by the sub-agent row and the compaction
 * notice.
 */
export function CritterLine({
  critter,
  tone,
  text,
  color: colorOverride,
}: {
  critter: CritterDef;
  tone: CritterTone;
  text: string;
  /** Replaces the tone's colour (plan rows read in plan-mode amber). */
  color?: string | undefined;
}): React.ReactElement {
  // The sprite only depends on which critter it is; the transcript re-renders
  // on every streamed token, so don't rebuild the SVG each time.
  const sprite = useMemo(() => renderCritterFrame(critter, 0), [critter]);
  const color = colorOverride ?? CRITTER_TONE_COLOR[tone];
  // The wording flips as the critters work ("Sent a critter off…" to "The
  // critter is back…"). Re-keying the text on its wording remounts it, so each
  // new line dissolves in. The first wording doesn't: a live row already
  // dissolves in as a whole, and restored history must not animate.
  const [firstText] = useState(text);
  const changed = text !== firstText;
  return (
    <div className="subagents subagents-compact" data-swap-row="">
      <span className="subagents-critter" aria-hidden="true">
        <img
          className={`subagents-critter-img subagents-critter-${tone}`}
          src={sprite}
          alt=""
          draggable={false}
        />
      </span>
      <span
        key={text}
        className={`subagents-compact-text${changed ? " dissolve-swap" : ""}`}
        style={{ color }}
      >
        {tone === "working" ? <ShimmerText base={color}>{text}</ShimmerText> : text}
      </span>
    </div>
  );
}
