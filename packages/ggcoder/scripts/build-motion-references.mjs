#!/usr/bin/env node
// Rebuild compact temporal previews from bundled GG source. No network/install.
// Pass an existing local gsap.min.js for the library piece's pinned script.
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const sharp = require("sharp");
const root = fileURLToPath(new URL("../assets/motion/references/", import.meta.url));
const gsapFile = process.argv[2];
if (!gsapFile || (await stat(gsapFile)).size > 200_000)
  throw new Error("Pass a bounded, already-installed local gsap.min.js");
const gsap = await readFile(gsapFile);
const browser = await chromium.launch({ headless: true });
try {
  for (const study of [
    {
      file: "signal-study.html",
      out: "signal-temporal.jpg",
      times: [0, 0.5, 1, 2, 3, 4],
      viewport: { width: 960, height: 540 },
    },
    {
      file: "../library/pieces/scale-through-word/piece.html",
      out: "type-temporal.jpg",
      times: [0.3, 0.9, 1.5, 1.9, 2.2, 2.5],
      viewport: { width: 1920, height: 1080 },
    },
  ]) {
    const page = await browser.newPage({ viewport: study.viewport });
    await page.route("https://**", (route) =>
      route.request().url() === "https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"
        ? route.fulfill({ body: gsap, contentType: "text/javascript" })
        : route.abort(),
    );
    await page.goto(pathToFileURL(path.resolve(root, study.file)).href);
    const composites = [];
    for (const [i, time] of study.times.entries()) {
      await page.evaluate((t) => {
        if (window.seekStudy) window.seekStudy(t);
        else window.__timelines["scale-through-word"].seek(t, false);
      }, time);
      const frame = await sharp(await page.screenshot())
        .resize(480, 270)
        .toBuffer();
      const left = (i % 3) * 480;
      const top = Math.floor(i / 3) * 298;
      composites.push({ input: frame, left, top });
      composites.push({
        input: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="28"><text x="8" y="20" fill="white" font-size="16">${time.toFixed(1)} seconds</text></svg>`,
        ),
        left,
        top: top + 270,
      });
    }
    await sharp({ create: { width: 1440, height: 596, channels: 3, background: "#171717" } })
      .composite(composites)
      .jpeg({ quality: 80 })
      .toFile(path.join(root, study.out));
    await page.close();
  }
} finally {
  await browser.close();
}
