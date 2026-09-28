#!/usr/bin/env node
// Maintainer tool: (re)download GG Motion's bundled font library into
// assets/motion/fonts/. Not run at build or install time; the fetched files
// are checked in so the app works offline.
//
// Every family is SIL OFL 1.1 from Google Fonts. Files are the Latin-subset
// variable woff2 cuts Google serves to modern Chrome; each family's OFL.txt
// comes from github.com/google/fonts.
//
// Families with a Reserved Font Name (`full: true`) must not be subset under
// their original name (OFL §3), so those ship as the complete google/fonts TTF,
// only recompressed to woff2 (a format change, not a modification). That step
// needs fontTools with brotli: `pip install fonttools brotli`.
//
// Run: node scripts/fetch-motion-fonts.mjs
import { execFileSync } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "motion", "fonts");
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36";

/** `spec` is the Google Fonts css2 family parameter; `ofl` the google/fonts dir. */
const FAMILIES = [
  {
    name: "Mona Sans",
    ofl: "monasans",
    full: { ttf: "MonaSans[wdth,wght].ttf", weight: "200 900", stretch: "75% 125%" },
  },
  {
    name: "Hubot Sans",
    ofl: "hubotsans",
    full: { ttf: "HubotSans[wdth,wght].ttf", weight: "200 900", stretch: "75% 125%" },
  },
  {
    name: "Bricolage Grotesque",
    ofl: "bricolagegrotesque",
    spec: "Bricolage+Grotesque:opsz,wdth,wght@12..96,75..100,200..800",
  },
  { name: "Schibsted Grotesk", ofl: "schibstedgrotesk", spec: "Schibsted+Grotesk:wght@400..900" },
  { name: "Host Grotesk", ofl: "hostgrotesk", spec: "Host+Grotesk:wght@300..800" },
  { name: "Funnel Display", ofl: "funneldisplay", spec: "Funnel+Display:wght@300..800" },
  { name: "Anybody", ofl: "anybody", spec: "Anybody:wdth,wght@50..150,100..900" },
  { name: "Archivo", ofl: "archivo", spec: "Archivo:wdth,wght@62..125,100..900" },
  { name: "Big Shoulders", ofl: "bigshoulders", spec: "Big+Shoulders:opsz,wght@10..72,100..900" },
  {
    name: "Fraunces",
    ofl: "fraunces",
    spec: "Fraunces:ital,opsz,wght,SOFT,WONK@0,9..144,100..900,0..100,0..1;1,9..144,100..900,0..100,0..1",
  },
  {
    name: "Newsreader",
    ofl: "newsreader",
    spec: "Newsreader:ital,opsz,wght@0,6..72,200..800;1,6..72,200..800",
  },
  { name: "Doto", ofl: "doto", spec: "Doto:wght,ROND@100..900,0..100" },
  { name: "Gloock", ofl: "gloock", spec: "Gloock" },
  { name: "Young Serif", ofl: "youngserif", spec: "Young+Serif" },
  { name: "Martian Mono", ofl: "martianmono", spec: "Martian+Mono:wdth,wght@75..112.5,100..800" },
];

const slug = (name) => name.toLowerCase().replace(/\s+/g, "-");

async function get(url, as) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return as === "text" ? res.text() : Buffer.from(await res.arrayBuffer());
}

/** Latin-only @font-face blocks from a css2 response. */
function latinFaces(css) {
  const faces = [];
  for (const m of css.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g)) {
    if (m[1] !== "latin") continue;
    const body = m[2];
    const pick = (prop) => body.match(new RegExp(`${prop}:\\s*([^;]+);`))?.[1].trim();
    faces.push({
      style: pick("font-style") ?? "normal",
      weight: pick("font-weight") ?? "400",
      stretch: pick("font-stretch"),
      url: body.match(/url\((https:[^)]+\.woff2)\)/)?.[1],
      range: pick("unicode-range"),
    });
  }
  return faces;
}

const manifest = [];
await mkdir(OUT, { recursive: true });
for (const entry of await readdir(OUT)) {
  if (entry !== "README.md") await rm(join(OUT, entry), { recursive: true, force: true });
}
for (const family of FAMILIES) {
  const dir = join(OUT, slug(family.name));
  await mkdir(dir, { recursive: true });
  const oflBase = `https://raw.githubusercontent.com/google/fonts/main/ofl/${family.ofl}`;
  await writeFile(join(dir, "OFL.txt"), await get(`${oflBase}/OFL.txt`));
  if (family.full) {
    const file = `${slug(family.name)}-normal.woff2`;
    const ttf = join(dir, "source.ttf");
    await writeFile(ttf, await get(`${oflBase}/${encodeURIComponent(family.full.ttf)}`));
    execFileSync("python3", [
      "-c",
      "import sys; from fontTools.ttLib import TTFont; f = TTFont(sys.argv[1]); f.flavor = 'woff2'; f.save(sys.argv[2])",
      ttf,
      join(dir, file),
    ]);
    await rm(ttf);
    const { weight, stretch } = family.full;
    manifest.push({
      family: family.name,
      dir: slug(family.name),
      license: "OFL-1.1",
      files: [{ file, style: "normal", weight, stretch }],
    });
    process.stdout.write(`${family.name}: full font\n`);
    continue;
  }
  const css = await get(
    `https://fonts.googleapis.com/css2?family=${family.spec}&display=block`,
    "text",
  );
  const faces = latinFaces(css);
  if (faces.length === 0) throw new Error(`No latin faces for ${family.name}`);
  const files = [];
  for (const face of faces) {
    if (!face.url) throw new Error(`No woff2 url for ${family.name}`);
    const file = `${slug(family.name)}-${face.style}.woff2`;
    await writeFile(join(dir, file), await get(face.url));
    files.push({ file, style: face.style, weight: face.weight, stretch: face.stretch ?? null });
  }
  manifest.push({ family: family.name, dir: slug(family.name), license: "OFL-1.1", files });
  process.stdout.write(`${family.name}: ${files.length} file(s)\n`);
}
await writeFile(join(OUT, "fonts.json"), `${JSON.stringify(manifest, null, 2)}\n`);
