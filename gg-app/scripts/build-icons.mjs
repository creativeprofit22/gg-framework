// Builds GG Coder's whole icon set from one source: the capital "G" of the
// "Delta Corps Priest 1" FIGlet font, in white with a soft diagonal shine, on
// a black rounded tile.
//
//   node gg-app/scripts/build-icons.mjs
//
// Writes, under gg-app/:
//   src-tauri/icons/*.png, icon.icns, icon.ico   desktop app + Windows tiles
//   src-tauri/icons/tray-mac.png                 macOS menu-bar template (black on clear)
//   src-tauri/icons/ios/*, android/*             mobile sets
//   installer/logo.png                           NSIS installer art (copy of 256px)
//   icon-source.svg, icon-source.png             the 1024px master
//
// The .icns step uses macOS `iconutil`; elsewhere it is skipped with a note.
// Rasterising uses sharp, resolved from packages/ggcoder like installer/build-art.mjs.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const require = createRequire(join(app, "..", "packages", "ggcoder", "package.json"));
const sharp = require("sharp");

/**
 * "G" from Delta Corps Priest 1 (by CoSMiC cHiLD, via patorjk/figlet.js),
 * with each half-block character split into two cells. 12 × 16.
 */
export const GLYPH = [
  "....######..",
  "...########.",
  "..###....###",
  "..###....###",
  "..###....##.",
  "..###....#..",
  "..###.......",
  ".####.......",
  "#####.####..",
  "..###.#####.",
  "..###....###",
  "..###....###",
  "..###....###",
  "..###....###",
  "..#########.",
  "..########..",
];
const COLS = GLYPH[0].length;
const ROWS = GLYPH.length;

/** Continuous-corner rounded square ("squircle") at x,y with side s. */
function squircle(x, y, s) {
  const r = s * 0.225;
  const k = r * 0.45;
  return (
    `M${x + r},${y} H${x + s - r} C${x + s - k},${y} ${x + s},${y + k} ${x + s},${y + r} ` +
    `V${y + s - r} C${x + s},${y + s - k} ${x + s - k},${y + s} ${x + s - r},${y + s} ` +
    `H${x + r} C${x + k},${y + s} ${x},${y + s - k} ${x},${y + s - r} ` +
    `V${y + r} C${x},${y + k} ${x + k},${y} ${x + r},${y} Z`
  );
}

/** One path covering the glyph's cells, run by run, so the letter has no seams. */
function glyphPath(gx, gy, cell) {
  let d = "";
  GLYPH.forEach((row, y) => {
    let x = 0;
    while (x < COLS) {
      if (row[x] !== "#") {
        x++;
        continue;
      }
      let end = x;
      while (end < COLS && row[end] === "#") end++;
      d += `M${gx + x * cell},${gy + y * cell}h${(end - x) * cell}v${cell}h${-(end - x) * cell}z`;
      x = end;
    }
  });
  return d;
}

/**
 * The icon as SVG.
 * - shape: "squircle" | "square" | "circle" (tile outline) or "none" (glyph only)
 * - inset: tile size as a fraction of the canvas (macOS grid: 824/1024)
 * - glyph: glyph height as a fraction of the tile
 * - mono: plain black glyph on clear (macOS menu-bar template)
 */
