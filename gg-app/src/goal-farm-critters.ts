// The farm's own critters, drawn for the Goal farm's high camera: we look
// down on them as on every building, so the top of the head (a big lit crown)
// is most of each sprite and the face sits low and squat under it, over a
// short body and feet peeking out. Only this world uses them; the app's
// floors keep their front-on critters.
//
// The farm is a Japanese countryside, so its workers are the critters that
// belong there: the app's fox, bee, cat, owl, frog and mushroom, redrawn and
// recoloured for it (a grey tabby, a tawny owl), plus a tanuki, rabbit,
// hedgehog, duck, red panda, squirrel, fawn and chick. 14 wide, 15 tall.
// Keys: O outline, T crown (lit), H crown highlight, B face, S and D the
// shaded lower body, W white, K eyes, C blush; the rest are per critter.

import { hashKey, type CritterDef } from "./critter-sprites";

/** Farm critter sprite size, in pixels. */
export const FARM_CRITTER_W = 14;
export const FARM_CRITTER_H = 15;

export const FARM_CRITTERS: readonly CritterDef[] = [
  {
    id: "fox",
    name: "Fox",
    move: "walk",
    palette: {
      O: "#4a1a06",
      T: "#f29a52",
      H: "#ffd4a0",
      B: "#e8782e",
      S: "#c25a1c",
      D: "#8a3a10",
      W: "#fff4e6",
      K: "#1b1208",
      C: "#ff7a6a",
      A: "#2a1208",
    },
    rows: [
      "..............",
      "..OA......AO..",
      "..OTO....OTO..",
      ".OTTO....OTTO.",
      "...OOOOOOOO...",
      "..OTTTTTTTTO..",
      ".OTTHTTTTTTTO.",
      ".OTTTTTTTTTTO.",
      ".OBBBBBBBBBBO.",
      ".OBWKBBBBWKBO.",
      ".OCBWWWWWWBCO.",
      "..OSWWKKWWSOO.",
      "..ODDDDDDDDOWO",
      "...OOOOOOOOOO.",
      "...OO....OO...",
    ],
    alt: { 14: "....OO..OO...." },
  },
  {
    id: "bee",
    name: "Bee",
    move: "hover",
    palette: {
      O: "#4a2a06",
      T: "#fde58a",
      H: "#fff8d0",
      B: "#f6c83a",
      S: "#d89a1a",
      D: "#2a1a08",
      W: "#ffffff",
      K: "#1b1208",
      C: "#ff8a5c",
      V: "#d8f0ff",
    },
    rows: [
      "....K....K....",
      ".....K..K.....",
      "..............",
      "..............",
      "...OOOOOOOO...",
      "..OTDDTTDDTO..",
      "VOTTHTTTTTTTOV",
      "VOTTDDTTDDTTOV",
      ".OBBBBBBBBBBO.",
      ".OBWKBBBBWKBO.",
      ".OCBBBBBBBBCO.",
      "..ODDDDDDDDO..",
      "..OSSSSSSSSO..",
      "...OOOOOOOO...",
      "......OO......",
    ],
    alt: { 14: "......OO......" },
  },
  {
    id: "cat",
    name: "Cat",
    move: "walk",
    palette: {
      O: "#2e2a26",
      T: "#b8b2a6",
      H: "#e0dace",
      B: "#9a948a",
      S: "#6e685e",
      D: "#4a453e",
      W: "#ffffff",
      K: "#1b1612",
      C: "#f2a6b4",
      A: "#f2a6b4",
      Z: "#5a554c",
    },
    rows: [
      "..............",
      "..............",
      "..O........O..",
      "..OAO....OAO..",
      "...OOOOOOOO...",
      "..OTZTTZTTZO..",
      ".OTTHZTTZTTTO.",
      ".OTTTTTTTTTTO.",
      ".OBBBBBBBBBBO.",
      ".OBWKBBBBWKBO.",
      ".OCBBBAABBBCO.",
      "..OSSSSSSSSO..",
      "O.ODDDDDDDDO..",
      ".OOOOOOOOOOO..",
      "...OO....OO...",
    ],
    alt: { 14: "....OO..OO...." },
  },
  {
    id: "owl",
    name: "Owl",
    move: "hover",
    palette: {
      O: "#2a1a0c",
      T: "#c89a64",
      H: "#ecc890",
      B: "#a8784a",
      S: "#7a5232",
      D: "#5a3a20",
      W: "#fbf2e2",
      K: "#1b1208",
      C: "#e8a07a",
      A: "#5a3a20",
      Y: "#f2a630",
    },
    rows: [
      "..............",
      "..OA......AO..",
      "..OAO....OAO..",
      "..............",
      "...OOOOOOOO...",
      "..OTTATTATTO..",
      ".OTTHTTTTTTTO.",
      ".OWWWTTTTWWWO.",
      ".OWKKWBBWKKWO.",
      ".OWWWBYYBWWWO.",
      ".OCBBBBBBBBCO.",
      "..OSTSTSTSSO..",
      "..ODSDSDSDDO..",
      "...OOOOOOOO...",
      "...YY....YY...",
    ],
    alt: { 14: "....YY..YY...." },
  },
  {
    id: "frog",
    name: "Frog",
    move: "hop",
    palette: {
      O: "#22401a",
      T: "#8ec45a",
      H: "#c4e49a",
      B: "#6aa83c",
      S: "#4a8228",
      D: "#2e5a1a",
      W: "#ffffff",
      K: "#0a1a08",
      C: "#f2a0a8",
    },
    rows: [
      "..............",
      "..............",
      "..OOO....OOO..",
      ".OWKKO..OWKKO.",
      ".OOOOOOOOOOOO.",
      "..OTTTTTTTTO..",
      ".OTTHTTTTTTTO.",
      ".OTTTTTTTTTTO.",
      ".OBBBBBBBBBBO.",
      ".OCBBKKKKBBCO.",
      ".OBBBBBBBBBBO.",
      "..OSSSSSSSSO..",
      "..ODDDDDDDDO..",
      "...OOOOOOOO...",
      "..OO......OO..",
    ],
    alt: { 14: "...OO....OO..." },
  },
  {
    id: "shroom",
    name: "Shroom",
    move: "walk",
    palette: {
      O: "#4a0a18",
      T: "#e8443a",
      H: "#ff8a7a",
      B: "#f4e2c4",
      S: "#d8c0a0",
      D: "#b09a7a",
      W: "#fffaf0",
      K: "#2a0d14",
      C: "#ff9ab0",
      Z: "#a82a24",
    },
    rows: [
      "..............",
      "....OOOOOO....",
      "..OOTTWWTTOO..",
      ".OTTHTWWTTWWO.",
      "OTWWTTTTTWWTZO",
      "OTWWTTTTTTTZZO",
      "OOOOOOOOOOOOOO",
      "..OBBBBBBBBO..",
      "..OBWKBBWKBO..",
      "..OCBBBBBBCO..",
      "..OSSSSSSSSO..",
      "..ODDDDDDDDO..",
      "...OOOOOOOO...",
      "..............",
      "...OO....OO...",
    ],
    alt: { 14: "....OO..OO...." },
  },
  {
    id: "tanuki",
    name: "Tanuki",
    move: "walk",
    palette: {
      O: "#2a1408",
      T: "#c8925a",
      H: "#e8c08a",
      B: "#b07a48",
      S: "#8a5a30",
      D: "#5a3a1c",
      W: "#ffffff",
      K: "#1b1208",
      C: "#f2a07a",
      A: "#3a2010",
      F: "#f4e2c4",
    },
    rows: [
      "..............",
      "..............",
      "..OO......OO..",
      ".OAAO....OAAO.",
      "...OOOOOOOO...",
      "..OTTTTTTTTO..",
      ".OTTHTTTTTTTO.",
      ".OTTTTTTTTTTO.",
      ".OBAAABBAAABO.",
      ".OAWKABBAWKAO.",
      ".OCBAFFFFABCO.",
      "..OSSFKKFSSO..",
      "..ODDDDDDDDO..",
      "...OOOOOOOO...",
      "...OO....OO...",
    ],
    alt: { 14: "....OO..OO...." },
  },
  {
    id: "rabbit",
    name: "Rabbit",
    move: "hop",
    palette: {
      O: "#4a3030",
      T: "#fbf6ee",
      H: "#ffffff",
      B: "#f0e8dc",
      S: "#d8cabc",
      D: "#b8a898",
      W: "#ffffff",
      K: "#2a1418",
      C: "#f6a0b0",
      A: "#f4a6b4",
    },
    rows: [
      "..OO......OO..",
      ".OTAO....OATO.",
      ".OTAO....OATO.",
      "..OAO....OAO..",
      "...OOOOOOOO...",
      "..OTTTTTTTTO..",
      ".OTTHTTTTTTTO.",
      ".OTTTTTTTTTTO.",
      ".OBBBBBBBBBBO.",
      ".OBWKBBBBWKBO.",
      ".OCBBBAABBBCO.",
      "..OSSSKKSSSO..",
      "..ODDDDDDDDO..",
      "...OOOOOOOO...",
      "...OO....OO...",
    ],
    alt: { 14: "....OO..OO...." },
  },
  {
    id: "hedgehog",
    name: "Hedgehog",
    move: "scuttle",
    palette: {
      O: "#2a1808",
      T: "#8a5e38",
      H: "#b0845a",
      B: "#e8c494",
      S: "#c49a64",
      D: "#9a7444",
      W: "#ffffff",
      K: "#1b1208",
      C: "#f2a07a",
      A: "#5a3a20",
    },
    rows: [
      "..............",
      "...A.A.A.A....",
      "..ATATATATA...",
      ".ATATATATATA..",
      "ATOOOOOOOOOOTA",
      "ATTHTATATATTTA",
      ".OTATATATATAO.",
      ".OTTTTTTTTTTO.",
      ".OBBBBBBBBBBO.",
      ".OBWKBBBBWKBO.",
      ".OCBBBBKBBBCO.",
      "..OSSSSSSSSO..",
      "..ODDDDDDDDO..",
      "...OOOOOOOO...",
      "...OO....OO...",
    ],
    alt: { 14: "....OO..OO...." },
  },
  {
    id: "duck",
    name: "Duck",
    move: "walk",
    palette: {
      O: "#3a2e20",
      T: "#fdfaf2",
      H: "#ffffff",
      B: "#f4efe2",
      S: "#d8d0c0",
      D: "#b8ae9a",
      W: "#ffffff",
      K: "#1b1208",
      C: "#f6b0a0",
      Y: "#f2a630",
      Z: "#c8781a",
    },
    rows: [
      "..............",
      "..............",
      "......OO......",
      ".....OTTO.....",
      "...OOOOOOOO...",
      "..OTTTTTTTTO..",
      ".OTTHTTTTTTTO.",
      ".OTTTTTTTTTTO.",
      ".OBBBBBBBBBBO.",
      ".OBWKBBBBWKBO.",
      ".OCBBYYYYBBCO.",
      "..OSSZZZZSSO..",
      "..ODDDDDDDDO..",
      "...OOOOOOOO...",
      "...YY....YY...",
    ],
    alt: { 14: "....YY..YY...." },
  },
  {
    id: "redpanda",
    name: "Red panda",
    move: "walk",
    palette: {
      O: "#2a0e06",
      T: "#b8482a",
      H: "#d8724a",
      B: "#a83a1e",
      S: "#7a2812",
      D: "#4a180a",
      W: "#fbf2e2",
      K: "#1b0e08",
      C: "#f2a07a",
      A: "#3a140a",
    },
    rows: [
      "..............",
      "..O........O..",
      ".OWO......OWO.",
      ".OAAO....OAAO.",
      "...OOOOOOOO...",
      "..OTTTTTTTTO..",
      ".OTTHTTTTTTTO.",
      ".OTWTTTTTTWTO.",
      ".OWWBBBBBBWWO.",
      ".OBWKBBBBWKBO.",
      ".OCBWWWWWWBCO.",
      "..OSSWKKWSSO..",
      "..OAAAAAAAAO..",
      "...OOOOOOOO...",
      "...AA....AA...",
    ],
    alt: { 14: "....AA..AA...." },
  },
  {
    id: "squirrel",
    name: "Squirrel",
    move: "hop",
    palette: {
      O: "#2a1408",
      T: "#e09050",
      H: "#f6b87a",
      B: "#c8783a",
      S: "#9a5424",
      D: "#6a3814",
      W: "#fbf0dc",
      K: "#1b0e08",
      C: "#f2a07a",
      A: "#e8a060",
      Y: "#d88a48",
    },
    rows: [
      "..O.......O.YY",
      ".OAO.....OAOYY",
      ".OTO.....OTOYY",
      "............YY",
      "...OOOOOOOOYYY",
      "..OTTTTTTTTOYY",
      ".OTTHTTTTTTTOY",
      ".OTTTTTTTTTTOY",
      ".OBBBBBBBBBBOY",
      ".OBWKBBBBWKBO.",
      ".OCBWWWWWWBCO.",
      "..OSSWKKWSSO..",
      "..ODDDDDDDDO..",
      "...OOOOOOOO...",
      "...OO....OO...",
    ],
    alt: { 14: "....OO..OO...." },
  },
  {
    id: "fawn",
    name: "Fawn",
    move: "walk",
    palette: {
      O: "#2a1808",
      T: "#d8a46c",
      H: "#f0c890",
      B: "#c8925a",
      S: "#a0703c",
      D: "#7a5024",
      W: "#fbf2e2",
      K: "#1b0e08",
      C: "#f2a07a",
      A: "#a0703c",
    },
    rows: [
      "..............",
      "..............",
      ".OAO......OAO.",
      "..OAO....OAO..",
      "...OOOOOOOO...",
      "..OTTWTTTTTO..",
      ".OTTHTTTTWTTO.",
      ".OTWTTTTTTTTO.",
      ".OBBBBBBBBBBO.",
      ".OBWKBBBBWKBO.",
      ".OCBBWWWWBBCO.",
      "..OSSWKKWSSO..",
      "..ODDDDDDDDO..",
      "...OOOOOOOO...",
      "...OO....OO...",
    ],
    alt: { 14: "....OO..OO...." },
  },
  {
    id: "chick",
    name: "Chick",
    move: "hop",
    palette: {
      O: "#5a3a08",
      T: "#ffe470",
      H: "#fff6b0",
      B: "#ffd94a",
      S: "#f2b02a",
      D: "#c8881a",
      W: "#ffffff",
      K: "#1b1208",
      C: "#ffa07a",
      Y: "#f28a2a",
    },
    rows: [
      "..............",
      "..............",
      "......O.O.....",
      ".......O......",
      "...OOOOOOOO...",
      "..OTTTTTTTTO..",
      ".OTTHTTTTTTTO.",
      ".OTTTTTTTTTTO.",
      ".OBBBBBBBBBBO.",
      ".OBWKBBBBWKBO.",
      ".OCBBBYYBBBCO.",
      "..OSSSSSSSSO..",
      "..ODDDDDDDDO..",
      "...OOOOOOOO...",
      "...YY....YY...",
    ],
    alt: { 14: "....YY..YY...." },
  },
];

