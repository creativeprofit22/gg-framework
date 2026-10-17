// Renders the installer art pages from the app's REAL art, so the installer
// always matches the app: the "SUPAH CODER" ASCII banner (src/AsciiLogo.tsx), the
// critter sprites (src/critter-sprites.ts), the terrains (src/critter-terrain.ts)
// and the theme's dark surface, white ink and critter pink.
//
// Run from the repo root (tsx lets this script import the app's TypeScript):
//   node_modules/.bin/tsx gg-app/installer/build-pages.mjs   → installer/*.png
//   pnpm --filter gg-app installer:art                        → out/ assets
//
// Needs Playwright's Chromium (a repo-root dev dependency). Every page is drawn
// at 2× and downscaled (NSIS) or tagged 144 DPI (DMG) by build-art.mjs.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { CRITTERS, renderCritterFrame } from "../src/critter-sprites.ts";
import {
  BIOMES,
  DECOR_COLS,
  GROUND_COLS,
  TERRAIN_FLOOR_ROW,
  TERRAIN_ROWS,
  renderTerrain,
} from "../src/critter-terrain.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** Pixel-art cells a critter sprite spans. */
const CRITTER_CELLS = 14;
/** Cells of terrain below the surface the critters stand on. */
const FLOOR_CELLS = TERRAIN_ROWS - TERRAIN_FLOOR_ROW;

/** The home-screen banner's lines, read from AsciiLogo.tsx (one source of truth). */
function bannerLines() {
  const src = readFileSync(join(here, "..", "src", "AsciiLogo.tsx"), "utf8");
  // The Local Fork keeps the raw art in RAW_LOGO_LINES (padded at runtime).
  const block = /const (?:RAW_)?LOGO_LINES = \[([\s\S]*?)\];/.exec(src)?.[1];
  if (!block) throw new Error("LOGO_LINES not found in AsciiLogo.tsx");
  return [...block.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`));
}

function find(list, id, what) {
  const item = list.find((x) => x.id === id);
  if (!item) throw new Error(`no ${what} "${id}"`);
  return item;
}

const critterUrl = (id) => renderCritterFrame(find(CRITTERS, id, "critter"), 0);
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/**
 * A strip of terrain `cols` cells wide at `px` CSS px per cell: the ground,
 * its props (sky ones only when `sky`), and critters standing at given columns.
 * `offset` slides the scenery left by that many cells.
 */
function terrainStrip(biomeId, cols, px, critters, { offset = 0, sky = true } = {}) {
  const art = renderTerrain(find(BIOMES, biomeId, "biome"));
  const height = TERRAIN_ROWS * px;
  const props = [];
  for (const p of art.props) {
    if (!sky && p.layer === "sky") continue;
    // The decor strip repeats every DECOR_COLS; draw each copy that shows.
    for (let x = p.x - offset; x < cols; x += DECOR_COLS) {
      if (x + p.width <= 0) continue;
      props.push(
        `<img src="${p.url}" style="position:absolute;left:${x * px}px;bottom:${p.bottom * px}px;` +
          `width:${p.width * px}px;height:${p.height * px}px">`,
      );
    }
  }
  const standing = critters.map(
    (c) =>
      `<img src="${critterUrl(c.id)}" style="position:absolute;left:${c.x * px}px;` +
      `bottom:${FLOOR_CELLS * px}px;width:${CRITTER_CELLS * px}px;height:${CRITTER_CELLS * px}px;` +
      `${c.flip ? "transform:scaleX(-1);" : ""}">`,
  );
  return (
    `<div style="position:relative;width:${cols * px}px;height:${height}px;overflow:hidden;` +
    `background:url('${art.ground}') ${-offset * px}px 0/${GROUND_COLS * px}px ${height}px repeat-x;">` +
    `${props.join("")}${standing.join("")}</div>`
  );
}

