import { useMemo } from "react";
import type { CSSProperties } from "react";
import { renderCritterFrame } from "./critter-sprites";
import { critterById } from "./PopCritter";
import {
  ARROW_SRC,
  BASE_SRC,
  burstPieces,
  cellFlights,
  PLATE_SRC,
  pixelWord,
} from "./update-key-art";
import "./UpdateKeyParts.css";

/**
 * The pieces both update keys are built from (Home's HomeUpdateButton, the
 * workspace footer's UpdateBanner): words in the Goal world's pixel font, the
 * bobbing arrow, the XP meter with the builder running along it, and the burst
 * of pixels at 100%. Art from update-key-art.ts; styles in UpdateKeyParts.css.
 */

/** The 9-slice plate and side, as the CSS custom properties the keys read. */
export const KEY_ART_STYLE: CSSProperties & Record<"--lvl-plate" | "--lvl-base", string> = {
  "--lvl-plate": `url("${PLATE_SRC}")`,
  "--lvl-base": `url("${BASE_SRC}")`,
};

type CellStyle = CSSProperties & Record<"--t" | "--dx" | "--dy" | "--rot" | "--d", string | number>;

/**
 * A word in the pixel font, one `<i>` per lit cell. With `fly`, every cell
 * starts somewhere off to the side and flies into place (the CSS runs it once,
 * as the word mounts). Decorative: the key carries the words in its name.
 */
export function PixelText({
  text,
  cell,
  fly = false,
  spread = 70,
  minCols,
  className,
}: {
  text: string;
  /** One pixel's edge, in CSS px. */
  cell: number;
  fly?: boolean;
  spread?: number;
  /** Reserve this many columns, so a changing number never resizes its box. */
  minCols?: number;
  className?: string;
}): React.ReactElement {
  const word = useMemo(() => pixelWord(text), [text]);
  const flights = useMemo(
    () => (fly ? cellFlights(word, text, spread) : null),
    [fly, word, text, spread],
  );
  const cols = Math.max(word.cols, minCols ?? 0);
  // Right-aligned inside the reserved width, as numbers are.
  const shift = cols - word.cols;
  return (
    <span
      className={`lvl-word${fly ? " is-flying" : ""}${className ? ` ${className}` : ""}`}
      aria-hidden="true"
      style={{
        gridTemplateColumns: `repeat(${cols}, ${cell}px)`,
        gridTemplateRows: `repeat(${word.rows}, ${cell}px)`,
      }}
    >
      {word.cells.map((c, i) => {
        const flight = flights?.[i];
        const style: CellStyle = {
          gridColumn: c.col + shift + 1,
          gridRow: c.row + 1,
          "--t": c.t,
          "--dx": `${flight?.dx ?? 0}px`,
          "--dy": `${flight?.dy ?? 0}px`,
          "--rot": `${flight?.rot ?? 0}deg`,
          "--d": `${flight?.delay ?? 0}s`,
        };
        return <i key={`${c.col}-${c.row}`} style={style} />;
      })}
    </span>
  );
}

/** The green up arrow, hopping now and then. Decorative. */
export function UpdateArrow(): React.ReactElement {
  return <img className="lvl-arrow" src={ARROW_SRC} alt="" aria-hidden="true" draggable={false} />;
}

const BUILDER = critterById("builder");
const RUNNER = [renderCritterFrame(BUILDER, 0), renderCritterFrame(BUILDER, 1)] as const;

/** The XP meter: pixel segments filling up, the builder running at the front. */
export function UpdateMeter({ pct }: { pct: number }): React.ReactElement {
  const style: CSSProperties & Record<"--pct", number> = { "--pct": pct };
  return (
    <span className="lvl-meter" style={style} aria-hidden="true">
      <span className="lvl-track">
        <span className="lvl-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="lvl-runner">
        <img src={RUNNER[0]} alt="" draggable={false} />
        <img className="lvl-runner-step" src={RUNNER[1]} alt="" draggable={false} />
      </span>
    </span>
  );
}

const BURST = burstPieces();
const FLAT_BURST = burstPieces(18, 0.3);

/** The pixels a key goes off in when the update lands. `flat` keeps them low. */
export function UpdateBurst({ flat = false }: { flat?: boolean }): React.ReactElement {
  return (
    <span className="lvl-burst" aria-hidden="true">
      {(flat ? FLAT_BURST : BURST).map((piece, i) => {
        const style: CSSProperties & Record<"--dx" | "--dy" | "--d", string> = {
          width: piece.size,
          height: piece.size,
          background: piece.color,
          "--dx": `${piece.dx}px`,
          "--dy": `${piece.dy}px`,
          "--d": `${piece.delay}s`,
        };
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed, never-reordered set
        return <i key={i} style={style} />;
      })}
    </span>
  );
}