/** Named agents that have a farm critter of their own; anything else is picked from its id. */
const FARM_CRITTER_FOR_AGENT: Readonly<Record<string, string>> = {
  // GG Goals' own team (packages/ggcoder/src/goals-agent/goal-team.ts).
  builder: "tanuki",
  scout: "squirrel",
  researcher: "owl",
  checker: "hedgehog",
  // GG Coder's agents, seen in older goal sessions.
  bee: "bee",
  owl: "owl",
  worker: "tanuki",
  auditor: "hedgehog",
  skeptic: "cat",
  "control-verifier": "frog",
};

/**
 * Choose a farm critter for an agent, the way the app's floor does: a named
 * agent gets its own critter when it's free; otherwise the id picks a
 * starting point and the first critter not already on the farm wins, so a
 * crowd stays varied. Once every farm critter is out, repeats are allowed.
 */
export function pickFarmCritter(
  agentName: string | undefined,
  key: string,
  taken: ReadonlySet<string>,
): CritterDef {
  const preferredId = agentName ? FARM_CRITTER_FOR_AGENT[agentName] : undefined;
  const preferred = FARM_CRITTERS.find((critter) => critter.id === preferredId);
  if (preferred && !taken.has(preferred.id)) return preferred;
  const start = hashKey(key) % FARM_CRITTERS.length;
  for (let step = 0; step < FARM_CRITTERS.length; step++) {
    const candidate = FARM_CRITTERS[(start + step) % FARM_CRITTERS.length];
    if (candidate && !taken.has(candidate.id)) return candidate;
  }
  const fallback = preferred ?? FARM_CRITTERS[start];
  if (!fallback) throw new Error("farm critter roster is empty");
  return fallback;
}

