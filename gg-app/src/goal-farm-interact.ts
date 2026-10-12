// Poking things on the Goal farm. Clicking (or pressing Enter on) something
// makes it react: lights switch on and off, animals each have three or four
// reactions they cycle through, critters wave and hop without stopping work,
// props and trees rattle, shake and puff. It's only play: nothing here
// changes what the agents are doing. Pure apart from the play state, which
// the view keeps and passes to the renderer.

import type { Spot } from "./goal-farm-travel";

export type ThingKind =
  | "lantern"
  | "house"
  | "annex"
  | "campfire"
  | "stove"
  | "kennel"
  | "board"
  | "kura"
  | "well"
  | "pond"
  | "spout"
  | "torii"
  | "postbox"
  | "bookcase"
  | "laptop"
  | "bench"
  | "teabench"
  | "sakura"
  | "tree"
  | "camellia"
  | "yuzu"
  | "bush"
  | "stone"
  | "field"
  | "creel"
  | "hen"
  | "cat"
  | "shiba"
  | "dragonfly"
  | "butterflies"
  | "critter"
  | "coordinator"
  | "ground";

/** Things that are lights: poking one switches it on or off. */
export const LIGHTS: ReadonlySet<ThingKind> = new Set<ThingKind>([
  "lantern",
  "house",
  "annex",
  "campfire",
]);

/** What each thing does, in the order it cycles through them. */
export const REACTIONS: Readonly<Record<ThingKind, readonly string[]>> = {
  lantern: ["toggle"],
  house: ["toggle"],
  annex: ["toggle"],
  campfire: ["toggle"],
  stove: ["rattle", "puff", "flare"],
  kennel: ["creak", "zzz"],
  board: ["flutter", "note"],
  kura: ["mouse", "dust"],
  well: ["draw", "pebble", "echo"],
  pond: ["splash", "dart", "feed"],
  spout: ["gush", "clack"],
  torii: ["petals", "glimmer"],
  postbox: ["letter", "flag"],
  bookcase: ["book", "dust"],
  laptop: ["wake", "beep"],
  bench: ["hammer", "saw"],
  teabench: ["steam", "spin"],
  sakura: ["shake", "bird"],
  tree: ["shake", "bird"],
  camellia: ["shake", "bird"],
  yuzu: ["shake", "bird"],
  bush: ["rustle", "bird", "butterfly"],
  stone: ["hop"],
  field: ["sway", "sprout"],
  creel: ["flop"],
  hen: ["startle", "flap", "peck", "egg"],
  cat: ["hiss", "groom", "roll", "pounce"],
  shiba: ["yawn", "wag", "roll", "woof"],
  dragonfly: ["zip", "land"],
  butterflies: ["scatter", "land"],
  critter: ["wave", "jump", "heart", "spin"],
  coordinator: ["summary", "jump", "heart"],
  ground: ["puff"],
};

/** How long a reaction plays, by action (ms); anything not listed takes the default. */
const DURATION: Readonly<Record<string, number>> = {
  toggle: 700,
  egg: 7000,
  roll: 1900,
  groom: 2200,
  yawn: 2600,
  wag: 1800,
  land: 3600,
  zip: 3200,
  scatter: 2400,
  dart: 1600,
  feed: 2600,
  wave: 2400,
  summary: 3200,
  spin: 900,
  draw: 2000,
  echo: 2600,
  mouse: 2400,
  wake: 2600,
  steam: 2400,
  zzz: 2600,
  letter: 2400,
  petals: 2600,
  shake: 1500,
  bird: 2200,
  butterfly: 2600,
  sprout: 2000,
};
const DEFAULT_MS = 1300;

