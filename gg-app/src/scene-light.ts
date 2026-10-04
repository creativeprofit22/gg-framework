// The light over the home screen's campfire clearing, from the local clock.
// Five looks, blended smoothly from one to the next:
//
//   night   (22:00–4:30)  the fire is the only light: embers, stars, moon,
//                          and an owl watching from the pines
//   dawn    (6:00–7:00)   morning fire: burned down to coals, a curl of smoke,
//                          mist in the trees, the last stars, birds waking
//   day     (9:00–16:00)  the fire's out: smoke from the ashes, sunbeams
//                          through the pines, pollen drifting in them
//   golden  (17:45–19:00) the fire's lit again: low sun, gold light, first
//                          embers, birds flying home
//   dusk    (20:00–20:45) blue hour: fire roaring, fireflies, bats, stars
//
// Every look keeps the top of the sky dark enough for the white logo and
// buttons (see skyAt), and the brightest light stays low or off to the side.
// Pure, so every hour can be tested and previewed.

export type Rgb = readonly [number, number, number];

type ColorKey =
  | "skyTop"
  | "skyMid"
  | "skyLow"
  | "sun"
  | "glow"
  | "ridge"
  | "treeFar"
  | "treeNear"
  | "mist"
  | "smoke";

type LevelKey =
  | "fire"
  | "smokeLevel"
  | "mistLevel"
  | "stars"
  | "fireflies"
  | "pollen"
  | "beams"
  | "birds"
  | "bats"
  | "owl"
  | "groundBrightness"
  | "groundSaturate"
  | "groundSepia";

/**
 * One moment's light. Colours are art, not theme roles. Levels run 0–1 and
 * say how much of each detail is out: `fire` scales the glow and the embers,
 * `smokeLevel` the smoke column, `mistLevel` the haze in the trees, and so on.
 * The `ground*` levels tint the critters' terrain to match (a CSS filter).
 */
export type SceneLight = Readonly<Record<ColorKey, Rgb> & Record<LevelKey, number>>;

type Keyframe = Readonly<Record<ColorKey, string> & Record<LevelKey, number>>;

const NIGHT: Keyframe = {
  skyTop: "#05060c",
  skyMid: "#0a0c1a",
  skyLow: "#171a2e",
  sun: "#000000",
  glow: "#1c2038",
  ridge: "#10121f",
  treeFar: "#0b0c16",
  treeNear: "#06050a",
  mist: "#262a40",
  smoke: "#5a4a48",
  fire: 1,
  smokeLevel: 0.35,
  mistLevel: 0.15,
  stars: 1,
  fireflies: 0.3,
  pollen: 0,
  beams: 0,
  birds: 0,
  bats: 0.15,
  owl: 1,
  groundBrightness: 0.62,
  groundSaturate: 0.85,
  groundSepia: 0.28,
};

const DAWN: Keyframe = {
  skyTop: "#161a33",
  skyMid: "#383a5c",
  skyLow: "#b0807e",
  sun: "#ffd9b0",
  glow: "#e8a08a",
  ridge: "#5a4a68",
  treeFar: "#3a3450",
  treeNear: "#14121e",
  mist: "#c0a8b4",
  smoke: "#b8aab4",
  fire: 0.3,
  smokeLevel: 1,
  mistLevel: 1,
  stars: 0.3,
  fireflies: 0,
  pollen: 0,
  beams: 0.35,
  birds: 0.8,
  bats: 0,
  owl: 0.15,
  groundBrightness: 0.8,
  groundSaturate: 0.8,
  groundSepia: 0.1,
};

