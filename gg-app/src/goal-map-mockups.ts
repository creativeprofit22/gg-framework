// Five candidate layouts for the top-down Goal world, as still scenes with
// GG Goals and its critters at their stations. These are design mockups for
// choosing a direction; the chosen layout becomes the live map. Each map is
// 40×25 tiles (640×400 px), shown at 2× or 3×.

import { GridBuilder, TILE } from "./goal-map-ground";
import { WARM_GROUND, buildFarm } from "./goal-farm-map";
import { E } from "./goal-map-pixels";
import {
  bambooFence,
  bambooSpout,
  bench,
  bucket,
  camelliaTree,
  cozyCampfire,
  cropBed,
  hut,
  koiPond,
  minka,
  niwakiTree,
  roundShrub,
  sakuraTree,
  scarecrow,
  shrine,
  sleepingCat,
  steppingStone,
  stoneLantern,
  teahouse,
  torii,
  washingLine,
  woodpile,
  yuzuTree,
} from "./goal-map-cozy";
import type { MapScene, PlacedCritter, PlacedProp } from "./goal-map-compose";
import {
  ICONS,
  anvil,
  autumnTree,
  barrel,
  bookshelf,
  boat,
  bush,
  campfire,
  coffeeBar,
  computer,
  crate,
  crops,
  desk,
  fence,
  forge,
  fountain,
  gate,
  hayBale,
  house,
  lampPost,
  lighthouse,
  lilyPad,
  logSeat,
  mailbox,
  mapTable,
  noticeBoard,
  oakTree,
  observatory,
  palmTree,
  pineTree,
  plantPot,
  pumpkin,
  reeds,
  rock,
  rug,
  serverRack,
  shed,
  signpost,
  sofa,
  stump,
  telescope,
  whiteboard,
  workbench,
  type Sprite,
} from "./goal-map-props";

export const MAP_COLS = 40;
export const MAP_ROWS = 25;

/** Tile centre, in pixels. */
const tx = (c: number): number => c * TILE + TILE / 2;
/** Bottom of a tile row (where things in that row stand), in pixels. */
const ty = (r: number): number => r * TILE + TILE - 2;

const put = (
  sprite: Sprite,
  c: number,
  r: number,
  extra: Partial<PlacedProp> = {},
): PlacedProp => ({
  sprite,
  x: tx(c),
  y: ty(r),
  ...extra,
});

const at = (
  id: string,
  c: number,
  r: number,
  extra: Partial<PlacedCritter> = {},
): PlacedCritter => ({ id, x: tx(c), y: ty(r), ...extra });

/** A ring of trees around the edge, with gaps where paths leave the map. */
function treeBorder(
  props: PlacedProp[],
  seed: number,
  gaps: ReadonlyArray<readonly [number, number]>,
  kinds: ReadonlyArray<(s: number) => Sprite> = [(s) => oakTree(s), (s) => pineTree(s)],
): void {
  const open = (c: number, r: number): boolean =>
    gaps.some(([gc, gr]) => Math.abs(gc - c) <= 1 && Math.abs(gr - r) <= 1);
  const pick = (c: number, r: number): Sprite => {
    const kind = kinds[(c * 7 + r * 3 + seed) % kinds.length] ?? kinds[0];
    if (!kind) throw new Error("no tree kinds");
    return kind(seed + c * 31 + r * 17);
  };
  for (let c = 1; c < MAP_COLS; c += 3) {
    if (!open(c, 0)) props.push(put(pick(c, 0), c, 0, { y: ty(0) + 14 }));
    if (!open(c, MAP_ROWS - 1)) props.push(put(pick(c, 99), c, MAP_ROWS - 1));
  }
  for (let r = 3; r < MAP_ROWS - 2; r += 3) {
    if (!open(0, r)) props.push(put(pick(0, r), 0, r));
    if (!open(MAP_COLS - 1, r)) props.push(put(pick(99, r), MAP_COLS - 1, r));
  }
}

// ── 1. Homestead ──────────────────────────────────────────────