/** Words for each reaction, for the live region (and some bubbles). */
const SAID: Readonly<Record<string, string>> = {
  "lantern:on": "The stone lantern is lit.",
  "lantern:off": "The stone lantern goes out.",
  "house:on": "The farmhouse lights come on.",
  "house:off": "The farmhouse lights go out.",
  "annex:on": "The side house light comes on.",
  "annex:off": "The side house light goes out.",
  "campfire:on": "The campfire roars back to life.",
  "campfire:off": "The campfire dies down to embers.",
  "stove:rattle": "The pot lid rattles.",
  "stove:puff": "Steam puffs from the pots.",
  "stove:flare": "The stove fire flares.",
  "kennel:creak": "The kennel creaks.",
  "kennel:zzz": "Snores come from the kennel.",
  "board:flutter": "A note flutters on the board.",
  "board:note": "A new note is pinned up.",
  "kura:mouse": "A mouse peeks out of the storehouse.",
  "kura:dust": "Dust drifts from the storehouse.",
  "well:draw": "Water is drawn from the well.",
  "well:pebble": "Plink. A pebble drops into the well.",
  "well:echo": "Hello echoes up from the well.",
  "pond:splash": "A koi splashes.",
  "pond:dart": "The koi dart away.",
  "pond:feed": "The koi rise for food.",
  "spout:gush": "The bamboo spout gushes.",
  "spout:clack": "Clack. The spout tips over.",
  "torii:petals": "Petals drift through the torii.",
  "torii:glimmer": "The torii glimmers.",
  "postbox:letter": "A letter peeks out of the post box.",
  "postbox:flag": "The post box flag flips up.",
  "bookcase:book": "A book slides out and back.",
  "bookcase:dust": "Dust puffs off the shelves.",
  "laptop:wake": "The laptop screen wakes.",
  "laptop:beep": "The laptop beeps.",
  "bench:hammer": "Tap, tap. Wood shavings fly.",
  "bench:saw": "A saw rasps through a plank.",
  "teabench:steam": "Steam curls from the teapot.",
  "teabench:spin": "The parasol spins.",
  "sakura:shake": "Petals shower from the cherry tree.",
  "sakura:bird": "A bird flies out of the cherry tree.",
  "tree:shake": "The tree rustles.",
  "tree:bird": "A bird flies out of the tree.",
  "camellia:shake": "A camellia flower drops.",
  "camellia:bird": "A bird flies out of the camellia.",
  "yuzu:shake": "A yuzu drops and rolls.",
  "yuzu:bird": "A bird flies out of the yuzu tree.",
  "bush:rustle": "The bush rustles.",
  "bush:bird": "A bird pops out of the bush.",
  "bush:butterfly": "A butterfly flutters out of the bush.",
  "stone:hop": "Hop.",
  "field:sway": "The crops sway.",
  "field:sprout": "Something sprouts.",
  "creel:flop": "A fish flops in the creel.",
  "hen:startle": "Bawk! The hen jumps.",
  "hen:flap": "The hen flaps her wings.",
  "hen:peck": "The hen pecks frantically.",
  "hen:egg": "The hen lays an egg.",
  "cat:hiss": "Hiss. The cat arches its back.",
  "cat:groom": "The cat sits down to groom.",
  "cat:roll": "The cat rolls over.",
  "cat:pounce": "The cat pounces.",
  "shiba:yawn": "The shiba wakes with a yawn.",
  "shiba:wag": "The shiba wags its tail.",
  "shiba:roll": "The shiba rolls over.",
  "shiba:woof": "Woof!",
  "dragonfly:zip": "The dragonfly zips off.",
  "dragonfly:land": "The dragonfly lands on a lily pad.",
  "butterflies:scatter": "The butterflies scatter.",
  "butterflies:land": "A butterfly lands nearby.",
  "ground:snow": "A puff of snow.",
  "ground:puddle": "Splash.",
  "ground:grass": "The grass rustles.",
  "ground:dirt": "A puff of dust.",
};

/** One reaction playing out: what, on what, where (map pixels), and when. */
export interface Reaction {
  readonly target: string;
  readonly kind: ThingKind;
  readonly action: string;
  readonly start: number;
  readonly until: number;
  readonly x: number;
  readonly y: number;
  /** Where it was set off from, if not where it lands (a pebble flicked off the pond's stones). */
  readonly from: Spot | null;
  /** Varies particles from one poke to the next. */
  readonly seed: number;
  /** Played because a critter is using the thing, not because it was poked (see goal-farm-use). */
  readonly use?: true;
}

/** Time an animal spends frozen in place by its reactions (so it resumes where it was). */
interface Pause {
  total: number;
  from: number;
  until: number;
}

/**
 * Everything play changes: which lights are off, the reactions playing out,
 * how far through its reactions each thing is, and the pointer.
 */
export interface FarmPlay {
  readonly lightsOff: Set<string>;
  reactions: Reaction[];
  readonly turns: Map<string, number>;
  readonly pauses: Map<string, Pause>;
  /** The koi's head start from being frightened (ms), and the latest dart. */
  readonly koi: { ahead: number; from: number };
  /** Where the pointer is (map pixels), or null off the canvas. */
  hover: Spot | null;
  /** The thing a keyboard user has focused (by id), or null. */
  focus: string | null;
  /** The thing under the pointer or focused this frame (set while drawing). */
  hovered: string | null;
  /** Outline images of things, made the first time each is hovered. */
  readonly rings: Map<string, CanvasImageSource>;
  /**
   * The farm painted without its trees and bushes (see paintSwayBase), once
   * it's ready: a swaying one is drawn over its own spot from this, so its
   * still self doesn't show behind it. Null until painted (it then just
   * sways over itself).
   */
  swayBase: { readonly farm: object; readonly image: CanvasImageSource } | null;
  /** Leaves, petals, fruit, feathers, shavings and drops: falling, then lying where they land. */
  debris: Debris[];
}