/**
 * GG Goals itself: a little Ken (the face of Ken, redrawn for the farm's high
 * camera). From up here his buzzcut crown is most of the sprite, his face
 * squat beneath it with the same narrow eyes, blush and grin, then a navy
 * tee and little feet. Not in FARM_CRITTERS: no worker is ever Ken, so GG
 * Goals stands apart from the crowd.
 */
export const KEN_FARM_CRITTER: CritterDef = {
  id: "ken",
  name: "Ken",
  move: "walk",
  palette: {
    O: "#1c120e", // outline
    T: "#3d302a", // buzzcut (lit crown)
    H: "#6e5a4d", // stubble flecks and the light on the crown
    A: "#ecbf9f", // ears
    B: "#f7dcc4", // skin
    D: "#e3b796", // skin shade
    K: "#1d1418", // eyes
    C: "#f4a99e", // blush
    M: "#b5554c", // smile
    S: "#2f4a7a", // tee
    W: "#4a6aa0", // tee, lit
    L: "#2a1e1a", // shoes
  },
  rows: [
    "..............",
    "...OOOOOOOO...",
    "..OTHTTTHTTO..",
    ".OTTTTHTTTTTO.",
    ".OTHTTTTTHTTO.",
    ".OTTTTTTTTTTO.",
    ".OHBBBBBBBBHO.",
    "OABBBBBBBBBBAO",
    "OABKKBBBBKKBAO",
    ".OCBBBDDBBBCO.",
    "..OBMBBBBMBO..",
    "..OBBMMMMBBO..",
    "..OSWWSSWWSO..",
    "...OOOOOOOO...",
    "...OL....LO...",
  ],
  alt: { 14: "....OL..LO...." },
};

const BY_ID = new Map([...FARM_CRITTERS, KEN_FARM_CRITTER].map((critter) => [critter.id, critter]));

/** A farm critter by id (the first one if unknown). */
export function farmCritterLook(id: string): CritterDef {
  const look = BY_ID.get(id) ?? FARM_CRITTERS[0];
  if (!look) throw new Error("farm critter roster is empty");
  return look;
}
