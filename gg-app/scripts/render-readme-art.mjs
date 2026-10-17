/**
 * README artwork renderer.
 *
 * Draws the README's illustrative panels as HTML in headless Chromium and
 * screenshots them, so the art is regenerable, diffable, and always uses the
 * REAL app palette (`gg-app/src/theme.ts`) rather than hand-picked hex codes
 * that drift the moment the app is restyled.
 *
 * Nothing here reads `~/.gg`: every project name, model and number on these
 * panels is either fictional demo data or a fact taken from the repo itself.
 * Product screenshots live in `capture-screenshots.mjs`, next to this file.
 *
 * Usage: node gg-app/scripts/render-readme-art.mjs [panel...]   (default: all)
 * Output: docs/art/*.png
 */
import { chromium } from "playwright";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../../docs/art");

// ── Palette ──────────────────────────────────────────────────────────────────
// Read from the app's token file so the README can never show a color the app
// stopped using. Missing key = loud failure, not a silent wrong-color render.
const themeSrc = await readFile(resolve(here, "../src/theme.ts"), "utf-8");
const token = (key) => {
  const found = new RegExp(`\\b${key}:\\s*"([^"]+)"`).exec(themeSrc)?.[1];
  if (!found) throw new Error(`theme.ts has no \`${key}\` — update render-readme-art.mjs`);
  return found;
};
const C = {
  bg: token("background"),
  surface: token("surface1"),
  surface2: token("surface2"),
  border: token("border"),
  text: token("text"),
  muted: token("textMuted"),
  dim: token("textDim"),
  accent: token("primary"),
  ken: token("ken"),
};

// ── Type ─────────────────────────────────────────────────────────────────────
// Real typefaces, fetched at render time and inlined as base64 so the panels
// look identical on every machine (a system-font stack renders differently on
// macOS, Windows and CI, which is how README art ends up looking generic).
// Space Grotesk carries the display voice; JetBrains Mono the terminal one.
const FACES = [
  {
    family: "Space Grotesk",
    weight: 700,
    url: "https://cdn.jsdelivr.net/fontsource/fonts/space-grotesk@latest/latin-700-normal.woff2",
  },
  {
    family: "Space Grotesk",
    weight: 500,
    url: "https://cdn.jsdelivr.net/fontsource/fonts/space-grotesk@latest/latin-500-normal.woff2",
  },
  {
    family: "JetBrains Mono",
    weight: 500,
    url: "https://cdn.jsdelivr.net/fontsource/fonts/jetbrains-mono@latest/latin-500-normal.woff2",
  },
  {
    family: "JetBrains Mono",
    weight: 700,
    url: "https://cdn.jsdelivr.net/fontsource/fonts/jetbrains-mono@latest/latin-700-normal.woff2",
  },
];

// A silent fallback to Helvetica is exactly the failure this is meant to
// prevent, so a face that will not download is fatal.
const fontCss = (
  await Promise.all(
    FACES.map(async ({ family, weight, url }) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${family} ${weight}: ${res.status} from ${url}`);
      const b64 = Buffer.from(await res.arrayBuffer()).toString("base64");
      return `@font-face{font-family:"${family}";font-weight:${weight};font-style:normal;font-display:block;src:url(data:font/woff2;base64,${b64}) format("woff2")}`;
    }),
  )
).join("");

const FONT = `"Space Grotesk", sans-serif`;
const MONO = `"JetBrains Mono", monospace`;

const shell = (body, extraCss = "") => `<!doctype html><html><head><meta charset="utf-8"><style>
  ${fontCss}
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { width: 1280px; background: ${C.bg}; color: ${C.text}; font-family: ${FONT};
         font-weight: 500; -webkit-font-smoothing: antialiased; }
  .pad { padding: 44px 50px; }
  .eyebrow { font-family: ${MONO}; font-size: 13px; letter-spacing: .18em; text-transform: uppercase; color: ${C.accent}; }
  .muted { color: ${C.muted}; }
  .dim { color: ${C.dim}; }
  .mono { font-family: ${MONO}; }
  .card { background: ${C.surface}; border: 1px solid ${C.border}; border-radius: 14px; }
  .rule { height: 1px; background: ${C.border}; }
  ${extraCss}
</style></head><body>${body}</body></html>`;

// ── Panels ───────────────────────────────────────────────────────────────────
const panels = {
  /** Title card. */
  hero: {
    height: 440,
    html: shell(`
      <div class="pad" style="height:440px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px">
        <div class="eyebrow">📱 You don't have to be there</div>
        <div style="font-size:104px;font-weight:800;letter-spacing:-.035em;line-height:1">GG CODER</div>
        <div style="font-size:26px;color:${C.muted}">Text it from the pub. It codes. It checks itself.</div>
        <div class="rule" style="width:620px;margin-top:10px"></div>
        <div class="mono" style="font-size:15px;color:${C.muted};display:flex;gap:26px">
          <span>runs <b style="color:${C.accent}">while you sleep</b></span><span class="dim">|</span>
          <span>takes <b style="color:${C.accent}">voice notes</b></span><span class="dim">|</span>
          <span>has its <b style="color:${C.accent}">own reviewer</b></span>
        </div>
      </div>`),
  },

  // NOTE: this file renders the title card ONLY, and deliberately so. Every
  // other README image must be a real capture of the real app
  // (`capture-screenshots.mjs`). Hand-drawing a fake GG Coder window here would
  // show readers a product that does not exist and make the real UI look worse
  // than it is, so mocked app chrome does not belong in this file.
};

// ── Render ───────────────────────────────────────────────────────────────────
const wanted = process.argv.slice(2);
const unknown = wanted.filter((n) => !panels[n]);
if (unknown.length) throw new Error(`unknown panel(s): ${unknown.join(", ")}`);
const names = wanted.length ? wanted : Object.keys(panels);

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
try {
  for (const name of names) {
    const { html, height } = panels[name];
    const page = await browser.newPage({
      viewport: { width: 1280, height },
      deviceScaleFactor: 2,
    });
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(() => document.fonts?.ready);
    const path = resolve(outDir, `${name}.png`);
    await page.screenshot({ path });
    await page.close();
    console.log(`✓ ${path}`);
  }
} finally {
  await browser.close();
}