/**
 * Something knocked loose by a poke: it falls (swaying like a leaf, or in an
 * arc like a drop) from `from` to where it lands, `to`, rolls on to `rest`
 * (fruit), lies there (or floats, on water), and is gone at `until`. Each
 * piece goes at its own time, so a scatter thins out rather than vanishing.
 */
export interface Debris {
  readonly kind: "leaf" | "petal" | "fruit" | "feather" | "shaving" | "drop";
  readonly color: string;
  readonly size: 1 | 2;
  readonly from: Spot;
  readonly to: Spot;
  readonly rest: Spot;
  readonly start: number;
  readonly land: number;
  readonly until: number;
  /** Sideways sway while falling (leaves), and how high it arcs (drops). */
  readonly sway: number;
  readonly arc: number;
  /** Landed on water: it floats, and rings the water as it lands. */
  readonly water: boolean;
  readonly seed: number;
}

/** At most this much lies about at once; the oldest goes first. */
const MAX_DEBRIS = 160;

/** Add what a poke knocked loose, keeping no more than MAX_DEBRIS. */
export function addDebris(play: FarmPlay, items: readonly Debris[]): void {
  if (items.length === 0) return;
  play.debris.push(...items);
  if (play.debris.length > MAX_DEBRIS) {
    play.debris.sort((a, b) => a.start - b.start);
    play.debris.splice(0, play.debris.length - MAX_DEBRIS);
  }
}

export function createPlay(): FarmPlay {
  return {
    lightsOff: new Set(),
    reactions: [],
    turns: new Map(),
    pauses: new Map(),
    koi: { ahead: 0, from: -Infinity },
    hover: null,
    focus: null,
    hovered: null,
    rings: new Map(),
    swayBase: null,
    debris: [],
  };
}

/** What was poked, and where. */
export interface Poke {
  readonly target: string;
  readonly kind: ThingKind;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  /** For the ground: what's there (snow, a puddle, grass or dirt). */
  readonly ground?: "snow" | "puddle" | "grass" | "dirt";
  /** Where it was set off from, if not (x, y) (see Reaction.from). */
  readonly from?: Spot;
}

/** Animals that freeze where they are while they react, then carry on. */
const FREEZES: ReadonlySet<ThingKind> = new Set<ThingKind>(["hen", "cat", "shiba"]);

/** How long the koi dart when frightened, and how much further round their loop they get. */
export const KOI_DART_MS = 1600;
const KOI_DART_AHEAD = 4200;

/**
 * Poke something: start its next reaction (lights switch instead), and say
 * what happened. `now` is the frame clock (ms); `seed` varies the particles.
 */
export function poke(play: FarmPlay, p: Poke, now: number, seed: number): string {
  const actions = REACTIONS[p.kind];
  const turn = play.turns.get(p.target) ?? 0;
  play.turns.set(p.target, turn + 1);
  let action = p.kind === "ground" ? (p.ground ?? "dirt") : (actions[turn % actions.length] ?? "");
  if (LIGHTS.has(p.kind)) {
    const off = play.lightsOff.has(p.target);
    if (off) play.lightsOff.delete(p.target);
    else play.lightsOff.add(p.target);
    action = off ? "on" : "off";
  }
  const ms = DURATION[action] ?? DEFAULT_MS;
  // A new reaction on the same thing replaces the one playing.
  play.reactions = play.reactions.filter((r) => r.target !== p.target || r.kind === "pond");
  play.reactions.push({
    target: p.target,
    kind: p.kind,
    action,
    start: now,
    until: now + ms,
    x: p.x,
    y: p.y,
    from: p.from ?? null,
    seed,
  });
  if (FREEZES.has(p.kind)) freeze(play, p.target, now, ms);
  if (p.kind === "pond" && action === "dart") {
    play.koi.ahead += KOI_DART_AHEAD;
    play.koi.from = now;
  }
  const said = SAID[`${p.kind}:${action}`];
  if (said) return said;
  if (p.kind === "critter" || p.kind === "coordinator") return critterLine(p.name, action);
  return `You poke the ${p.name.toLowerCase()}.`;
}

