import { useMemo } from "react";
import type { ChatErrorItem } from "./chat-error";
import {
  CRITTERS,
  CRITTER_CELLS,
  pickCritter,
  renderCritterFrame,
  renderPixelGrid,
} from "./critter-sprites";

/** An eye as `[x, y, width, height]` in sprite cells. */
type Eye = readonly [number, number, number, number];

/**
 * How each critter shuts its eyes. Every eye cell is painted `lid`, except a
 * 2–3 cell tall eye's second row, which becomes the dark lid line. One-cell
 * eyes (screens, visors) just go dark.
 */
export interface Blink {
  readonly lid: string;
  readonly eyes: readonly Eye[];
}

// Shared chibi head: whites over two-pixel pupils on rows 7–8.
const CHIBI: Blink = {
  lid: "B",
  eyes: [
    [4, 7, 2, 2],
    [9, 7, 2, 2],
  ],
};

export const ERROR_CRITTER_BLINKS: Readonly<Record<string, Blink>> = {
  bee: {
    lid: "B",
    eyes: [
      [4, 5, 2, 2],
      [9, 5, 2, 2],
    ],
  },
  fox: CHIBI,
  cat: CHIBI,
  owl: {
    lid: "B",
    eyes: [
      [2, 6, 3, 3],
      [8, 6, 4, 3],
    ],
  },
  frog: {
    lid: "B",
    eyes: [
      [3, 3, 3, 2],
      [8, 3, 3, 2],
    ],
  },
  robot: {
    lid: "K",
    eyes: [
      [5, 6, 1, 1],
      [9, 6, 1, 1],
    ],
  },
  ghost: {
    lid: "B",
    eyes: [
      [5, 6, 1, 2],
      [9, 6, 1, 2],
    ],
  },
  shroom: {
    lid: "F",
    eyes: [
      [4, 8, 2, 2],
      [8, 8, 2, 2],
    ],
  },
  wizard: {
    lid: "K",
    eyes: [
      [5, 6, 1, 1],
      [9, 6, 1, 1],
    ],
  },
  knight: {
    lid: "K",
    eyes: [
      [5, 6, 1, 1],
      [9, 6, 1, 1],
    ],
  },
  builder: {
    lid: "F",
    eyes: [
      [4, 6, 2, 2],
      [8, 6, 2, 2],
    ],
  },
  crab: {
    lid: "K",
    eyes: [
      [4, 2, 2, 1],
      [8, 2, 2, 1],
    ],
  },
  axolotl: CHIBI,
  dino: CHIBI,
  slime: {
    lid: "B",
    eyes: [
      [5, 8, 2, 2],
      [9, 8, 2, 2],
    ],
  },
};

/** A new error never repeats the critters of this many errors before it. */
const ERROR_CRITTER_SPREAD = 3;

/**
 * Critter id for every error row, by item id. Each error is keyed on when it
 * happened, which is saved with it, so it keeps its critter after the chat is
 * reopened (older saves without a time fall back to their place among the
 * errors). Walking in order lets each error avoid its recent neighbours, and
 * an earlier error's pick never depends on later ones.
 */
export function assignErrorCritters(
  items: readonly { readonly id: number; readonly kind: string }[],
): ReadonlyMap<number, string> {
  const assigned = new Map<number, string>();
  const recent: string[] = [];
  let ordinal = 0;
  for (const item of items) {
    if (!isErrorItem(item)) continue;
    const key = item.occurredAt != null ? `at-${item.occurredAt}` : `error-${ordinal}`;
    ordinal++;
    const critter = pickCritter(undefined, key, new Set(recent));
    assigned.set(item.id, critter.id);
    recent.push(critter.id);
    if (recent.length > ERROR_CRITTER_SPREAD) recent.shift();
  }
  return assigned;
}

function isErrorItem(item: { readonly id: number; readonly kind: string }): item is ChatErrorItem {
  return item.kind === "error";
}

/** The pixel critter beside a chat error (see assignErrorCritters). */
export function ErrorCritter({
  critterId,
  animate,
}: {
  critterId: string;
  animate: boolean;
}): React.ReactElement | null {
  const sprite = useMemo(() => {
    const critter = CRITTERS.find((candidate) => candidate.id === critterId);
    const blink = ERROR_CRITTER_BLINKS[critterId];
    if (!critter || !blink) return undefined;
    let left = CRITTER_CELLS,
      top = CRITTER_CELLS,
      right = 0,
      bottom = 0;
    for (const [y, row] of critter.rows.entries()) {
      for (const [x, cell] of [...row].entries()) {
        if (cell === "." || !critter.palette[cell]) continue;
        left = Math.min(left, x);
        right = Math.max(right, x + 1);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y + 1);
      }
    }
    const rows = Array.from({ length: CRITTER_CELLS }, () =>
      Array<string>(CRITTER_CELLS).fill("."),
    );
    for (const [x, y, width, height] of blink.eyes) {
      for (let row = y; row < y + height; row++) {
        for (let col = x; col < x + width; col++) {
          const cells = rows[row];
          if (cells) cells[col] = row === y + 1 ? "K" : blink.lid;
        }
      }
    }
    return {
      id: critter.id,
      open: renderCritterFrame(critter, 0),
      blink: renderPixelGrid(
        rows.map((row) => row.join("")),
        critter.palette,
        { width: CRITTER_CELLS, height: CRITTER_CELLS },
      ),
      x: CRITTER_CELLS - left - right,
      y: CRITTER_CELLS - top - bottom,
    };
  }, [critterId]);
  if (!sprite) return null;
  return (
    <span className="chat-error-critter" aria-hidden="true" data-critter={sprite.id}>
      <span
        className="chat-error-art"
        style={{ transform: `translate(${sprite.x}px, ${sprite.y}px)` }}
      >
        <img src={sprite.open} alt="" draggable={false} />
        <img
          src={sprite.blink}
          alt=""
          draggable={false}
          className={`chat-error-blink${animate ? " is-animated" : ""}`}
        />
      </span>
    </span>
  );
}