function homestead(): MapScene {
  const g = new GridBuilder(MAP_COLS, MAP_ROWS);
  // Paths: gate (left) → yard → cabin, branching to the workshop and the pond.
  g.path(
    [
      [0, 13],
      [9, 13],
      [9, 9],
      [20, 9],
    ],
    "d",
    2,
  );
  g.path(
    [
      [9, 13],
      [24, 13],
      [24, 18],
    ],
    "d",
    2,
  );
  g.path(
    [
      [24, 13],
      [33, 13],
      [33, 8],
    ],
    "d",
    2,
  );
  g.rect(17, 9, 7, 3, "d"); // yard in front of the cabin
  g.rect(2, 3, 6, 4, "t"); // tilled patch (the map table's "field notes")
  // The pond, with a boardwalk across.
  g.ellipse(13, 19.5, 6.5, 3.6, "w");
  g.ellipse(13.5, 19.5, 3.4, 1.8, "W");
  g.rect(8, 19, 11, 1, "=");
  // Campfire clearing.
  g.ellipse(31, 19, 4, 2.6, "d");
  const props: PlacedProp[] = [];
  treeBorder(props, 3, [
    [0, 13],
    [0, 14],
  ]);
  // The cabin: library inside, sign over the door.
  props.push(
    put(
      house({
        width: 72,
        wall: "logs",
        roof: "shingle",
        door: 36,
        windows: [14, 58],
        chimney: true,
        sign: ICONS.book,
        seed: 3,
      }),
      20,
      8,
    ),
  );
  props.push(put(bookshelf(5), 15, 8), put(bookshelf(6), 25, 8));
  // Workshop yard: bench and forge under the trees.
  props.push(
    put(shed(64, "shingle"), 33, 6),
    put(workbench(), 31, 8),
    put(forge(), 35, 8),
    put(anvil(), 37, 9),
  );
  // Map table by the field, telescope on the knoll.
  props.push(put(mapTable(), 5, 9), put(telescope(), 8, 6));
  for (let c = 2; c < 8; c += 2)
    props.push(put(crops("cabbage", c), c, 4), put(crops("carrot", c + 9), c + 1, 6));
  props.push(put(fence(6), 5, 7, { y: ty(7) + 8 }));
  // Computer kiosk under a lamp, notice board by the path, mailbox at the gate.
  props.push(put(computer(), 24, 15), put(lampPost(), 26, 15));
  props.push(put(noticeBoard(4), 13, 12), put(mailbox(), 3, 12), put(gate(), 1, 13));
  props.push(put(signpost(), 7, 14));
  // Campfire and log seats.
  props.push(
    put(campfire(), 31, 19),
    put(logSeat(), 28, 19),
    put(logSeat(), 34, 19),
    put(stump(), 31, 21),
  );
  // Pond life.
  props.push(
    put(reeds(1), 7, 18),
    put(reeds(2), 18, 21),
    put(lilyPad(true), 11, 21, { flat: true }),
    put(lilyPad(false), 16, 18, { flat: true }),
    put(rock(2, 2, true), 19, 18),
  );
  // Odds and ends.
  props.push(
    put(hayBale(), 28, 10),
    put(barrel(), 27, 11),
    put(crate(), 38, 11),
    put(bush(9, E.red), 21, 15),
    put(bush(10, null), 6, 16),
    put(rock(11, 1), 36, 15),
    put(pumpkin(), 4, 7),
    put(oakTree(12), 37, 17),
    put(pineTree(13), 22, 22),
    put(autumnTree(14), 4, 21),
  );
  return {
    grid: g.build(),
    seed: 3,
    props,
    critters: [
      at("fox", 20, 11, { crown: true, say: "PLAN!" }),
      at("owl", 15, 9, { holding: undefined, say: "READING" }),
      at("builder", 31, 9, { flip: true }),
      at("robot", 35, 9),
      at("cat", 5, 10, { flip: true }),
      at("ghost", 24, 16),
      at("frog", 28, 20),
      at("crab", 34, 20, { flip: true }),
    ],
    labels: [
      { text: "LIBRARY", x: tx(20), y: ty(2) - 4 },
      { text: "WORKSHOP", x: tx(33), y: ty(1) },
      { text: "MAP TABLE", x: tx(5), y: ty(10) + 4 },
      { text: "WEB", x: tx(24), y: ty(16) + 4 },
      { text: "LOUNGE", x: tx(31), y: ty(21) + 4 },
    ],
  };
}

