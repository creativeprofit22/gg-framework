// Pixel critter sprites for the sub-agent "floor" (see CritterFloor.tsx).
// Each critter is a 14×14 grid facing right; the floor flips it in CSS when it
// walks left. Legend: `.` is transparent, any other character is a key into
// that critter's palette. `alt` lists only the rows that change for the second
// walk frame. Colours are art, not theme roles, so they stay literal here.

/** How a critter gets around the floor. */
export type CritterMove = "walk" | "hop" | "hover" | "float" | "scuttle" | "squish";

export interface CritterDef {
  readonly id: string;
  readonly name: string;
  readonly move: CritterMove;
  /** Palette key → colour. `B` is the body colour (beam, glow, tooltip swatch). */
  readonly palette: Readonly<Record<string, string>>;
  readonly rows: readonly string[];
  readonly alt: Readonly<Record<number, string>>;
}

/** Sprite grid edge, in cells. */
export const CRITTER_CELLS = 14;

const LEGS_A = "...OO....OO...";
const LEGS_B = "....OO..OO....";

// Shared chibi head (rows 4–12): big round mochi with eyes set slightly
// right so the walk direction reads.
const HEAD = [
  "...OOOOOOOO...",
  "..OHBBBBBBBO..",
  ".OHBBBBBBBBBO.",
  ".OBBWKBBBWKBO.",
  ".OBBKKBBBKKBO.",
  ".OCBBBBBBBBCO.",
  ".OBBBBBBBBBBO.",
  "..OSSSSSSSSO..",
  "...OOOOOOOO...",
];

function chibi(
  top: readonly string[],
  head: readonly string[] = HEAD,
  legs: readonly [string, string] = [LEGS_A, LEGS_B],
): Pick<CritterDef, "rows" | "alt"> {
  return { rows: [...top, ...head, legs[0]], alt: { 13: legs[1] } };
}

