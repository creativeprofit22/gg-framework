import { useEffect, useMemo, useState } from "react";
import { useMemesEnabled } from "./memes";

// Home-screen meme cards. Each has a bundled GIF `src` plus an emoji/caption
// that double as the offline fallback if the GIF fails to load (onError swap),
// so a dead file never leaves a blank card. GIFs are bundled locally (200px
// Giphy downsized) so the CSP `img-src 'self'` policy doesn't block them.
interface Meme {
  id: number;
  src: string;
  emoji: string;
  caption: string;
}

// Eager-load every bundled GIF. Vite resolves these to hashed asset URLs that
// are served from the same origin, so they pass the strict CSP img-src 'self'.
const gifModules = import.meta.glob("./assets/memes/*.gif", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

/** Resolve `./assets/memes/<id>.gif` to its bundled URL. */
function memeUrl(id: number): string {
  return gifModules[`./assets/memes/${id}.gif`] ?? "";
}

const MEMES: Meme[] = [
  {
    id: 1,
    src: memeUrl(1),
    emoji: "🔥🐶☕",
    caption: "This is fine.",
  },
  {
    id: 2,
    src: memeUrl(2),
    emoji: "🤖",
    caption: "It works on my machine",
  },
  {
    id: 3,
    src: memeUrl(3),
    emoji: "🧠💥",
    caption: "git push --force",
  },
  {
    id: 4,
    src: memeUrl(4),
    emoji: "👀",
    caption: "// TODO: fix later",
  },
  {
    id: 5,
    src: memeUrl(5),
    emoji: "🚢🐛",
    caption: "Ship it.",
  },
  {
    id: 6,
    src: memeUrl(6),
    emoji: "♻️",
    caption: "Ctrl+C → Ctrl+V",
  },
  {
    id: 7,
    src: memeUrl(7),
    emoji: "😴",
    caption: "99 little bugs…",
  },
  {
    id: 8,
    src: memeUrl(8),
    emoji: "🦆",
    caption: "Rubber duck debugging",
  },
  {
    id: 9,
    src: memeUrl(9),
    emoji: "💀",
    caption: "Compiles. Don't touch.",
  },
  {
    id: 10,
    src: memeUrl(10),
    emoji: "🎉",
    caption: "Fixed one bug, made three",
  },
  {
    id: 11,
    src: memeUrl(11),
    emoji: "🤷🤖",
    caption: "The AI wrote it, not me",
  },
  {
    id: 12,
    src: memeUrl(12),
    emoji: "🫡",
    caption: "Accept all. Read nothing.",
  },
  {
    id: 13,
    src: memeUrl(13),
    emoji: "✅🚀",
    caption: "Vibe check passed. Ship it.",
  },
  {
    id: 14,
    src: memeUrl(14),
    emoji: "🙏📦",
    caption: "npm install && pray",
  },
  {
    id: 15,
    src: memeUrl(15),
    emoji: "🧠📜",
    caption: "Context window full again",
  },
  {
    id: 16,
    src: memeUrl(16),
    emoji: "👨‍🍳🔥",
    caption: "My agent is cooking",
  },
  {
    id: 17,
    src: memeUrl(17),
    emoji: "⏳💀",
    caption: "Rate limited mid-vibe",
  },
  {
    id: 18,
    src: memeUrl(18),
    emoji: "🤫",
    caption: "It compiled. Don't ask how.",
  },
  {
    id: 19,
    src: memeUrl(19),
    emoji: "👍👀",
    caption: "LGTM (did not read)",
  },
  {
    id: 20,
    src: memeUrl(20),
    emoji: "🤝🤖",
    caption: "Merge conflict? Ask the AI.",
  },
  {
    id: 21,
    src: memeUrl(21),
    emoji: "💪⌨️",
    caption: "Prompt harder.",
  },
  {
    id: 22,
    src: memeUrl(22),
    emoji: "💸🪙",
    caption: "Tokens are my whole budget",
  },
];

// Four CORNER zones, pinned to the window edges in PIXELS so cards never
// overflow regardless of window size. We always pick 3 DISTINCT corners, so any
// two cards sharing a side are always top+bottom (never stacked) and can't
// overlap. The centered logo/buttons stay clear because every zone hugs a
// corner. Jitter is small and stays within the corner's quadrant.
type VEdge = "top" | "bottom";
type HEdge = "left" | "right";
interface Zone {
  v: VEdge;
  h: HEdge;
  vInset: number;
  hInset: number;
}

const ZONES: Zone[] = [
  { v: "top", h: "left", vInset: 28, hInset: 18 },
  { v: "top", h: "right", vInset: 28, hInset: 18 },
  { v: "bottom", h: "left", vInset: 22, hInset: 18 },
  { v: "bottom", h: "right", vInset: 22, hInset: 18 },
];

interface Placed extends Meme {
  v: VEdge;
  h: HEdge;
  vInset: number;
  hInset: number;
  rotate: number;
}

function pickFour(): Placed[] {
  // 4 distinct memes, one per corner — every corner is filled and no two cards
  // share a corner, so they can't overlap.
  const memes = [...MEMES].sort(() => Math.random() - 0.5).slice(0, ZONES.length);
  const zones = [...ZONES].sort(() => Math.random() - 0.5);
  return memes.map((m, i) => {
    const zone = zones[i]!;
    // Small jitter that keeps the card inside its corner (positive from each
    // anchored edge so it drifts inward, never toward the opposite card).
    return {
      ...m,
      ...zone,
      vInset: zone.vInset + Math.random() * 8,
      hInset: zone.hInset + Math.random() * 12,
      rotate: Math.random() * 8 - 4,
    };
  });
}

/**
 * Decorative floating meme cards on the home screen — 4 of many shown at once (one
 * per corner), rotating every few seconds with a fade. Purely for flair;
 * pointer-events disabled so it never blocks the buttons.
 */
export function MemeLayer(): React.ReactElement | null {
  const on = useMemesEnabled();
  const [picks, setPicks] = useState<Placed[]>(() => pickFour());
  // Re-roll the set on an interval; keyed remount drives the fade-in.
  const [cycle, setCycle] = useState(0);

  useEffect(() => {
    // No rotation timer while the GIF layer is hidden.
    if (!on) return;
    const id = setInterval(() => {
      setPicks(pickFour());
      setCycle((c) => c + 1);
    }, 6000);
    return () => clearInterval(id);
  }, [on]);

  const cards = useMemo(
    () =>
      picks.map((m) => (
        <div
          key={`${cycle}-${m.id}`}
          className="meme-card"
          style={
            {
              [m.v]: `${m.vInset}px`,
              [m.h]: `${m.hInset}px`,
              // Rotation is exposed as a custom property so the entrance keyframe
              // can combine it with a scale/rise without clobbering the angle.
              "--rot": `${m.rotate}deg`,
            } as React.CSSProperties
          }
        >
          <MemeCardBody meme={m} />
        </div>
      )),
    [picks, cycle],
  );

  if (!on) return null;

  return (
    <div className="meme-layer" aria-hidden="true">
      {cards}
    </div>
  );
}

/**
 * One card: the GIF, or — if it fails to load — a graceful emoji/caption
 * fallback so a dead URL never leaves an empty card.
 */
function MemeCardBody({ meme }: { meme: Placed }): React.ReactElement {
  const [failed, setFailed] = useState(false);
  return (
    <>
      {failed ? (
        <span className="meme-emoji">{meme.emoji}</span>
      ) : (
        <img
          className="meme-gif"
          src={meme.src}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
        />
      )}
      {/* Caption overlays the GIF at the bottom with a gradient scrim. */}
      <span className="meme-caption">{meme.caption}</span>
    </>
  );
}