// ── 2. Village square ─────────────────────────────────────────

function village(): MapScene {
  const g = new GridBuilder(MAP_COLS, MAP_ROWS);
  // A cobbled square in the middle, streets out to each hut.
  g.rect(14, 9, 13, 8, "c");
  g.path(
    [
      [0, 12],
      [14, 12],
    ],
    "c",
    2,
  );
  g.path(
    [
      [20, 9],
      [20, 5],
    ],
    "c",
    2,
  );
  g.path(
    [
      [26, 12],
      [33, 12],
      [33, 7],
    ],
    "c",
    2,
  );
  g.path(
    [
      [26, 15],
      [33, 15],
      [33, 19],
    ],
    "d",
    2,
  );
  g.path(
    [
      [14, 15],
      [7, 15],
      [7, 19],
    ],
    "d",
    2,
  );
  // A stream along the bottom with a little bridge.
  g.rect(0, 22, MAP_COLS, 2, "w");
  g.rect(19, 22, 2, 2, "|");
  g.path(
    [
      [20, 17],
      [20, 21],
    ],
    "d",
    2,
  );
  const props: PlacedProp[] = [];
  treeBorder(props, 5, [
    [0, 12],
    [0, 13],
    [19, 24],
    [20, 24],
  ]);
  props.push(put(fountain(), 20, 13));
  // Library (big house, north), workshop (east), post office (west), observatory.
  props.push(
    put(
      house({
        width: 80,
        wall: "stone",
        roof: "slate",
        door: 40,
        windows: [16, 64],
        chimney: true,
        sign: ICONS.book,
        seed: 21,
      }),
      20,
      4,
    ),
  );
  props.push(
    put(
      house({
        width: 56,
        wall: "plaster",
        roof: "tile",
        door: 28,
        windows: [12, 44],
        sign: ICONS.hammer,
        seed: 22,
      }),
      33,
      6,
    ),
  );
  props.push(put(workbench(), 30, 9), put(forge(), 36, 9), put(anvil(), 37, 10));
  props.push(
    put(
      house({
        width: 52,
        wall: "boards",
        roof: "thatch",
        door: 26,
        windows: [11],
        sign: ICONS.letter,
        seed: 23,
      }),
      6,
      9,
    ),
  );
  props.push(put(mailbox(), 9, 11), put(noticeBoard(6), 4, 11));
  props.push(put(observatory(), 33, 19), put(telescope(), 30, 19));
  props.push(put(mapTable(), 8, 19), put(computer(), 11, 19));
  // Square furniture.
  props.push(
    put(lampPost(), 15, 10),
    put(lampPost(), 25, 10),
    put(lampPost(), 15, 16),
    put(lampPost(), 25, 16),
    put(barrel(), 27, 11),
    put(crate(), 28, 11),
    put(bush(31, E.coral), 13, 8),
    put(bush(32, E.yellow), 27, 8),
    put(signpost(), 2, 14),
    put(autumnTree(33), 24, 20),
    put(oakTree(34), 16, 20),
    put(rock(35, 1), 4, 20),
    put(reeds(36), 12, 22),
    put(reeds(37), 27, 22),
  );
  return {
    grid: g.build(),
    seed: 5,
    props,
    critters: [
      at("fox", 20, 15, { crown: true, say: "WELCOME!" }),
      at("owl", 18, 5, { flip: true }),
      at("builder", 30, 10),
      at("robot", 36, 10, { flip: true }),
      at("bee", 9, 12, { say: "MAIL!" }),
      at("wizard", 30, 20, { say: "LOOK!" }),
      at("cat", 8, 20),
      at("slime", 23, 14, { flip: true }),
    ],
    labels: [
      { text: "LIBRARY", x: tx(20), y: ty(0) - 8 },
      { text: "WORKSHOP", x: tx(33), y: ty(1) - 6 },
      { text: "POST", x: tx(6), y: ty(4) - 8 },
      { text: "OBSERVATORY", x: tx(33), y: ty(15) - 6 },
    ],
  };
}