export function iconSvg(
  size,
  { shape = "squircle", inset = 824 / 1024, glyph = 0.6, mono = false } = {},
) {
  const tile = size * inset;
  const t0 = (size - tile) / 2;
  let cell = (tile * glyph) / ROWS;
  // Small sizes: whole-pixel cells keep the blocks crisp, if they still fit.
  const snap = size <= 64 && Math.round(cell) >= 1 && Math.round(cell) * ROWS <= tile * 0.8;
  if (snap) cell = Math.round(cell);
  const w = cell * COLS;
  const h = cell * ROWS;
  // The G's left spur is light, so nudge the letter a touch left to look centred.
  let gx = t0 + (tile - w) / 2 - cell * 0.15;
  let gy = t0 + (tile - h) / 2;
  if (snap) {
    gx = Math.round(gx);
    gy = Math.round(gy);
  }
  const d = glyphPath(gx, gy, cell);

  if (mono) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><path d="${d}" fill="#000"/></svg>`;
  }

  const tilePath =
    shape === "circle"
      ? `<circle cx="${size / 2}" cy="${size / 2}" r="${tile / 2}"/>`
      : shape === "square"
        ? `<rect x="${t0}" y="${t0}" width="${tile}" height="${tile}"/>`
        : `<path d="${squircle(t0, t0, tile)}"/>`;
  const glow = size >= 64; // a soft halo helps big; at small sizes it only blurs
  const tileLayers =
    shape === "none"
      ? ""
      : `<g clip-path="url(#tile)"><rect width="${size}" height="${size}" fill="url(#bg)"/></g>`;
  const rim =
    shape === "squircle" && size >= 64
      ? `<path d="${squircle(t0 + size * 0.0015, t0 + size * 0.0015, tile - size * 0.003)}" fill="none" stroke="url(#rim)" stroke-width="${size * 0.003}"/>`
      : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#26262b"/><stop offset="0.5" stop-color="#121214"/><stop offset="1" stop-color="#050506"/>
  </linearGradient>
  <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#fff" stop-opacity="0.22"/><stop offset="0.35" stop-color="#fff" stop-opacity="0.04"/><stop offset="1" stop-color="#fff" stop-opacity="0.02"/>
  </linearGradient>
  <linearGradient id="ink" x1="0" y1="${gy}" x2="0" y2="${gy + h}" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#fff"/><stop offset="0.55" stop-color="#f1f2f6"/><stop offset="1" stop-color="#c9ccd6"/>
  </linearGradient>
  <linearGradient id="sheen" x1="${gx}" y1="${gy}" x2="${gx + w}" y2="${gy + h}" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.36" stop-color="#fff" stop-opacity="0"/>
    <stop offset="0.44" stop-color="#fff" stop-opacity="0.9"/><stop offset="0.5" stop-color="#fff" stop-opacity="0"/>
    <stop offset="1" stop-color="#fff" stop-opacity="0"/>
  </linearGradient>
  <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
    <feGaussianBlur stdDeviation="${cell * 0.5}" result="b"/>
    <feColorMatrix in="b" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.22 0"/>
    <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <clipPath id="tile">${tilePath}</clipPath>
</defs>
${tileLayers}
<g${glow ? ' filter="url(#glow)"' : ""}><path d="${d}" fill="url(#ink)"/><path d="${d}" fill="url(#sheen)"/></g>
${rim}
</svg>`;
}

// Variants per destination.
const MAC = { shape: "squircle", inset: 824 / 1024, glyph: 0.6 }; // macOS grid, padded
const SMALL = { shape: "squircle", inset: 0.94, glyph: 0.66 }; // ≤ 48px: fill the space
const WIN = { shape: "squircle", inset: 0.92, glyph: 0.62 }; // Windows tiles / .ico
const IOS = { shape: "square", inset: 1, glyph: 0.5 }; // opaque, iOS rounds it itself
const ANDROID = { shape: "squircle", inset: 0.9, glyph: 0.6 };
const ANDROID_ROUND = { shape: "circle", inset: 0.9, glyph: 0.52 };
const ANDROID_FG = { shape: "none", inset: 1, glyph: 0.36 }; // inside the 66dp safe zone
const TRAY = { mono: true, inset: 1, glyph: 0.84 };

async function png(size, variant, { opaque = false } = {}) {
  let img = sharp(Buffer.from(iconSvg(size, variant))).png();
  if (opaque) img = img.flatten({ background: "#050506" });
  return img.toBuffer();
}

async function write(rel, size, variant, opts) {
  const file = join(app, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, await png(size, variant, opts));
  return file;
}

/** A .ico holding PNG images (Vista+ reads PNG entries directly). */
function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + i * 16;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt16LE(1, e + 4); // planes
    header.writeUInt16LE(32, e + 6); // bpp
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.data)]);
}