/**
 * A thing playing `action` because a critter is using it: a reaction like a
 * poke's, but it changes nothing else (no turn taken, no freeze) and says
 * nothing. The seed comes from the clock, so the same frame plays the same.
 */
export function startUse(
  play: FarmPlay,
  thing: {
    readonly target: string;
    readonly kind: ThingKind;
    readonly x: number;
    readonly y: number;
  },
  action: string,
  now: number,
): void {
  play.reactions.push({
    target: thing.target,
    kind: thing.kind,
    action,
    start: now,
    until: now + (DURATION[action] ?? DEFAULT_MS),
    x: thing.x,
    y: thing.y,
    from: null,
    seed: Math.floor(now) % 9973,
    use: true,
  });
}

function critterLine(name: string, action: string): string {
  switch (action) {
    case "wave":
      return `${name} waves.`;
    case "jump":
      return `${name} jumps.`;
    case "heart":
      return `${name} is happy.`;
    case "spin":
      return `${name} spins round.`;
    case "summary":
      return `${name} gives an update.`;
    default:
      return `${name} looks up.`;
  }
}

/** Hold an animal where it is for `ms` (extending a pause still running). */
function freeze(play: FarmPlay, target: string, now: number, ms: number): void {
  const p = play.pauses.get(target);
  if (!p) {
    play.pauses.set(target, { total: 0, from: now, until: now + ms });
    return;
  }
  if (now < p.until) {
    p.until = now + ms;
    return;
  }
  p.total += p.until - p.from;
  p.from = now;
  p.until = now + ms;
}

/**
 * An animal's own clock (ms): the frame clock minus the time it has spent
 * frozen, held still while it's frozen now. Its loop reads from this, so it
 * picks up exactly where it stopped.
 */
export function animalClock(play: FarmPlay | null, target: string, now: number): number {
  const p = play?.pauses.get(target);
  if (!p) return now;
  if (now < p.from) return now - p.total;
  if (now < p.until) return p.from - p.total;
  return now - p.total - (p.until - p.from);
}

/** The koi's clock (ms): ahead of the frame clock by every dart, easing through the latest. */
export function koiClock(play: FarmPlay | null, now: number): number {
  if (!play) return now;
  const { ahead, from } = play.koi;
  const t = (now - from) / KOI_DART_MS;
  if (t >= 1 || t < 0) return now + ahead;
  // The latest dart: its head start eases in (fast, then gliding to a stop).
  const eased = 1 - (1 - t) ** 3;
  return now + ahead - KOI_DART_AHEAD * (1 - eased);
}

/** The reaction playing on `target` now, if any. */
export function reactionOn(play: FarmPlay | null, target: string, now: number): Reaction | null {
  if (!play) return null;
  for (let i = play.reactions.length - 1; i >= 0; i--) {
    const r = play.reactions[i];
    if (r && r.target === target && now < r.until) return r;
  }
  return null;
}

/** How far through a reaction it is (0–1). */
export function progress(r: Reaction, now: number): number {
  return Math.max(0, Math.min(1, (now - r.start) / Math.max(1, r.until - r.start)));
}

/** Drop reactions that have finished. */
export function settlePlay(play: FarmPlay, now: number): void {
  if (play.reactions.some((r) => now >= r.until)) {
    play.reactions = play.reactions.filter((r) => now < r.until);
  }
  if (play.debris.some((d) => now >= d.until)) {
    play.debris = play.debris.filter((d) => now < d.until);
  }
}

/**
 * Is anything still moving (so the farm keeps drawing at full rate)? Debris
 * only while it's falling, rolling or ringing the water; lying still, the
 * idle rate is plenty. Things in use don't count (see `usesNeedPace`): they
 * play for as long as anyone works, and don't need the full rate.
 */
export function playing(play: FarmPlay | null, now: number): boolean {
  return (
    play !== null &&
    (play.reactions.some((r) => !r.use && now < r.until) ||
      play.debris.some((d) => now < d.land + 800))
  );
}

/** The kind of ground at a map pixel, for a click on open ground. */
export function groundAt(
  surface: number,
  rgb: number,
  puddle: boolean,
  snowy: boolean,
): "snow" | "puddle" | "grass" | "dirt" {
  if (puddle) return "puddle";
  if (snowy) return "snow";
  const r = (rgb >> 16) & 255;
  const g = (rgb >> 8) & 255;
  return g > r ? "grass" : surface >= 0 ? "dirt" : "dirt";
}