// ── 3. Terraced hillside ─────────────────────────────────────

function hillside(): MapScene {
  const g = new GridBuilder(MAP_COLS, MAP_ROWS);
  // Three levels. A terrace's bottom row of tiles is its cliff face; the
  // stairs are cut into that row, and paths run up to them from both sides.
  g.raise(0, 0, MAP_COLS, 9, 2); // top terrace: rows 0-8, face on row 8
  g.raise(0, 9, MAP_COLS, 7, 1); // middle terrace: rows 9-15, face on row 15
  g.set(9, 8, "S").set(10, 8, "S");
  g.set(29, 15, "S").set(30, 15, "S");
  // Top terrace path, then down the stairs to the middle terrace.
  g.path(
    [
      [4, 5],
      [36, 5],
    ],
    "d",
    1,
  );
  g.rect(9, 6, 2, 2, "d");
  // Middle terrace path, then down to the bottom.
  g.rect(9, 9, 2, 3, "d");
  g.path(
    [
      [3, 12],
      [36, 12],
    ],
    "d",
    1,
  );
  g.rect(29, 13, 2, 2, "d");
  // Bottom: from the stairs to the gate path.
  g.rect(29, 16, 2, 4, "d");
  g.path(
    [
      [0, 20],
      [36, 20],
    ],
    "d",
    2,
  );
  // A stream running down the hill on the left, into a pool.
  g.rect(2, 0, 2, 22, "w");
  g.ellipse(4.5, 22.5, 4, 2.2, "w");
  g.rect(2, 12, 2, 1, "=");
  g.rect(2, 20, 2, 2, "=");
  const props: PlacedProp[] = [];
  treeBorder(props, 7, [
    [0, 20],
    [0, 21],
  ]);
  // Top terrace: planning, the GG Goals tent.
  props.push(
    put(noticeBoard(7), 14, 4),
    put(whiteboard(), 19, 4),
    put(telescope(), 24, 4),
    put(mapTable(), 31, 4),
  );
  props.push(
    put(
      house({ width: 48, wall: "plaster", roof: "thatch", door: 24, windows: [10], seed: 41 }),
      35,
      2,
    ),
  );
  // Middle terrace: library and workshop.
  props.push(
    put(
      house({
        width: 64,
        wall: "logs",
        roof: "shingle",
        door: 32,
        windows: [12, 52],
        chimney: true,
        sign: ICONS.book,
        seed: 42,
      }),
      13,
      10,
    ),
  );
  props.push(
    put(bookshelf(8, true), 19, 10),
    put(shed(56, "shingle"), 25, 10),
    put(workbench(), 24, 12),
    put(forge(), 28, 12),
  );
  props.push(put(computer(), 34, 12), put(lampPost(), 36, 12));
  // Bottom: arrivals gate, mailbox, campfire lounge.
  props.push(
    put(gate(), 6, 20),
    put(mailbox(), 9, 19),
    put(campfire(), 18, 21),
    put(logSeat(), 15, 21),
    put(logSeat(), 21, 21),
  );
  props.push(
    put(hayBale(), 25, 19),
    put(crops("wheat", 1), 33, 18),
    put(crops("wheat", 2), 35, 18),
    put(crops("wheat", 3), 37, 18),
  );
  props.push(
    put(rock(44, 2, true), 6, 4),
    put(bush(45, null), 26, 6),
    put(pineTree(46), 37, 7),
    put(oakTree(47), 7, 13),
    put(autumnTree(48), 12, 17),
    put(rock(49, 1), 22, 17),
  );
  return {
    grid: g.build(),
    seed: 7,
    props,
    critters: [
      at("fox", 19, 5, { crown: true, say: "PLANNING" }),
      at("wizard", 24, 5, { flip: true }),
      at("owl", 18, 11),
      at("builder", 24, 13),
      at("robot", 28, 13, { flip: true }),
      at("ghost", 34, 13),
      at("frog", 15, 22),
      at("dino", 21, 22, { flip: true, say: "BREAK!" }),
    ],
    labels: [
      { text: "PLAN", x: tx(19), y: ty(6) + 2 },
      { text: "WORK", x: tx(25), y: ty(13) + 6 },
      { text: "REST", x: tx(18), y: ty(22) + 6 },
    ],
  };
}

