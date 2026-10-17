// Ken's face: a head-only pixel portrait in the critter sprite format (see
// critter-sprites.ts). It stands in for the teal dot on Ken's chat replies and
// headlines the "Ken is on." / "Ken is off." banner. Buzzcut, light skin,
// calm narrow eyes, friendly grin. Each expression is the base grid with a few
// rows swapped, so the frames line up pixel for pixel when stacked and
// cross-faded in CSS (KenFace.tsx). Colours are art, not theme roles.

import { CRITTER_CELLS, renderPixelGrid } from "./critter-sprites";

export type KenFaceFrame = "base" | "blink" | "talk" | "happy" | "sleepy";

export const KEN_FACE_PALETTE: Readonly<Record<string, string>> = {
  O: "#1c120e", // outline
  H: "#3d302a", // buzzcut
  h: "#6e5a4d", // stubble flecks and the faded temples
  F: "#f7dcc4", // skin
  D: "#e3b796", // skin shade (nose)
  A: "#ecbf9f", // ears
  B: "#4a3830", // brows
  E: "#1d1418", // eyes
  L: "#8a5a44", // closed lids
  C: "#f4a99e", // blush
  M: "#b5554c", // smile
  K: "#4a1a1e", // open mouth
  T: "#e86a5e", // tongue
};

// Short buzzed cap (two rows plus faded temples), brows a row clear of the
// narrow eyes, ears at eye level.
const BASE: readonly string[] = [
  "..............",
  "...OOOOOOOO...",
  "..OHhHHhHHHO..",
  ".OHHHhHHHhHHO.",
  ".OhFFFFFFFFhO.",
  ".OFBBFFFFBBFO.",
  "OAFFFFFFFFFFAO",
  "OAFEEFFFFEEFAO",
  ".OCFFFDDFFFCO.",
  ".OFFMFFFFMFFO.",
  "..OFFMMMMFFO..",
  "...OFFFFFFO...",
  "....OOOOOO....",
  "..............",
];

const LIDS = "OAFLLFFFFLLFAO";
const OPEN_MOUTH = { 9: ".OFFFKKKKFFFO.", 10: "..OFFKTTKFFO.." };

/** Rows each expression swaps into the base grid. */
const CHANGES: Readonly<Record<KenFaceFrame, Readonly<Record<number, string>>>> = {
  base: {},
  blink: { 7: LIDS },
  talk: OPEN_MOUTH,
  // ^^ eyes and an open grin.
  happy: { 6: "OAFFEFFFFEFFAO", 7: "OAFEFEFFEFEFAO", ...OPEN_MOUTH },
  // Lids shut and a small, settled mouth.
  sleepy: { 7: LIDS, 9: ".OFFFFFFFFFFO.", 10: "..OFFFMMFFFO.." },
};

/** The grid for one expression. */
export function kenFaceRows(frame: KenFaceFrame): readonly string[] {
  const changes = CHANGES[frame];
  return BASE.map((row, i) => changes[i] ?? row);
}

/** One expression as an SVG data URL (one unit per cell, scale it up pixelated). */
export function renderKenFace(frame: KenFaceFrame): string {
  return renderPixelGrid(kenFaceRows(frame), KEN_FACE_PALETTE, {
    width: CRITTER_CELLS,
    height: CRITTER_CELLS,
  });
}