async function main() {
  const icons = "src-tauri/icons";
  const small = (s) => (s <= 48 ? SMALL : MAC);

  // Desktop app icons (referenced by tauri.conf.json bundle.icon).
  for (const [name, size] of [
    ["32x32.png", 32],
    ["64x64.png", 64],
    ["128x128.png", 128],
    ["128x128@2x.png", 256],
    ["icon.png", 512],
  ]) {
    await write(`${icons}/${name}`, size, small(size));
  }

  // Windows Store tiles.
  for (const s of [30, 44, 71, 89, 107, 142, 150, 284, 310]) {
    await write(`${icons}/Square${s}x${s}Logo.png`, s, s <= 48 ? SMALL : WIN);
  }
  await write(`${icons}/StoreLogo.png`, 50, WIN);

  // macOS menu-bar template: black glyph on clear; macOS tints it.
  await write(`${icons}/tray-mac.png`, 72, TRAY);

  // Windows .ico.
  const icoSizes = [16, 24, 32, 48, 64, 256];
  const icoImages = [];
  for (const size of icoSizes)
    icoImages.push({ size, data: await png(size, size <= 48 ? SMALL : WIN) });
  writeFileSync(join(app, icons, "icon.ico"), ico(icoImages));

  // macOS .icns via iconutil.
  if (process.platform === "darwin") {
    const dir = mkdtempSync(join(tmpdir(), "gg-icon-"));
    const set = join(dir, "icon.iconset");
    mkdirSync(set);
    for (const [base, s] of [
      ["16x16", 16],
      ["32x32", 32],
      ["128x128", 128],
      ["256x256", 256],
      ["512x512", 512],
    ]) {
      writeFileSync(join(set, `icon_${base}.png`), await png(s, small(s)));
      writeFileSync(join(set, `icon_${base}@2x.png`), await png(s * 2, small(s * 2)));
    }
    execFileSync("iconutil", ["-c", "icns", set, "-o", join(app, icons, "icon.icns")]);
    rmSync(dir, { recursive: true, force: true });
  } else {
    console.warn("skipped icon.icns: iconutil is macOS-only");
  }

  // iOS (opaque, full-bleed: iOS applies its own mask).
  for (const [name, size] of [
    ["AppIcon-20x20@1x.png", 20],
    ["AppIcon-20x20@2x.png", 40],
    ["AppIcon-20x20@2x-1.png", 40],
    ["AppIcon-20x20@3x.png", 60],
    ["AppIcon-29x29@1x.png", 29],
    ["AppIcon-29x29@2x.png", 58],
    ["AppIcon-29x29@2x-1.png", 58],
    ["AppIcon-29x29@3x.png", 87],
    ["AppIcon-40x40@1x.png", 40],
    ["AppIcon-40x40@2x.png", 80],
    ["AppIcon-40x40@2x-1.png", 80],
    ["AppIcon-40x40@3x.png", 120],
    ["AppIcon-60x60@2x.png", 120],
    ["AppIcon-60x60@3x.png", 180],
    ["AppIcon-76x76@1x.png", 76],
    ["AppIcon-76x76@2x.png", 152],
    ["AppIcon-83.5x83.5@2x.png", 167],
    ["AppIcon-512@2x.png", 1024],
  ]) {
    await write(`${icons}/ios/${name}`, size, IOS, { opaque: true });
  }

  // Android launcher icons (legacy, round, adaptive foreground).
  for (const [density, size, fg] of [
    ["mdpi", 48, 108],
    ["hdpi", 49, 162],
    ["xhdpi", 96, 216],
    ["xxhdpi", 144, 324],
    ["xxxhdpi", 192, 432],
  ]) {
    await write(`${icons}/android/mipmap-${density}/ic_launcher.png`, size, ANDROID);
    await write(`${icons}/android/mipmap-${density}/ic_launcher_round.png`, size, ANDROID_ROUND);
    await write(`${icons}/android/mipmap-${density}/ic_launcher_foreground.png`, fg, ANDROID_FG);
  }
  writeFileSync(
    join(app, icons, "android/values/ic_launcher_background.xml"),
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n  <color name="ic_launcher_background">#121214</color>\n</resources>`,
  );

  // Installer art uses the 256px icon; the master lives next to the app.
  writeFileSync(join(app, "installer/logo.png"), readFileSync(join(app, icons, "128x128@2x.png")));
  writeFileSync(join(app, "icon-source.svg"), iconSvg(1024, MAC));
  await write("icon-source.png", 1024, MAC);

  console.log("icons written");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