// ── 3b. Cosy hillside (warm, rural-Japan farm) ──────────────

function cozyHillside(): MapScene {
  const g = new GridBuilder(MAP_COLS, MAP_ROWS);
  // Three levels, as in the plain hillside; the faces sit on rows 8 and 15.
  g.raise(0, 0, MAP_COLS, 9, 2);
  g.raise(0, 9, MAP_COLS, 7, 1);
  g.set(19, 8, "S").set(20, 8, "S");
  g.set(30, 15, "S").set(31, 15, "S");
  // Earth yards in front of each house, joined by paths to the stairs.
  g.ellipse(15, 5.6, 7, 2.2, "d");
  g.rect(19, 6, 2, 2, "d");
  g.rect(19, 9, 2, 2, "d");
  g.path(
    [
      [6, 11],
      [36, 11],
    ],
    "d",
    2,
  );
  g.rect(30, 13, 2, 2, "d");
  g.rect(30, 16, 2, 3, "d");
  g.path(
    [
      [0, 19],
      [37, 19],
    ],
    "d",
    2,
  );
  // A stream down the left of the hill, under two little bridges.
  g.rect(2, 0, 2, 22, "w");
  g.ellipse(4.5, 22.6, 4.2, 2.2, "w");
  g.rect(2, 11, 2, 2, "=");
  g.rect(2, 19, 2, 2, "=");
  const props: PlacedProp[] = [];
  const flat = (sprite: Sprite, c: number, r: number, dx = 0, dy = 0): PlacedProp => ({
    sprite,
    x: tx(c) + dx,
    y: ty(r) + dy,
    flat: true,
  });
  // A border of shade trees and blossom, not a wall of identical oaks.
  const border: ReadonlyArray<(s: number) => Sprite> = [
    (s) => niwakiTree(s),
    (s) => roundShrub(s, "olive", true),
    (s) => sakuraTree(s, false),
    (s) => roundShrub(s, "green", true),
    (s) => roundShrub(s, "amber", true),
  ];
  treeBorder(
    props,
    11,
    [
      [0, 19],
      [0, 20],
      // Keep the bottom edge open around the pond and the fire.
      [10, 24],
      [13, 24],
      [16, 24],
      [22, 24],
      [25, 24],
      [28, 24],
    ],
    border,
  );

  // ── Top terrace: GG Goals' house, planning, the view from the hill ──
  props.push(put(minka(116, 71, { sign: 0x3a5a9a }), 11, 5));
  props.push(put(sakuraTree(72), 24, 5), put(sakuraTree(73, false), 27, 4));
  props.push(put(stoneLantern(), 4, 7), put(stoneLantern(), 18, 7));
  props.push(put(teahouse(74), 34, 4), put(whiteboard(), 30, 6), put(telescope(), 37, 6));
  props.push(put(woodpile(), 22, 7), put(roundShrub(75, "green"), 37, 2));
  for (let i = 0; i < 3; i++)
    props.push(flat(steppingStone(80 + i), 19, 6, (i % 2) * 6 - 2, i * 6 - 4));

  // ── Middle terrace: the workshop yard ──
  props.push(put(minka(84, 76, { sign: 0x8a2a2a }), 12, 12));
  props.push(
    put(bookshelf(9, true), 6, 12),
    put(bookshelf(10), 18, 12),
    put(shed(56, "shingle"), 27, 10),
  );
  props.push(put(workbench(), 25, 12), put(forge(), 29, 12), put(anvil(), 31, 13));
  props.push(put(computer(), 35, 12), put(stoneLantern(), 37, 12));
  props.push(
    put(bambooFence(6), 22, 9, { y: ty(9) + 2 }),
    put(bucket(), 23, 13),
    put(hayBale(), 33, 13),
  );
  props.push(
    put(camelliaTree(77), 20, 13),
    put(yuzuTree(78), 8, 14),
    put(roundShrub(79, "olive"), 37, 14),
  );

  // ── Bottom: arrivals, the garden, the evening fire ──
  props.push(put(torii(), 1, 19, { x: tx(1) + 10 }));
  props.push(put(mailbox(), 6, 18), put(shrine(), 9, 18));
  props.push(put(koiPond(70, 40, 81), 13, 23));
  props.push(put(bambooSpout(), 9, 22));
  props.push(
    put(cozyCampfire(), 25, 22),
    put(bench(), 21, 22),
    put(bench(), 29, 22),
    put(sleepingCat(), 27, 23),
  );
  // Lanterns strung around the fire for the evening.
  props.push(
    put(stoneLantern(), 22, 24, { y: ty(23) + 10 }),
    put(stoneLantern(), 28, 24, { y: ty(23) + 10 }),
  );
  props.push(
    put(cropBed(5, 2, "daikon", 82), 22, 18, { y: ty(17) + 4 }),
    put(cropBed(5, 2, "carrot", 83), 26, 18, { y: ty(17) + 4 }),
  );
  props.push(put(cropBed(4, 2, "rice", 84), 35, 22), put(scarecrow(), 38, 21));
  props.push(put(washingLine(), 16, 17, { y: ty(17) + 2 }), put(hut(), 33, 17));
  props.push(put(roundShrub(85, "amber"), 26, 15), put(roundShrub(86, "olive"), 36, 15));
  // A little orchard and garden around the pond.
  props.push(
    put(yuzuTree(88), 7, 23),
    put(camelliaTree(89), 19, 23),
    put(roundShrub(91, "green"), 11, 21),
    put(roundShrub(92, "amber"), 4, 21),
    put(stoneLantern(), 18, 21),
    put(bucket(), 24, 22),
    put(woodpile(), 31, 23),
  );
  for (let i = 0; i < 5; i++)
    props.push(flat(steppingStone(90 + i), 30, 16, 6 - (i % 2) * 8, i * 6 - 2));

  return {
    grid: g.build(),
    seed: 11,
    groundColors: WARM_GROUND,
    props,
    critters: [
      at("fox", 13, 7, { crown: true, say: "LET'S PLAN" }),
      at("wizard", 30, 7, { flip: true, say: "IDEA!" }),
      at("owl", 7, 13, { say: "READING" }),
      at("builder", 25, 13),
      at("robot", 29, 13, { flip: true }),
      at("ghost", 35, 13),
      at("frog", 21, 23),
      at("dino", 29, 23, { flip: true, say: "COCOA?" }),
    ],
    labels: [
      { text: "PLAN", x: tx(13), y: ty(7) + 6 },
      { text: "WORK", x: tx(25), y: ty(14) + 4 },
      { text: "REST", x: tx(25), y: ty(23) + 8 },
    ],
  };
}

