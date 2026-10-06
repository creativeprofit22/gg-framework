/**
 * Ambient window glow — position, and the state it reflects.
 *
 * Two jobs, both deliberately outside React so they can be unit-tested and so
 * the CSS stays declarative:
 *
 *  1. Give every window a DIFFERENT glow placement. Twelve tiled windows with
 *     an identical wash in an identical corner reads as a template; varying it
 *     makes each window feel like its own space. The variation is derived from
 *     the window label, so it is stable across reloads (a glow that jumped on
 *     every render would be noise, not character).
 *  2. Describe the agent's state as a glow state, so "working" is legible from
 *     across the room without reading a word of text.
 */

/** What the glow is currently saying. */
export type GlowState = "idle" | "working" | "done";

export interface GlowPlacement {
  /** Primary wash position, as CSS percentages. */
  x1: number;
  y1: number;
  /** Secondary, dimmer wash — always in the opposing half. */
  x2: number;
  y2: number;
  /** Size of the primary wash (% of the shell). */
  size: number;
  /** Degrees added to the hue, so tiled windows do not all glow identically. */
  hueShift: number;
}

/**
 * Deterministic 32-bit hash. Same label always yields the same placement, so a
 * window keeps its identity across reloads and restores.
 */
function hash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Pull a bounded value out of the hash, one independent stream per `salt`. */
function pick(seed: string, salt: number, min: number, max: number): number {
  const h = hash(`${seed}:${salt}`);
  return min + ((h % 1000) / 1000) * (max - min);
}

/**
 * Place the glow for one window.
 *
 * The primary wash is pinned to a corner-ish region rather than the middle: a
 * centred glow sits behind the transcript and washes out body text, while a
 * corner reads as light entering the window. The secondary is forced into the
 * opposite half so the two never stack into one blob.
 */
export function glowPlacement(seed: string): GlowPlacement {
  // Which corner the primary occupies — 4 possibilities, chosen by the label.
  const corner = hash(`${seed}:corner`) % 4;
  const nearEdge = (n: number): number => (n < 2 ? pick(seed, 1, 0, 22) : pick(seed, 2, 78, 100));
  const x1 = corner % 2 === 0 ? pick(seed, 3, 0, 24) : pick(seed, 4, 76, 100);
  const y1 = nearEdge(corner);
  return {
    x1: Math.round(x1),
    y1: Math.round(y1),
    // Opposing half, so the two washes read as two light sources.
    x2: Math.round(100 - x1),
    y2: Math.round(100 - y1),
    size: Math.round(pick(seed, 5, 38, 58)),
    // ±18° keeps every window inside the palette while stopping a tiled grid
    // from looking rubber-stamped.
    hueShift: Math.round(pick(seed, 6, -18, 18)),
  };
}

/** The CSS custom properties that drive `.app::before`. */
export function glowVars(p: GlowPlacement): Record<string, string> {
  return {
    "--glow-x1": `${p.x1}%`,
    "--glow-y1": `${p.y1}%`,
    "--glow-x2": `${p.x2}%`,
    "--glow-y2": `${p.y2}%`,
    "--glow-size": `${p.size}%`,
    // Unitless: consumed as `calc(h + var(--glow-hue))` inside hsl(from …),
    // where `h` is a bare number, so an angle unit here would not add.
    "--glow-hue": `${p.hueShift}`,
  };
}

/**
 * Map agent activity onto a glow state.
 *
 * `done` PERSISTS until the next run starts. A timed revert was wrong: the
 * glow would announce "finished", then quietly undo itself while the result
 * was still on screen and still the current state of the world. The window is
 * finished until you ask for something else, so the glow says so until then.
 *
 * `idle` therefore means "nothing has run in this window yet", not "a run
 * ended a while ago".
 */
export function glowStateFor(running: boolean, hasFinished: boolean): GlowState {
  if (running) return "working";
  return hasFinished ? "done" : "idle";
}