// Day stays soft: a dusty teal under the pines, never a bright blue.
const DAY: Keyframe = {
  skyTop: "#14222f",
  skyMid: "#25424f",
  skyLow: "#5f817a",
  sun: "#f2ead0",
  glow: "#c8d6b0",
  ridge: "#3e5a5a",
  treeFar: "#253a3a",
  treeNear: "#0b1616",
  mist: "#90aaa0",
  smoke: "#a8b4b0",
  fire: 0,
  smokeLevel: 0.45,
  mistLevel: 0.12,
  stars: 0,
  fireflies: 0,
  pollen: 1,
  beams: 1,
  birds: 0.6,
  bats: 0,
  owl: 0,
  groundBrightness: 0.94,
  groundSaturate: 0.92,
  groundSepia: 0,
};

const GOLDEN: Keyframe = {
  skyTop: "#18132e",
  skyMid: "#432340",
  skyLow: "#c4744c",
  sun: "#ffe0a0",
  glow: "#f09a50",
  ridge: "#6a3442",
  treeFar: "#3e1e30",
  treeNear: "#150a12",
  mist: "#d89a7a",
  smoke: "#c8a090",
  fire: 0.6,
  smokeLevel: 0.45,
  mistLevel: 0.3,
  stars: 0.05,
  fireflies: 0.1,
  pollen: 0.6,
  beams: 0.75,
  birds: 1,
  bats: 0,
  owl: 0,
  groundBrightness: 0.86,
  groundSaturate: 1.05,
  groundSepia: 0.25,
};

const DUSK: Keyframe = {
  skyTop: "#090b20",
  skyMid: "#1a1b40",
  skyLow: "#5a4068",
  sun: "#000000",
  glow: "#8a5068",
  ridge: "#2a2442",
  treeFar: "#16142a",
  treeNear: "#08070e",
  mist: "#4a4262",
  smoke: "#6a5a68",
  fire: 1,
  smokeLevel: 0.3,
  mistLevel: 0.4,
  stars: 0.6,
  fireflies: 1,
  pollen: 0,
  beams: 0,
  birds: 0.15,
  bats: 1,
  owl: 0.4,
  groundBrightness: 0.7,
  groundSaturate: 0.9,
  groundSepia: 0.22,
};

/** Hours (0–24) the light passes through each keyframe, in order. */
const TIMELINE: readonly (readonly [number, Keyframe])[] = [
  [0, NIGHT],
  [4.5, NIGHT],
  [6, DAWN],
  [7, DAWN],
  [9, DAY],
  [16, DAY],
  [17.75, GOLDEN],
  [19, GOLDEN],
  [20, DUSK],
  [20.75, DUSK],
  [22, NIGHT],
  [24, NIGHT],
];

/** A typical hour for each of the five looks (previews and tests). */
export const MOMENTS = [
  { id: "dawn", label: "Morning fire", hour: 6.5 },
  { id: "day", label: "Lazy afternoon", hour: 13 },
  { id: "golden", label: "Golden hour", hour: 18.4 },
  { id: "dusk", label: "Blue hour", hour: 20.4 },
  { id: "night", label: "Deep night", hour: 23.5 },
] as const;

/** The sun touches the horizon at these hours. */
export const SUNRISE_HOUR = 6;
export const SUNSET_HOUR = 19.5;
const MOONRISE_HOUR = 20;
const MOONSET_HOUR = 6;