export const CRITTERS: readonly CritterDef[] = [
  {
    id: "bee",
    name: "Bee",
    move: "hover",
    palette: {
      O: "#6b3e00",
      B: "#ffd43b",
      H: "#fff3a0",
      S: "#f2a900",
      K: "#1b1530",
      W: "#ffffff",
      C: "#ff8a5c",
      V: "rgba(200,240,255,0.85)",
    },
    rows: [
      "....K....K....",
      ".....K..K.....",
      "...OOOOOOOO...",
      "..OHBBBBBBBO..",
      "VOHBBBBBBBBBOV",
      "VOBBWKBBBWKBOV",
      "VOBBKKBBBKKBOV",
      ".OCBBBBBBBBCO.",
      ".OKKKKKKKKKKO.",
      ".OBBBBBBBBBBO.",
      ".OKKKKKKKKKKO.",
      "..OSSSSSSSSO..",
      "...OOOOOOOO...",
      "......KK......",
    ],
    alt: {
      2: "VV.OOOOOOOO.VV",
      3: "VVOHBBBBBBBOVV",
      4: ".OHBBBBBBBBBO.",
      5: ".OBBWKBBBWKBO.",
      6: ".OBBKKBBBKKBO.",
    },
  },
  {
    id: "fox",
    name: "Fox",
    move: "walk",
    palette: {
      O: "#5c1f00",
      B: "#ff7a1a",
      H: "#ffb066",
      S: "#d94f00",
      W: "#fff4e6",
      K: "#1b1530",
      A: "#ffc2a1",
      C: "#ff4f6d",
    },
    ...chibi(
      ["..............", "..O........O..", "..OO......OO..", "..OAO....OAO.."],
      [
        "...OOOOOOOO...",
        "..OHBBBBBBBO..",
        ".OHBBBBBBBBBO.",
        ".OBBWKBBBWKBO.",
        ".OBBKKBBBKKBO.",
        ".OCBBWWWWBBCOO",
        ".OBBWWKKWWBBOB",
        "..OSSWWWWSSOBW",
        "...OOOOOOOOOWO",
      ],
    ),
  },
  {
    id: "cat",
    name: "Cat",
    move: "walk",
    palette: {
      O: "#00503a",
      B: "#3dffc5",
      H: "#b8fff0",
      S: "#10c994",
      W: "#ffffff",
      K: "#062018",
      A: "#ff7ab6",
      C: "#ff7ab6",
    },
    ...chibi(
      ["..............", "..............", "..O........O..", "..OAO....OAO.."],
      [
        "...OOOOOOOO...",
        "..OHBBBBBBBO..",
        ".OHBBBBBBBBBO.",
        ".OBBWKBBBWKBO.",
        ".OBBKKBBBKKBO.",
        "KOCBBBBABBBCOK",
        ".OBBBBKBKBBBO.",
        "O.OSSSSSSSSO..",
        ".OOOOOOOOOOO..",
      ],
    ),
  },
  {
    id: "owl",
    name: "Owl",
    move: "hop",
    palette: {
      O: "#24106b",
      B: "#8e6bff",
      H: "#c2b0ff",
      S: "#6a42f0",
      W: "#ffffff",
      K: "#120a2e",
      A: "#ffb020",
      L: "#e3dbff",
    },
    ...chibi(
      ["..............", "..............", "..OO......OO..", "...OO....OO..."],
      [
        "...OOOOOOOO...",
        "..OHBBBBBBBO..",
        ".OWWWBBBWWWBO.",
        ".OWKWBBBWKWBO.",
        ".OWWWBAABWWWO.",
        ".OBBBBAABBBBO.",
        ".OBLLBLLBLLBO.",
        "..OSLLSLLSSO..",
        "...OOOOOOOO...",
      ],
      ["...AA....AA...", "...AA....AA..."],
    ),
  },
  {
    id: "frog",
    name: "Frog",
    move: "hop",
    palette: {
      O: "#064d1e",
      B: "#3be36f",
      H: "#9bffb4",
      S: "#17b24a",
      W: "#ffffff",
      K: "#0a1a10",
      C: "#ff6fa8",
    },
    rows: [
      "..............",
      "..............",
      "...OOO..OOO...",
      "..OWWKOOWWKO..",
      "..OWKKBBWKKO..",
      ".OHBBBBBBBBBO.",
      ".OBBBBBBBBBBO.",
      ".OCBBBBBBBBCO.",
      ".OKBBBBBBBBKO.",
      ".OBKKKKKKKKBO.",
      ".OHBBBBBBBBBO.",
      "..OSSSSSSSSO..",
      "..OOOOOOOOOO..",
      "..OO......OO..",
    ],
    alt: { 13: "...OO....OO..." },
  },
  {
    id: "robot",
    name: "Robot",
    move: "walk",
    palette: {
      O: "#0e2370",
      B: "#4da3ff",
      H: "#b3d8ff",
      S: "#2a6ee0",
      A: "#ff3b5c",
      K: "#0a1030",
      C: "#5cf2ff",
    },
    rows: [
      "......AA......",
      "......OO......",
      "......OO......",
      "..OOOOOOOOOO..",
      "..OHHBBBBBBO..",
      "..OBKKKKKKBO..",
      "..OBKCKKKCBO..",
      "..OBKKKKKKBO..",
      "..OBBBBBBBBO..",
      "..OOOOOOOOOO..",
      "...OBHABHBO...",
      "...OSBBBBSO...",
      "...OOOOOOOO...",
      LEGS_A,
    ],
    alt: { 0: "......OO......", 13: LEGS_B, 10: "...OBHBAHBO..." },
  },
  {
    id: "ghost",
    name: "Ghost",
    move: "float",
    palette: {
      O: "#4b3a8c",
      B: "#f1ecff",
      H: "#ffffff",
      S: "#c9bdf5",
      K: "#2a1e5c",
      C: "#ff8ad8",
    },
    rows: [
      "..............",
      "..............",
      "....OOOOOO....",
      "...OHHBBBBO...",
      "..OHBBBBBBBO..",
      ".OHBBBBBBBBBO.",
      ".OBBBKBBBKBBO.",
      ".OBBBKBBBKBBO.",
      ".OBBCBBKBBCBO.",
      ".OBBBBBBBBBBO.",
      ".OBBBBBBBBBBO.",
      ".OSBBSBBSBBSO.",
      ".OSOSSOSSOSSO.",
      "..O..O..O..O..",
    ],
    alt: { 12: ".OSSOSSOSSOSO.", 13: "...O..O..O..O." },
  },
  {
    id: "shroom",
    name: "Shroom",
    move: "walk",
    palette: {
      O: "#5c0020",
      B: "#ff2e63",
      H: "#ff7a9e",
      S: "#c40f45",
      W: "#ffffff",
      F: "#ffe9c7",
      K: "#2a0d14",
      C: "#ff9ab0",
    },
    rows: [
      "..............",
      "....OOOOOO....",
      "..OOBBWWBBOO..",
      ".OHBBBWWBBBBO.",
      "OHWWBBBBBWWBBO",
      "OBWWBBBBBWWBSO",
      "OOOOOOOOOOOOOO",
      "..OFFFFFFFFO..",
      "..OFWKFFWKFO..",
      "..OFKKFFKKFO..",
      "..OCFFFFFFCO..",
      "..OFFFFFFFFO..",
      "...OOOOOOOO...",
      LEGS_A,
    ],
    alt: { 13: LEGS_B },
  },
  {
    id: "wizard",
    name: "Wizard",
    move: "walk",
    palette: {
      O: "#330866",
      B: "#b44dff",
      H: "#d99bff",
      S: "#8420e0",
      A: "#ff3fa4",
      R: "#ff8fcf",
      Y: "#ffe14d",
      K: "#170a2e",
    },
    rows: [
      "........OO....",
      ".......OAO....",
      "......OARAO...",
      ".....OAAYAAO..",
      "..OOOOOOOOOOO.",
      "..OKKKKKKKKO..",
      "..OKKYKKKYKO..",
      "..OKKKKKKKKO..",
      "..OHBBYBBBBO..",
      ".OHBBBYBBBBBO.",
      ".OBBBBYBBBBBO.",
      ".OSSSSSSSSSSO.",
      "..OOOOOOOOOO..",
      LEGS_A,
    ],
    alt: { 13: LEGS_B, 6: "..OKKKKKKKKO..", 7: "..OKKYKKKYKO.." },
  },
  {
    id: "knight",
    name: "Knight",
    move: "walk",
    palette: {
      O: "#2b3550",
      B: "#c9d3e6",
      H: "#ffffff",
      S: "#8e9ab3",
      A: "#2de2e6",
      Y: "#2de2e6",
      K: "#0b1020",
      G: "#ffc93c",
    },
    rows: [
      "....AAA.......",
      ".....AAA......",
      "......OO......",
      "...OOOOOOOO...",
      "..OHHBBBBBBO..",
      "..OHBBBBBBBO..",
      "..OKKYKKKYKO..",
      "..OBBBBBBBBO..",
      "..OBSBSBSBSO..",
      "...OOOOOOOO...",
      "..OBBGGBBBOAAO",
      "..OSBBGBBSOAAO",
      "...OOOOOOO.OO.",
      LEGS_A,
    ],
    alt: { 13: LEGS_B, 0: ".....AAA......", 1: "....AAA......." },
  },
  {
    id: "builder",
    name: "Builder",
    move: "walk",
    palette: {
      O: "#14286b",
      B: "#2f6bff",
      H: "#7ea4ff",
      S: "#1d4ad1",
      A: "#ffb020",
      Y: "#ffe08a",
      F: "#ffd3a8",
      W: "#ffffff",
      K: "#1b1530",
      C: "#ff8a7a",
    },
    rows: [
      "..............",
      "....OOOOOO....",
      "...OAYAAAAO...",
      ".OOAAAAAAAAOO.",
      "..OOOOOOOOOO..",
      "..OFFFFFFFFO..",
      "..OFWKFFWKFO..",
      "..OFKKFFKKFO..",
      "..OCFFFFFFCO..",
      "..OOBBOOBBOO..",
      ".OHBBYBBYBBBO.",
      ".OBBBBBBBBBBO.",
      "..OSSSSSSSSO..",
      LEGS_A,
    ],
    alt: { 13: LEGS_B },
  },
  {
    id: "crab",
    name: "Crab",
    move: "scuttle",
    palette: {
      O: "#5c0a0a",
      B: "#ff4040",
      H: "#ff9a8a",
      S: "#d01c1c",
      W: "#ffffff",
      K: "#1b0a0a",
      C: "#ffb3a6",
    },
    rows: [
      "..............",
      "..............",
      "OO..WK..WK..OO",
      "OBO.OO..OO.OBO",
      "OOBO.O..O.OBOO",
      ".OBO......OBO.",
      "..OOOOOOOOOO..",
      ".OHBBBBBBBBBO.",
      "OHBBBBBBBBBBBO",
      "OBBCBBKKBBCBBO",
      "OSBBBBBBBBBBSO",
      ".OSSSSSSSSSSO.",
      "..OOOOOOOOOO..",
      ".O.O.O..O.O.O.",
    ],
    alt: {
      2: ".OO.WK..WK.OO.",
      3: "OBBO.O..O.OBBO",
      13: "O.O.O....O.O.O",
    },
  },
  {
    id: "axolotl",
    name: "Axolotl",
    move: "walk",
    palette: {
      O: "#6b1050",
      B: "#ff8ad0",
      H: "#ffc6ea",
      S: "#e35aaa",
      W: "#ffffff",
      K: "#2a0a20",
      A: "#ff2fa0",
      C: "#ff4fb0",
    },
    ...chibi(
      ["..............", "..............", "..............", ".............."],
      [
        "A..OOOOOOOO..A",
        "AAOHBBBBBBBOAA",
        "AOHBBBBBBBBBOA",
        "AOBBWKBBBWKBOA",
        ".OBBKKBBBKKBO.",
        ".OCBBBBBBBBCO.",
        ".OBBBKKKKBBBO.",
        "..OSSSSSSSSOAA",
        "...OOOOOOOOOA.",
      ],
    ),
  },
  {
    id: "dino",
    name: "Dino",
    move: "walk",
    palette: {
      O: "#004c5c",
      B: "#00e0ff",
      H: "#9ff4ff",
      S: "#00a8d6",
      W: "#ffffff",
      K: "#06161c",
      A: "#ff9a2e",
      C: "#ff7ab6",
    },
    ...chibi(
      ["..............", "..............", ".....A..A..A..", "....AA.AA.AA.."],
      [
        "...OOOOOOOO...",
        "..OHBBBBBBBO..",
        ".OHBBBBBBBBBO.",
        ".OBBWKBBBWKBO.",
        ".OBBKKBBBKKBO.",
        "OOCBBBBBBBBCO.",
        "BOBBBBBBBKKBO.",
        "OBOSSSSSSSSO..",
        ".OOOOOOOOOO...",
      ],
    ),
  },
  {
    id: "slime",
    name: "Slime",
    move: "squish",
    palette: {
      O: "#2b5c00",
      B: "#b6ff3a",
      H: "#eaffb0",
      S: "#7fd400",
      W: "#ffffff",
      K: "#122000",
      C: "#ff7ab6",
    },
    rows: [
      "..............",
      "..............",
      "..............",
      "..............",
      "..............",
      ".....OOOO.....",
      "...OOHHBBOO...",
      "..OHHBBBBBBO..",
      ".OHBBWKBBWKBO.",
      ".OBBBKKBBKKBO.",
      "OBBCBBBBBBCBBO",
      "OBBBBBBBBBBBBO",
      "OSSSSSSSSSSSSO",
      ".OOOOOOOOOOOO.",
    ],
    alt: {},
  },
];

