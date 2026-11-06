#!/usr/bin/env node
// Maintainer tool: redraw assets/motion/fonts/specimen.jpg from fonts.json, so
// the Motion agent sees every bundled family before choosing one. Uses only the
// local font files. Run after scripts/fetch-motion-fonts.mjs.
//
// Run: node scripts/build-motion-font-specimen.mjs
import { readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const sharp = require("sharp");

const fontsDir = fileURLToPath(new URL("../assets/motion/fonts/", import.meta.url));
const manifest = JSON.parse(await readFile(path.join(fontsDir, "fonts.json"), "utf8"));
const SAMPLE = "Ship it tonight. 2,048";
const WIDTH = 1440;
const ROW = 77;

// Bold where the family has it, so faces compare at display weight.
const sampleWeight = (weight) => {
  const [low, high = low] = String(weight).split(" ").map(Number);
  return Math.min(Math.max(700, low), high);
};
const escapeHtml = (text) =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const faces = manifest.flatMap((entry) =>
  entry.files.map((file) => {
    const url = pathToFileURL(path.join(fontsDir, entry.dir, file.file)).href;
    const stretch = file.stretch ? `font-stretch:${file.stretch};` : "";
    return `@font-face{font-family:"${entry.family}";src:url("${url}") format("woff2");font-style:${file.style};font-weight:${file.weight};${stretch}font-display:block}`;
  }),
);
const rows = manifest.map((entry) => {
  const file = entry.files.find((f) => f.style === "normal") ?? entry.files[0];
  const style = `font-family:"${entry.family}";font-style:${file.style};font-weight:${sampleWeight(file.weight)}`;
  return `<div class="row"><div class="label">${escapeHtml(entry.family)}</div><div class="sample" style='${style}'>${SAMPLE}</div></div>`;
});
const height = Math.ceil(manifest.length / 2) * ROW + 44;
const html = `<!doctype html><meta charset="utf-8"><style>${faces.join("")}
*{box-sizing:border-box;margin:0}
body{width:${WIDTH}px;height:${height}px;background:#0d0d0d;color:#f2f2f2;padding:20px 45px;
display:grid;grid-template-columns:1fr 1fr;column-gap:45px;align-content:start;overflow:hidden}
.row{height:${ROW}px;border-top:1px solid #2a2a2a;padding-top:8px;overflow:hidden;white-space:nowrap}
.label{font:13px "Martian Mono",monospace;color:#9a9a9a;letter-spacing:.02em}
.sample{font-size:46px;line-height:1.1;display:inline-block}
</style><body>${rows.join("")}</body>`;

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height } });
  // A file:// page, so the local font files are allowed to load.
  const htmlFile = path.join(os.tmpdir(), `gg-font-specimen-${process.pid}.html`);
  await writeFile(htmlFile, html);
  await page.goto(pathToFileURL(htmlFile).href);
  await rm(htmlFile, { force: true });
  const missing = await page.evaluate(async () => {
    await Promise.allSettled([...document.fonts].map((face) => face.load()));
    // Shrink any sample too wide for its column rather than cropping it.
    for (const sample of document.querySelectorAll(".sample")) {
      const room = sample.parentElement.clientWidth;
      if (sample.scrollWidth > room) {
        sample.style.fontSize = `${(46 * room) / sample.scrollWidth}px`;
      }
    }
    return [...document.fonts].filter((face) => face.status !== "loaded").map((f) => f.family);
  });
  if (missing.length) throw new Error(`Fonts failed to load: ${missing.join(", ")}`);
  await sharp(await page.screenshot())
    .jpeg({ quality: 82 })
    .toFile(path.join(fontsDir, "specimen.jpg"));
  process.stdout.write(`specimen.jpg: ${manifest.length} families, ${WIDTH}x${height}\n`);
} finally {
  await browser.close();
}