/** A few faint stars, from a fixed seed so re-renders don't churn the PNGs. */
function stars(width, height, count, seed) {
  let s = seed;
  const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280;
  const dots = Array.from({ length: count }, () => {
    const left = Math.round(rnd() * width);
    const top = Math.round(rnd() * height);
    const opacity = (0.15 + rnd() * 0.45).toFixed(2);
    return `<i style="left:${left}px;top:${top}px;opacity:${opacity}"></i>`;
  });
  return `<div class="stars">${dots.join("")}</div>`;
}

const BASE_CSS = `
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { overflow: hidden; }
body { font-family: "Inter", -apple-system, "SF Pro Display", "Segoe UI", system-ui, sans-serif; }
img { image-rendering: pixelated; display: block; }
/* The home banner's look: white with a faint brighter band (App.css .ascii-logo-glitch). */
.banner { font-family: "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace; line-height: 1;
  white-space: pre;
  background: linear-gradient(100deg, #e4e6ee 0%, #f2f3f8 25%, #ffffff 50%, #f2f3f8 75%, #e4e6ee 100%);
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
/* The app's dark surface (--bg #0a0a0c) with its blue / periwinkle glows. */
.sky { position: absolute; inset: 0;
  background:
    radial-gradient(70% 55% at 50% 0%, rgba(77, 157, 255, 0.16), transparent 70%),
    radial-gradient(60% 50% at 90% 100%, rgba(155, 140, 247, 0.14), transparent 70%),
    linear-gradient(180deg, #121318 0%, #0a0a0c 100%); }
.stars i { position: absolute; width: 2px; height: 2px; background: #fff; border-radius: 1px; }
/* The critters' speech bubble (App.css .critter-bubble). */
.bubble { position: absolute; background: #fff; color: #0a0a0c; font-weight: 700;
  border-radius: 10px; padding: 5px 10px; white-space: nowrap;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.45); }
.bubble::after { content: ""; position: absolute; top: 100%; left: 50%; margin-left: -6px;
  border: 6px solid transparent; border-top-color: #fff; }
`;

const page = (width, height, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}` +
  `html, body { width: ${width}px; height: ${height}px; }</style></head><body>${body}</body></html>`;

/**
 * macOS DMG window: 1320×800 (2× of the 660×400 window).
 *
 * Finder draws the two 128pt icons centred at (180,170) and (480,170) — at 2×
 * (360,340) and (960,340), spanning y 212–468 — and their 16pt labels just
 * below, in BLACK, which nothing can recolour. So each label gets a light name
 * plate to sit on, and the scene (banner above; meadow and critters below)
 * keeps clear of both.
 */
function dmg(lines) {
  const W = 1320;
  const H = 800;
  const px = 6;
  const groundTop = 706; // the surface the critters stand on
  const stripTop = groundTop - (TERRAIN_ROWS - FLOOR_CELLS) * px;
  const plates = [360, 960]
    .map(
      (x) =>
        `<div style="position:absolute;left:${x - 124}px;top:474px;width:248px;height:58px;` +
        `border-radius:29px;background:rgba(255,255,255,0.92);` +
        `box-shadow:0 2px 14px rgba(0,0,0,0.35)"></div>`,
    )
    .join("");
  const scene = terrainStrip(
    "meadow",
    Math.ceil(W / px),
    px,
    [
      { id: "frog", x: 30 },
      { id: "bee", x: 50, flip: true },
      { id: "robot", x: 102 },
      { id: "fox", x: 150, flip: true },
      { id: "ghost", x: 186 },
    ],
    { offset: 18 },
  );
  return page(
    W,
    H,
    `<div class="sky"></div>${stars(W, 640, 54, 7)}
    <div style="position:absolute;top:34px;left:0;right:0;display:flex;justify-content:center">
      <div class="banner" style="font-size:11px">${esc(lines.join("\n"))}</div></div>
    <div style="position:absolute;top:150px;left:0;right:0;text-align:center;color:#c9ccd6;
      font-size:23px;font-weight:600">Drag Supah Coder into your Applications folder</div>
    <div style="position:absolute;left:520px;top:322px;width:280px;height:36px">
      <svg width="280" height="36" viewBox="0 0 280 36" fill="none">
        <path d="M6 18 H252" stroke="#ff8fd0" stroke-width="5" stroke-linecap="round" stroke-dasharray="2 16"/>
        <path d="M246 6 L272 18 L246 30" stroke="#ff8fd0" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg></div>
    ${plates}
    <div class="bubble" style="left:${102 * px + 7 * px - 30}px;top:${groundTop - CRITTER_CELLS * px - 44}px;
      font-size:20px">hi!</div>
    <div style="position:absolute;left:0;top:${stripTop}px">${scene}</div>`,
  );
}