// ── 6. Farmstead (cosy, rural Japan: the look of the references) ──

function farmstead(): MapScene {
  // The live farm's own layout (goal-farm-map), as a still picture with the
  // team placed at their stations.
  const farm = buildFarm({ still: true });
  return {
    ...farm.scene,
    critters: [
      at("fox", 0, 0, { x: 222, y: 160, crown: true, say: "LET'S PLAN" }),
      at("owl", 0, 0, { x: 126, y: 124, say: "READING" }),
      at("ghost", 0, 0, { x: 162, y: 126 }),
      at("wizard", 0, 0, { x: 374, y: 114, flip: true, say: "IDEA!" }),
      at("builder", 0, 0, { x: 418, y: 160 }),
      at("robot", 0, 0, { x: 456, y: 160, flip: true }),
      at("cat", 0, 0, { x: 146, y: 188, flip: true }),
      at("frog", 0, 0, { x: 330, y: 206 }),
      at("dino", 0, 0, { x: 382, y: 212, say: "TEA?" }),
    ],
  };
}

// ── 4. Island harbour ────────────────────────────────────────

function harbour(): MapScene {
  const g = new GridBuilder(MAP_COLS, MAP_ROWS, "W");
  // Shallows around each island, sand, then grass.
  const island = (cx: number, cy: number, rx: number, ry: number): void => {
    g.ellipse(cx, cy, rx + 1.6, ry + 1.4, "w");
    g.ellipse(cx, cy, rx + 0.6, ry + 0.5, "s");
    g.ellipse(cx, cy, rx - 0.6, ry - 0.6, ".");
  };
  island(9, 7, 7, 5); // library island
  island(30, 6, 7, 4.5); // lighthouse + workshop
  island(20, 17, 9, 5.5); // main island: lounge, arrivals
  island(5, 20, 3.5, 3); // a little rock
  // Bridges and docks.
  g.rect(15, 7, 9, 2, "=");
  g.rect(13, 11, 2, 3, "|");
  g.rect(26, 10, 2, 3, "|");
  g.rect(28, 20, 7, 2, "=");
  g.path(
    [
      [9, 8],
      [14, 8],
    ],
    "d",
    1,
  );
  const props: PlacedProp[] = [];
  props.push(put(lighthouse(), 35, 5));
  props.push(
    put(
      house({
        width: 60,
        wall: "boards",
        roof: "shingle",
        door: 30,
        windows: [12, 48],
        chimney: true,
        sign: ICONS.book,
        seed: 61,
      }),
      8,
      6,
    ),
  );
  props.push(
    put(bookshelf(9), 13, 7),
    put(shed(52, "tile"), 28, 5),
    put(workbench(), 27, 7),
    put(anvil(), 31, 8),
  );
  props.push(put(campfire(), 20, 17), put(logSeat(), 17, 17), put(logSeat(), 23, 17));
  props.push(
    put(mailbox(), 15, 19),
    put(computer(), 25, 15),
    put(mapTable(), 14, 15),
    put(noticeBoard(8), 19, 13),
  );
  props.push(put(boat(), 33, 22), put(boat(), 37, 15, { flip: true }));
  props.push(
    put(palmTree(1), 12, 17),
    put(palmTree(-1), 27, 18),
    put(palmTree(1), 4, 5),
    put(palmTree(-1), 24, 4),
    put(palmTree(1), 6, 20),
    put(rock(67, 2), 3, 9),
    put(rock(68, 1), 21, 20),
    put(barrel(), 30, 20),
    put(crate(), 31, 20),
    put(bush(69, E.coral), 10, 11),
    put(lilyPad(true), 18, 23, { flat: true }),
  );
  return {
    grid: g.build(),
    seed: 9,
    props,
    critters: [
      at("fox", 20, 18, { crown: true, say: "AHOY!" }),
      at("owl", 13, 8, { flip: true }),
      at("builder", 27, 8),
      at("robot", 31, 9, { flip: true }),
      at("crab", 33, 21, { say: "INCOMING" }),
      at("axolotl", 25, 16),
      at("frog", 17, 18),
      at("cat", 14, 16),
    ],
    labels: [
      { text: "LIBRARY", x: tx(8), y: ty(1) - 4 },
      { text: "LIGHTHOUSE", x: tx(35), y: ty(0) - 6 },
      { text: "DOCK", x: tx(31), y: ty(22) + 6 },
    ],
  };
}

