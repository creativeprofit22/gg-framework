import { useMemo } from "react";
import type { CSSProperties } from "react";
import type { ChangelogEntry } from "./changelog";
import { hashKey, renderCritterFrame, type CritterDef } from "./critter-sprites";
import { escapeRegExp, LEGACY_MENTOR_HANDLE, MENTOR_HANDLE } from "./brand";
import { pixelText, seeded, shortDate, splitItem, type WhatsNewMode } from "./whatsnew-content";

/** What the campfire design receives from the window shell. */
export interface CampfireProps {
  /** The release that just arrived: the star of the show. */
  latest: ChangelogEntry;
  /** Older releases, shown as a calm history list. */
  earlier: readonly ChangelogEntry[];
  mode: WhatsNewMode;
  /** Picks this opening's critters; injectable for tests. */
  random: () => number;
  onClose: () => void;
}

/**
 * Building blocks of the "What's new" window: highlighted release
 * text, the headline + body split, pixel sprites, and the quiet history list
 * the window ends with.
 */
const HIGHLIGHT_TERMS = [
  "MiMo-V2.5-Pro-UltraSpeed",
  "GPT-6 Astra",
  "GPT-6.1 Sol",
  "GPT-6 Sol",
  "GPT-6 Luna",
  "GPT-5.6 Ultra",
  "GPT-5.6",
  "GPT-5.5",
  "GPT-5.4 Mini",
  "GPT-5.4",
  "GPT-5.3 Codex",
  "Gemini 3.5 Flash",
  "Gemini 3.1 Pro",
  "Claude Sonnet 5",
  "Claude Fable 5.1",
  "Claude Fable 5",
  "Sakana Fugu",
  "Fugu Ultra",
  "Radio Paradise",
  "Steroids",
  "Prompt Enhancer",
  "Send to Supah Coder",
  "Grant Permissions",
  "Autopilot",
  "Scorecard",
  "Enhance",
  MENTOR_HANDLE,
  LEGACY_MENTOR_HANDLE,
  "Radio",
  "Windows",
  "Notes",
  "MCP",
] as const;

const highlightPattern = new RegExp(
  `\`([^\`]+)\`|(${HIGHLIGHT_TERMS.map(escapeRegExp).join("|")})|\\b(\\d+(?:\\.\\d+)?(?:K|M| MB| tokens?| minutes?| hour| updates?))\\b`,
  "g",
);