/** NSIS Welcome/Finish sidebar: 328×628 (2× of 164×314). */
function sidebar(lines) {
  const W = 328;
  const H = 628;
  const px = 4;
  // Only the "SUPAH" word of the banner: the sidebar is too narrow for all of
  // it. Cut at the first column that is blank on every line (the word gap).
  const width = Math.max(...lines.map((line) => line.length));
  let cut = width;
  for (let col = 1; col < width; col++) {
    if (lines.every((line) => (line[col] ?? " ") === " ")) {
      cut = col;
      break;
    }
  }
  const gg = lines.map((line) => line.slice(0, cut).trimEnd());
  const stripH = TERRAIN_ROWS * px;
  const scene = terrainStrip(
    "meadow",
    Math.ceil(W / px),
    px,
    [
      { id: "frog", x: 12 },
      { id: "robot", x: 46 },
      { id: "bee", x: 62, flip: true },
    ],
    { offset: 4 },
  );
  return page(
    W,
    H,
    `<div class="sky"></div>${stars(W, 380, 26, 3)}
    <div style="position:absolute;top:118px;left:0;right:0;display:flex;justify-content:center">
      <div class="banner" style="font-size:9.6px">${esc(gg.join("\n"))}</div></div>
    <div style="position:absolute;top:226px;left:0;right:0;text-align:center;color:#f4f6f8;
      font-size:30px;font-weight:800;letter-spacing:-0.02em">Supah Coder</div>
    <div style="position:absolute;top:268px;left:0;right:0;text-align:center;color:#9aa3b2;
      font-size:17px">the coding agent, with critters</div>
    <div class="bubble" style="left:${46 * px + 7 * px - 30}px;top:${H - stripH + (TERRAIN_ROWS - FLOOR_CELLS - CRITTER_CELLS) * px - 38}px;
      font-size:16px">hi!</div>
    <div style="position:absolute;left:0;bottom:0">${scene}</div>`,
  );
}

/** NSIS page header: 300×114 (2× of 150×57). NSIS draws it top-right. */
function header() {
  const W = 300;
  const H = 114;
  const px = 3;
  const scene = terrainStrip(
    "meadow",
    Math.ceil(W / px),
    px,
    [
      { id: "robot", x: 70 },
      { id: "frog", x: 86, flip: true },
    ],
    { offset: 30, sky: false },
  );
  return page(
    W,
    H,
    `<div class="sky"></div>${stars(W, 60, 10, 5)}
    <div style="position:absolute;right:20px;top:20px;color:#f4f6f8;font-size:26px;font-weight:800;
      letter-spacing:-0.02em">Supah Coder</div>
    <div style="position:absolute;left:0;bottom:0">${scene}</div>`,
  );
}

async function main() {
  const lines = bannerLines();
  const pages = [
    ["dmg-background", dmg(lines), 1320, 800],
    ["nsis-sidebar", sidebar(lines), 328, 628],
    ["nsis-header", header(), 300, 114],
  ];
  const browser = await chromium.launch();
  try {
    for (const [name, html, width, height] of pages) {
      const tab = await browser.newPage({ viewport: { width, height } });
      await tab.setContent(html, { waitUntil: "load" });
      await tab.screenshot({ path: join(here, `${name}.png`) });
      await tab.close();
      console.log(`rendered ${name}.png (${width}×${height})`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