// ── 5. Indoor workshop (roof off) ────────────────────────────

function workshop(): MapScene {
  const g = new GridBuilder(MAP_COLS, MAP_ROWS, "f");
  // Outer walls and rooms, with doorways.
  g.rect(0, 0, MAP_COLS, 2, "#");
  g.rect(0, 0, 1, MAP_ROWS, "#");
  g.rect(MAP_COLS - 1, 0, 1, MAP_ROWS, "#");
  g.rect(0, MAP_ROWS - 1, MAP_COLS, 1, "#");
  // Interior walls: a library (top left), server room (top right), planning
  // (bottom left), lounge (bottom right), a corridor across the middle.
  g.rect(0, 11, 16, 1, "#").rect(24, 11, 16, 1, "#");
  g.rect(15, 0, 1, 11, "#").rect(24, 0, 1, 11, "#");
  g.rect(15, 14, 1, 11, "#").rect(24, 14, 1, 11, "#");
  g.rect(0, 13, 16, 1, "#").rect(24, 13, 16, 1, "#");
  // Doorways.
  g.rect(7, 11, 2, 1, "f").rect(31, 11, 2, 1, "f").rect(7, 13, 2, 1, "f").rect(31, 13, 2, 1, "f");
  g.rect(15, 5, 1, 2, "f").rect(24, 5, 1, 2, "f");
  g.rect(0, 12, 1, 1, "f"); // the front door, left
  // Stone floors in the server room and the corridor; the workshop has its own.
  g.rect(25, 2, 14, 9, "F");
  g.rect(0, 12, MAP_COLS, 1, "F");
  g.rect(16, 2, 8, 9, "F");
  const props: PlacedProp[] = [];
  // Library.
  for (let c = 2; c < 15; c += 3) props.push(put(bookshelf(70 + c, true), c, 3));
  props.push(put(rug(56, 30), 7, 8, { flat: true }), put(desk(), 6, 8), put(plantPot(71), 13, 9));
  // Workshop (middle top).
  props.push(
    put(workbench(), 18, 4),
    put(anvil(), 22, 5),
    put(forge(), 20, 9),
    put(crate(), 17, 9),
  );
  // Server room.
  for (let c = 26; c < 38; c += 3) props.push(put(serverRack(80 + c), c, 4));
  props.push(put(computer(), 28, 9), put(computer(), 33, 9));
  // Planning.
  props.push(
    put(whiteboard(), 5, 15),
    put(noticeBoard(9), 11, 15),
    put(mapTable(), 7, 20),
    put(mailbox(), 2, 22),
  );
  // Lounge.
  props.push(
    put(rug(64, 36), 32, 20, { flat: true }),
    put(sofa(), 30, 18),
    put(sofa(), 34, 18),
    put(coffeeBar(), 36, 22),
  );
  props.push(put(plantPot(72), 26, 15), put(plantPot(73), 38, 15), put(barrel(), 26, 22));
  // Corridor lamps.
  props.push(put(plantPot(74), 19, 15), put(plantPot(75), 21, 22));
  return {
    grid: g.build(),
    seed: 11,
    props,
    critters: [
      at("fox", 8, 21, { crown: true, say: "PLAN!" }),
      at("owl", 5, 4),
      at("wizard", 11, 9, { flip: true, say: "READING" }),
      at("builder", 18, 5),
      at("robot", 28, 10),
      at("ghost", 33, 10, { flip: true }),
      at("cat", 31, 19),
      at("slime", 35, 20, { flip: true }),
    ],
    labels: [
      { text: "LIBRARY", x: tx(7), y: ty(1) + 4 },
      { text: "WORKSHOP", x: tx(20), y: ty(1) + 4 },
      { text: "SERVERS", x: tx(32), y: ty(1) + 4 },
      { text: "PLANNING", x: tx(7), y: ty(23) + 2 },
      { text: "LOUNGE", x: tx(32), y: ty(23) + 2 },
    ],
  };
}

export const MOCKUPS: ReadonlyArray<{
  id: string;
  name: string;
  build: () => MapScene;
  /** Pixel scale for the mockup image (the farmstead is drawn at farm-sim size). */
  scale?: number;
}> = [
  { id: "1-homestead", name: "Homestead", build: homestead },
  { id: "2-village", name: "Village square", build: village },
  { id: "3-hillside", name: "Terraced hillside", build: hillside },
  { id: "3b-cozy-hillside", name: "Cosy hillside", build: cozyHillside },
  { id: "6-farmstead", name: "Farmstead", build: farmstead, scale: 3 },
  { id: "4-harbour", name: "Island harbour", build: harbour },
  { id: "5-workshop", name: "Indoor workshop", build: workshop },
];