function parseHex(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function blend(a: Keyframe, b: Keyframe, t: number): SceneLight {
  const c = (key: ColorKey): Rgb => mixRgb(parseHex(a[key]), parseHex(b[key]), t);
  const n = (key: LevelKey): number => a[key] + (b[key] - a[key]) * t;
  return {
    skyTop: c("skyTop"),
    skyMid: c("skyMid"),
    skyLow: c("skyLow"),
    sun: c("sun"),
    glow: c("glow"),
    ridge: c("ridge"),
    treeFar: c("treeFar"),
    treeNear: c("treeNear"),
    mist: c("mist"),
    smoke: c("smoke"),
    fire: n("fire"),
    smokeLevel: n("smokeLevel"),
    mistLevel: n("mistLevel"),
    stars: n("stars"),
    fireflies: n("fireflies"),
    pollen: n("pollen"),
    beams: n("beams"),
    birds: n("birds"),
    bats: n("bats"),
    owl: n("owl"),
    groundBrightness: n("groundBrightness"),
    groundSaturate: n("groundSaturate"),
    groundSepia: n("groundSepia"),
  };
}

/** Wraps any hour into [0, 24). */
export function wrapHour(hour: number): number {
  return ((hour % 24) + 24) % 24;
}

/** The scenery's light at a local hour (fractional, 0–24). */
export function lightAt(hour: number): SceneLight {
  const h = wrapHour(hour);
  for (let i = 1; i < TIMELINE.length; i++) {
    const next = TIMELINE[i];
    const prev = TIMELINE[i - 1];
    if (!next || !prev || h > next[0]) continue;
    const span = next[0] - prev[0];
    const t = span > 0 ? smoothstep((h - prev[0]) / span) : 0;
    return blend(prev[1], next[1], t);
  }
  return blend(NIGHT, NIGHT, 0);
}

/**
 * Where the sky's gradient stops sit, as a fraction of the way from the top of
 * the window down to the horizon. The renderer and skyAt share these.
 */
export const SKY_STOPS = [
  [0, "top"],
  [0.55, "mid"],
  [0.85, "haze"],
  [1, "low"],
] as const;

/** The sky's colour at `v` (0 = top of the window, 1 = the horizon). */
export function skyAt(light: SceneLight, v: number): Rgb {
  const colors: Record<(typeof SKY_STOPS)[number][1], Rgb> = {
    top: light.skyTop,
    mid: light.skyMid,
    haze: mixRgb(light.skyMid, light.skyLow, 0.4),
    low: light.skyLow,
  };
  const x = clamp01(v);
  for (let i = 1; i < SKY_STOPS.length; i++) {
    const next = SKY_STOPS[i];
    const prev = SKY_STOPS[i - 1];
    if (!next || !prev || x > next[0]) continue;
    return mixRgb(colors[prev[1]], colors[next[1]], (x - prev[0]) / (next[0] - prev[0]));
  }
  return light.skyLow;
}

/**
 * Where a sun or moon sits: `x` across the window (0–1) and `elevation`, 1 at
 * its highest, 0 on the horizon, negative below it (−1 once it's well gone).
 */
export interface SkyBody {
  readonly x: number;
  readonly elevation: number;
}

function arc(hour: number, rise: number, set: number, xFrom: number, xTo: number): SkyBody {
  const span = wrapHour(set - rise);
  const since = wrapHour(hour - rise);
  if (since <= span) {
    const p = since / span;
    return { x: xFrom + (xTo - xFrom) * p, elevation: Math.sin(Math.PI * p) };
  }
  // Below the horizon: hold at whichever edge it's nearer, sinking with time.
  const afterSet = since - span;
  const beforeRise = 24 - since;
  const setting = afterSet < beforeRise;
  return {
    x: setting ? xTo : xFrom,
    elevation: -Math.min(1, Math.min(afterSet, beforeRise) / 1.5),
  };
}

/** The sun rises left of centre and sets right of it, clear of the buttons. */
export function sunAt(hour: number): SkyBody {
  return arc(hour, SUNRISE_HOUR, SUNSET_HOUR, 0.3, 0.74);
}

export function moonAt(hour: number): SkyBody {
  return arc(hour, MOONRISE_HOUR, MOONSET_HOUR, 0.3, 0.7);
}

/** The CSS filter that lights the critters' ground to match the scene. */
export function groundFilter(light: SceneLight): string {
  const f = (n: number): string => n.toFixed(2);
  return (
    `brightness(${f(light.groundBrightness)}) saturate(${f(light.groundSaturate)}) ` +
    `sepia(${f(light.groundSepia)})`
  );
}

/** The local time as a fractional hour (14:30 → 14.5). */
export function hourOf(date: Date): number {
  return date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
}