/** Release copy with backticked names and known specifics highlighted. */
export function releaseText(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(highlightPattern)) {
    const index = match.index ?? 0;
    if (index > cursor) nodes.push(text.slice(cursor, index));
    const value = match[1] ?? match[2] ?? match[3] ?? match[0];
    nodes.push(
      <strong className="whatsnew-highlight" key={`${index}-${value}`}>
        {value}
      </strong>,
    );
    cursor = index + match[0].length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

/** A bullet read as a headline (its hook sentence) over the detail. */
export function FeatureCopy({
  item,
  as: Heading = "h3",
}: {
  item: string;
  as?: "h1" | "h2" | "h3" | "h4";
}): React.ReactElement {
  const { headline, body } = splitItem(item);
  return (
    <>
      <Heading className="wn-headline">{releaseText(headline)}</Heading>
      {/* Whitespace between blocks keeps the accessible text a natural sentence. */}
      {body && " "}
      {body && <p className="wn-body">{releaseText(body)}</p>}
    </>
  );
}

/**
 * A critter at `size` px. `walk` adds the second frame, which blinks over the
 * first so the legs step (see `.wn-sprite.walking`). Decorative only.
 */
export function CritterSprite({
  critter,
  size,
  walk = false,
  className,
  style,
}: {
  critter: CritterDef;
  size: number;
  walk?: boolean;
  className?: string;
  style?: CSSProperties;
}): React.ReactElement {
  const [frameA, frameB] = useMemo(
    () => [renderCritterFrame(critter, 0), renderCritterFrame(critter, 1)],
    [critter],
  );
  const classes = ["wn-sprite", walk ? "walking" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <span
      className={classes}
      data-critter={critter.id}
      aria-hidden="true"
      style={{ ...style, "--sprite": `${size}px` } as CSSProperties}
    >
      <img src={frameA} alt="" draggable={false} />
      {walk && <img className="wn-sprite-step" src={frameB} alt="" draggable={false} />}
    </span>
  );
}

/** A still pixel image (a prop, a tree, a frame of fire) at a cell scale. */
export function PixelImage({
  src,
  width,
  height,
  className,
  style,
}: {
  src: string;
  width: number;
  height: number;
  className?: string;
  style?: CSSProperties;
}): React.ReactElement {
  return (
    <img
      className={className ? `wn-pixel ${className}` : "wn-pixel"}
      src={src}
      alt=""
      aria-hidden="true"
      draggable={false}
      width={width}
      height={height}
      style={style}
    />
  );
}

/**
 * The version in the chunky arcade pixel font: one `<i>` per lit cell on a
 * grid. Each cell carries `--t` (0 → 1 across the width, for a colour sweep)
 * and a seeded off-screen start (`--dx`, `--dy`, `--rot`, `--d`) so the CSS
 * can fly the pixels in. Colour and motion belong to the stylesheet.
 * Decorative: the caller puts the version in real text for screen readers.
 */
export function PixelVersion({
  version,
  cell,
  scatter,
  className,
}: {
  version: string;
  /** One pixel's edge, in CSS px. */
  cell: number;
  /** How far off-screen the pixels start, in px. */
  scatter: { readonly x: number; readonly y: number };
  className?: string;
}): React.ReactElement {
  const grid = useMemo(() => {
    const rows = pixelText(`v${version}`);
    const cols = rows[0]?.length ?? 0;
    const rand = seeded(hashKey(version));
    const lit: { key: string; style: CSSProperties }[] = [];
    rows.forEach((line, row) => {
      [...line].forEach((ch, col) => {
        if (ch !== "#") return;
        lit.push({
          key: `${col}-${row}`,
          style: {
            gridColumn: col + 1,
            gridRow: row + 1,
            "--t": cols > 1 ? col / (cols - 1) : 0,
            "--dx": `${(rand() - 0.5) * scatter.x}px`,
            "--dy": `${(rand() - 0.5) * scatter.y}px`,
            "--rot": `${(rand() - 0.5) * 540}deg`,
            "--d": `${rand() * 0.55}s`,
          } as CSSProperties,
        });
      });
    });
    return { lit, cols, rows: rows.length };
  }, [version, scatter.x, scatter.y]);

  return (
    <div
      className={className ? `wn-pixel-version ${className}` : "wn-pixel-version"}
      aria-hidden="true"
      style={{
        gridTemplateColumns: `repeat(${grid.cols}, ${cell}px)`,
        gridTemplateRows: `repeat(${grid.rows}, ${cell}px)`,
      }}
    >
      {grid.lit.map((px) => (
        <i key={px.key} style={px.style} />
      ))}
    </div>
  );
}

/**
 * The window always ends the same way: the older releases as a calm, scannable
 * list. The spectacle is for what just arrived, not the archive.
 */
export function ReleaseHistory({
  sections,
  title = "Earlier updates",
  delay = 0,
}: {
  sections: readonly ChangelogEntry[];
  title?: string;
  /** Seconds to hold back, so the archive never upstages the new features. */
  delay?: number;
}): React.ReactElement | null {
  if (sections.length === 0) return null;
  return (
    <section
      className="wn-history wn-rise"
      aria-label={title}
      style={{ "--d": `${delay}s` } as CSSProperties}
    >
      <h2 className="wn-history-title">
        <span>{title}</span>
      </h2>
      {sections.map((section) => (
        <div className="wn-history-release" key={section.version}>
          <h3 className="wn-history-version">
            <span>{`v${section.version}`}</span>
            <time dateTime={section.date}>{shortDate(section.date)}</time>
          </h3>
          <ul className="wn-history-list">
            {section.items.map((item, i) => (
              <li key={i} className="wn-history-item">
                <FeatureCopy item={item} as="h4" />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

/** The footer's one action. Focused on open so Enter dismisses too. */
export function DoneButton({
  label,
  onClose,
}: {
  label: string;
  onClose: () => void;
}): React.ReactElement {
  return (
    <button className="modal-btn primary wn-done" type="button" autoFocus onClick={onClose}>
      {label}
    </button>
  );
}