/** Frame rows: the base grid with the second walk frame's changed rows swapped in. */
function frameRows(critter: CritterDef, frame: 0 | 1): readonly string[] {
  if (frame === 0) return critter.rows;
  return critter.rows.map((row, i) => critter.alt[i] ?? row);
}

/**
 * One frame of a critter as an SVG data URL, one unit per cell (scaled up with
 * `image-rendering: pixelated`). Horizontal runs of one colour merge into a
 * single rect so a sprite stays a few hundred bytes. Pass `fill` to paint every
 * opaque cell one colour: the white silhouette used by the summon glow.
 * SVG rather than canvas so it is pure, deterministic and testable.
 */
export function renderCritterFrame(critter: CritterDef, frame: 0 | 1, fill?: string): string {
  const rects: string[] = [];
  frameRows(critter, frame).forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      let end = x + 1;
      while (end < row.length && row[end] === ch) end++;
      const color = ch === undefined || ch === "." ? undefined : (fill ?? critter.palette[ch]);
      if (color) {
        rects.push(`<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${color}"/>`);
      }
      x = end;
    }
  });
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CRITTER_CELLS} ${CRITTER_CELLS}" ` +
    `shape-rendering="crispEdges">${rects.join("")}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * Named agents that have a critter of their own. Anything else (unnamed
 * `default` agents, custom names) gets one picked from its id.
 */
const CRITTER_FOR_AGENT: Readonly<Record<string, string>> = {
  bee: "bee",
  owl: "owl",
  worker: "builder",
  researcher: "wizard",
  auditor: "knight",
  skeptic: "cat",
  "control-verifier": "robot",
};

/**
 * Small stable string hash (FNV-1a): an agent keeps the same critter, and a
 * chat line keeps the same wording, across renders and reloads.
 */
export function hashKey(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Choose the critter for an agent. A named agent gets its own critter when
 * that one is free; otherwise the id picks a starting point and the first
 * critter not already on the floor wins, so a crowd stays varied. Once all 15
 * are out, repeats are allowed.
 */
export function pickCritter(
  agentName: string | undefined,
  key: string,
  taken: ReadonlySet<string>,
): CritterDef {
  const preferredId = agentName ? CRITTER_FOR_AGENT[agentName] : undefined;
  const preferred = CRITTERS.find((critter) => critter.id === preferredId);
  if (preferred && !taken.has(preferred.id)) return preferred;
  const start = hashKey(key) % CRITTERS.length;
  for (let step = 0; step < CRITTERS.length; step++) {
    const candidate = CRITTERS[(start + step) % CRITTERS.length];
    if (candidate && !taken.has(candidate.id)) return candidate;
  }
  const fallback = preferred ?? CRITTERS[start];
  if (!fallback) throw new Error("critter roster is empty");
  return fallback;
}
