import { useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { PRODUCT_DISPLAY_NAME } from "./brand";
import { AsciiLogo } from "./AsciiLogo";
import { renderPixelGrid } from "./critter-sprites";
import { LOG_PALETTE, logBeamRows, logFramePieces, pickCrew, seeded } from "./whatsnew-content";
import {
  CritterSprite,
  DoneButton,
  FeatureCopy,
  PixelImage,
  PixelVersion,
  ReleaseHistory,
  type CampfireProps,
} from "./WhatsNewParts";

/**
 * Campfire stories. The home screen's campfire clearing, shrunk into a
 * banner under the GG Coder logo and the version in pixels: a crew of critters
 * sits round the fire and each new feature is a story told there. A pixel log
 * frame runs round the window, with a log beam under the banner.
 *   hype: the fire whooshes alight, critters run in from both sides, embers
 *         stream up, then the stories rise in one by one.
 *   calm: the crew is already seated, the fire just breathes.
 */
const FIRE_PALETTE = {
  w: "#fff7d6",
  Y: "#ffd23f",
  O: "#ff8a1f",
  R: "#e8412b",
  L: "#7a4a26",
  l: "#4a2c16",
};
export const FIRE_FRAMES = [
  [
    "...R....",
    "..RO..R.",
    "..ROR.R.",
    ".ROYOROR",
    ".ROYYYOR",
    "ROYwwYOR",
    "ROYwwYOR",
    ".ROYYOR.",
    "LlLLLLlL",
    ".lL..Ll.",
  ],
  [
    "....R...",
    ".R.OR...",
    ".RROR.R.",
    "ROOYOOR.",
    "ROYYYOR.",
    "ROYwwYOR",
    "ROYwwYOR",
    ".ROYYOR.",
    "LlLLLLlL",
    ".lL..Ll.",
  ],
] as const;
export const PINE = [
  "....G....",
  "...GGG...",
  "..GGGGG..",
  "...GGG...",
  "..GGGGG..",
  ".GGGGGGG.",
  "..GGGGG..",
  ".GGGGGGG.",
  "GGGGGGGGG",
  "....G....",
  "....G....",
] as const;

const FIRE_SIZE = { width: 8, height: 10 };
/** The version's pixel font: cell size, and how far the pixels fly in from. */
const VERSION_CELL = 6;
const VERSION_SCATTER = { x: 420, y: 220 } as const;
const PINE_SIZE = { width: 9, height: 11 };

/** Seats round the fire: offset from centre, and which way they face. */
const SEATS = [
  { x: -132, from: -340, flip: false },
  { x: -84, from: -300, flip: false },
  { x: 46, from: 300, flip: true },
  { x: 94, from: 340, flip: true },
] as const;
const TREES = [
  { x: 2, s: 5 },
  { x: 9, s: 4 },
  { x: 17, s: 6 },
  { x: 74, s: 5 },
  { x: 82, s: 7 },
  { x: 91, s: 4 },
] as const;

export function WhatsNewCampfire({
  latest,
  earlier,
  mode,
  random,
  onClose,
  tabs,
  panels,
}: CampfireProps & {
  /** Local Fork: the source tablist, shown under the log beam. */
  tabs?: ReactNode;
  /** Local Fork: tab panels replacing the default stories + history. */
  panels?: ReactNode;
}): React.ReactElement {
  const hype = mode === "hype";
  const [crew] = useState(() => pickCrew(SEATS.length, random));
  const art = useMemo(
    () => ({
      fire: FIRE_FRAMES.map((frame) => renderPixelGrid(frame, FIRE_PALETTE, FIRE_SIZE)),
      pine: renderPixelGrid(PINE, { G: "#0c1118" }, PINE_SIZE),
      frame: logFramePieces()
        .map((piece) => `url("${renderPixelGrid(piece.rows, LOG_PALETTE, piece)}")`)
        .join(", "),
      beam: renderPixelGrid(logBeamRows(), LOG_PALETTE, { width: 6, height: 5 }),
    }),
    [],
  );
  // The frame's eight pieces and the beam tile, as background images. The
  // stylesheet places them (sizes, positions, repeats in the same order).
  const stars = useMemo(() => {
    const rand = seeded(7);
    return Array.from({ length: 28 }, () => ({
      left: rand() * 100,
      top: rand() * 62,
      delay: rand() * 4,
      big: rand() > 0.82,
    }));
  }, []);
  const embers = useMemo(() => {
    const rand = seeded(11);
    return Array.from({ length: hype ? 16 : 6 }, () => ({
      drift: (rand() - 0.5) * 60,
      delay: rand() * (hype ? 2.4 : 5),
      rise: 70 + rand() * 70,
    }));
  }, [hype]);

  return (
    <>
      <div className="wn-camp-logs" aria-hidden="true" style={{ backgroundImage: art.frame }} />
      <header className="wn-camp-scene">
        {stars.map((star, i) => (
          <i
            key={i}
            className={`wn-camp-star${star.big ? " big" : ""}`}
            style={{ left: `${star.left}%`, top: `${star.top}%`, animationDelay: `${star.delay}s` }}
          />
        ))}
        {/* The home screen's banner, small, over the version in pixels. */}
        <div className="wn-camp-copy">
          <h1 className="sr-only">{`What's new in ${PRODUCT_DISPLAY_NAME} v${latest.version}`}</h1>
          <AsciiLogo />
          <PixelVersion
            version={latest.version}
            cell={VERSION_CELL}
            scatter={VERSION_SCATTER}
            className="wn-camp-version"
          />
        </div>
        <div className="wn-camp-glow" />
        {TREES.map((tree, i) => (
          <PixelImage
            key={i}
            className="wn-camp-tree"
            src={art.pine}
            width={PINE_SIZE.width * tree.s}
            height={PINE_SIZE.height * tree.s}
            style={{ left: `${tree.x}%` }}
          />
        ))}
        <div className="wn-camp-ground" />
        <div className="wn-camp-fire">
          {embers.map((ember, i) => (
            <i
              key={i}
              className="wn-camp-ember"
              style={
                {
                  "--drift": `${ember.drift}px`,
                  "--rise": `${-ember.rise}px`,
                  animationDelay: `${ember.delay}s`,
                } as CSSProperties
              }
            />
          ))}
          <span className="wn-camp-flames">
            {art.fire.map((src, i) => (
              <PixelImage key={i} src={src} width={40} height={50} className={`frame-${i}`} />
            ))}
          </span>
        </div>
        {crew.map((critter, i) => {
          const seat = SEATS[i];
          if (!seat) return null;
          return (
            <span
              key={critter.id}
              className="wn-camp-seat"
              style={
                {
                  "--x": `${seat.x}px`,
                  "--from": `${seat.from}px`,
                  "--d": `${0.25 + i * 0.12}s`,
                } as CSSProperties
              }
            >
              <span className={seat.flip ? "wn-flip" : undefined}>
                <CritterSprite
                  critter={critter}
                  size={42}
                  walk={hype}
                  className="wn-camp-critter"
                />
              </span>
            </span>
          );
        })}
      </header>
      <div
        className="wn-camp-beam"
        aria-hidden="true"
        style={{ backgroundImage: `url("${art.beam}")` }}
      />
      {tabs}
      <div className="wn-scroll">
        {panels ?? <CampfireStories latest={latest} earlier={earlier} hype={hype} />}
      </div>
      <footer className="wn-actions">
        <DoneButton label={hype ? "Pull up a log" : "Got it"} onClose={onClose} />
      </footer>
    </>
  );
}

/** The new release's features as numbered stories, then the calm history. */
export function CampfireStories({
  latest,
  earlier,
  hype,
}: {
  latest: CampfireProps["latest"];
  earlier: CampfireProps["earlier"];
  hype: boolean;
}): React.ReactElement {
  return (
    <>
      <ol className="wn-camp-stories" aria-label={`New in v${latest.version}`}>
        {latest.items.map((item, i) => (
          <li
            key={i}
            className="wn-camp-story wn-rise"
            style={{ "--d": `${(hype ? 2.1 : 0) + i * (hype ? 0.22 : 0.05)}s` } as CSSProperties}
          >
            <span className="wn-camp-num" aria-hidden="true">
              {String(i + 1).padStart(2, "0")}
            </span>
            <div>
              <FeatureCopy item={item} />
            </div>
          </li>
        ))}
      </ol>
      <ReleaseHistory
        sections={earlier}
        title="Earlier around the fire"
        delay={hype ? 2.3 + latest.items.length * 0.22 : 0.1}
      />
    </>
  );
}
