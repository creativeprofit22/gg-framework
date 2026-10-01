// Tiny pixel-art props the critters hold or use while they work. Same grid
// format as critter-sprites.ts: `.` is transparent, any other character is a
// key into PROP_PALETTE. Drawn facing right; mirrored in CSS when the critter
// faces left. Colours are art, not theme roles, so they stay literal here.

const PROP_PALETTE: Readonly<Record<string, string>> = {
  O: "#1b1c24", // outline
  W: "#f1efe6", // paper
  L: "#8c93ab", // text lines
  B: "#c0533a", // book cover
  b: "#7a2f22", // cover shade
  G: "#b5bccb", // metal
  g: "#5d6578", // dark metal
  H: "#9a6434", // wood
  C: "#8fdcff", // glass
  c: "#3aa7d9", // deep glass (gem / crystal facets)
  K: "#15161c", // screen
  N: "#5ef08a", // terminal green
  Y: "#ffe14d", // bulb
  y: "#f2b53a",
  P: "#b07cff", // crystal
  p: "#7c4ddb",
  M: "#e9e4dc", // mug
  m: "#6b3f22", // coffee
  R: "#ff6b60",
  w: "#ffffff",
};

export type PropName =
  | "book"
  | "spellbook"
  | "scroll"
  | "paper"
  | "magnifier"
  | "shovel"
  | "binoculars"
  | "crystal"
  | "hammer"
  | "laptop"
  | "terminal"
  | "gear"
  | "dish"
  | "plane"
  | "letter"
  | "mug"
  | "bulb"
  | "gem"
  | "fly";

interface PropGrid {
  readonly f0: readonly string[];
  readonly f1?: readonly string[];
}

const PROP_GRIDS: Readonly<Record<PropName, PropGrid>> = {
  book: {
    f0: [".WWWOWWW.", "WLLWOWLLW", "WWWWOWWWW", "WLLWOWLLW", "BWWWOWWWB", ".BBBBBBB."],
    f1: [".WWWO.WW.", "WLLWOWWW.", "WWWWOWLLW", "WLLWOWWWW", "BWWWOWWWB", ".BBBBBBB."],
  },
  spellbook: {
    f0: [".WWWOWWW.", "WLLWOWPLW", "WWWWOWWWW", "WPLWOWLLW", "pWWWOWWWp", ".ppYpppp."],
    f1: [".WWWO.WW.", "WLLWOWWW.", "WWWWOWPLW", "WPLWOWWWW", "pWWWOWWWp", ".ppppYpp."],
  },
  scroll: {
    f0: ["HHHHHH", ".WWWW.", ".WLLW.", ".WWWW.", ".WLLW.", ".WWWW.", ".WLWW.", "HHHHHH"],
  },
  paper: {
    f0: ["WWWWWW", "WLLLLW", "WWWWWW", "WLLLWW", "WWWWWW", "WLLWWW", "WWWWWW"],
    f1: ["WWWWWW", "WLLLLW", "WWWWWW", "WLLLLW", "WWWWWW", "WLLLWW", "WWWWWW"],
  },
  magnifier: {
    f0: [".GGG...", "GCCwG..", "GCCCG..", "GCCCG..", ".GGGH..", "....HH.", ".....HH"],
  },
  shovel: {
    f0: ["..H..", "..H..", "..H..", "..H..", "..H..", ".GGG.", ".GGG.", ".GGG.", "..G.."],
  },
  // Front-on, worn over the eyes: two round lenses are what makes it read at 28px.
  binoculars: {
    f0: [".GGG...GGG.", "GOOwG.GOOwG", "GOOOGGGOOOG", "GOOOG.GOOOG", ".GGG...GGG."],
  },
  // Cyan glass on a gold stand, so it doesn't vanish into the wizard's purple.
  crystal: {
    f0: ["..CCC..", ".CwwCC.", "CCwCCCc", "CCCCCcc", ".CCCcc.", "..ccc..", ".yYYYy.", "yyyyyyy"],
    f1: ["..CCC..", ".CCCCC.", "CCCwwCc", "CCCwCcc", ".CCCcc.", "..ccc..", ".yYYYy.", "yyyyyyy"],
  },
  hammer: {
    f0: ["GGGGG", "GGGGg", "..H..", "..H..", "..H..", "..H.."],
  },
  laptop: {
    f0: [".OOOOOOO.", ".OKKKKKO.", ".OKNNNKO.", ".OKKKKKO.", "GGGGGGGGG", ".ggggggg."],
    f1: [".OOOOOOO.", ".OKNKKKO.", ".OKKKKKO.", ".OKNNKKO.", "GGGGGGGGG", ".ggggggg."],
  },
  terminal: {
    f0: ["OOOOOOOO", "OKKKKKKO", "OKNKKKKO", "OKKNKKKO", "OKNKwwKO", "OOOOOOOO"],
    f1: ["OOOOOOOO", "OKKKKKKO", "OKNKKKKO", "OKKNKKKO", "OKNKKKKO", "OOOOOOOO"],
  },
  gear: {
    f0: ["...G...", ".GGGGG.", ".GGgGG.", "GGgggGG", ".GGgGG.", ".GGGGG.", "...G..."],
    f1: [".G...G.", "..GGG..", ".GGgGG.", ".GgggG.", ".GGgGG.", "..GGG..", ".G...G."],
  },
  dish: {
    f0: ["GG.....", "GGG...w", ".GGG.w.", "..GGw..", "...GG..", "..ggg..", ".ggggg."],
  },
  plane: {
    f0: ["WW.....", ".WWWW..", "..LWWWW", ".WWW..."],
  },
  letter: {
    f0: ["WWWWWW", "WLWWLW", "WWLLWW", "WWWWWW"],
  },
  // Handle loop on the side the critter holds; coffee showing at the rim.
  mug: {
    f0: ["..MmmmM", ".MMMMMM", "M.MMMMM", "M.MMMMM", ".MMMMMM", "..MMMMM"],
  },
  bulb: {
    f0: [".YYY.", "YYwYY", "YYYYY", ".YyY.", ".GGG.", "..G.."],
  },
  gem: {
    f0: [".cCwCc.", "cCCwCCc", "ccCCCcc", ".cCCCc.", "..cCc..", "...c..."],
  },
  fly: {
    f0: ["C.C", ".O."],
    f1: [".C.", "COC"],
  },
};

/** A rendered prop: size in sprite cells and data-URL frames. */
export interface PropArt {
  readonly w: number;
  readonly h: number;
  readonly f0: string;
  readonly f1: string | null;
}

/** One grid as an SVG data URL (same approach as renderCritterFrame). */
function renderGrid(rows: readonly string[]): string {
  const w = rows[0]?.length ?? 0;
  const rects: string[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      let end = x + 1;
      while (end < row.length && row[end] === ch) end++;
      const color = ch === undefined || ch === "." ? undefined : PROP_PALETTE[ch];
      if (color) {
        rects.push(`<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${color}"/>`);
      }
      x = end;
    }
  });
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${rows.length}" ` +
    `shape-rendering="crispEdges">${rects.join("")}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Render a prop's frames. Pure; callers cache the result. */
export function renderProp(name: PropName): PropArt {
  const grid = PROP_GRIDS[name];
  return {
    w: grid.f0[0]?.length ?? 0,
    h: grid.f0.length,
    f0: renderGrid(grid.f0),
    f1: grid.f1 ? renderGrid(grid.f1) : null,
  };
}
