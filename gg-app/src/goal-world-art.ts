// Pixel art the Goal farm's critters wear: GG Goals' crown. Same grid
// format as critter-sprites.ts: `.` is transparent, any other character keys
// into the palette. Colours are art, not theme roles, so they stay literal.

export const ART_PALETTE: Readonly<Record<string, string>> = {
  O: "#1b1c24", // outline
  W: "#b07a4a", // wood
  w: "#7a4f2c", // wood shade
  M: "#a3acbf", // metal
  m: "#5d6578", // metal shade
  S: "#10151f", // screen off
  G: "#5ef08a", // terminal green
  C: "#8fdcff", // screen cyan
  c: "#3aa7d9",
  R: "#c0533a", // book / bike red
  B: "#3a7bd5",
  Y: "#e8c34a",
  y: "#b8912a",
  g: "#4caf6a",
  P: "#9b6bd6",
  K: "#f1efe6", // paper
  L: "#8c93ab", // ink lines
  r: "#e0574f", // red light
  o: "#ffb347", // amber light, flame
  f: "#fff3b0", // flame core
  D: "#2a2d38", // dark interior
  d: "#3c4050",
  U: "#4a6cd4", // sofa
  u: "#33489a",
};

export interface Grid {
  readonly rows: readonly string[];
}

const grid = (...rows: string[]): Grid => ({ rows });

/** GG Goals' crown. */
export const CROWN = grid("Y..Y..Y", "YY.Y.YY", "YYYYYYY", "yyyyyyy");
