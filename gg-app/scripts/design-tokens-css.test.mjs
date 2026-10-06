import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Guards the design-token scales in App.css `:root`. A px literal that equals a
// token step must use the token, so the scale stays the single source. Odd
// one-off values (5px, 13.5px, 30px…) are allowed on purpose: the migration
// to tokens was pixel-identical, not a redesign.
const FILES = ["App.css", "glass.css", "ChecklistScreen.css", "ChatErrorNotice.css"];
const sheets = FILES.map((name) => ({
  name,
  css: readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8")
    // Comments may mention raw values; only real declarations count.
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " ")),
}));
const appCss = sheets[0].css;

const rootBlock = appCss.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "";
const rootTokens = new Map(
  [...rootBlock.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
);
const pxValuesOf = (prefix) =>
  new Set(
    [...rootTokens]
      .filter(([name, value]) => name.startsWith(prefix) && /^\d+(?:\.\d+)?px$/.test(value))
      .map(([, value]) => value),
  );
const fontSteps = pxValuesOf("--fs-");
const spaceSteps = pxValuesOf("--space-");
// 999px pills render the same as --radius-pill (9999px) on anything shorter.
const radiusSteps = new Set([...pxValuesOf("--radius-"), "999px"]);

const SPACING_PROP =
  /^(?:padding|margin)(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?$|^(?:row-|column-)?gap$/;

/** Every declaration outside `:root`, with its file and 1-based line. */
function declarations() {
  const out = [];
  for (const { name, css } of sheets) {
    const rootStart = name === "App.css" ? css.indexOf(":root") : -1;
    const rootEnd = rootStart >= 0 ? css.indexOf("}", rootStart) : -1;
    for (const m of css.matchAll(/(?:^|[\s;{])([a-z-]+)\s*:\s*([^;{}]+?)\s*(?=[;}])/g)) {
      if (m.index >= rootStart && m.index < rootEnd) continue;
      const line = css.slice(0, m.index).split("\n").length + (m[0].startsWith("\n") ? 1 : 0);
      out.push({ where: `${name}:${line}`, prop: m[1], value: m[2] });
    }
  }
  return out;
}

/** Top-level words of a value — anything inside calc()/var()/min() is skipped. */
function topLevelWords(value) {
  const words = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth === 0 && /\s/.test(ch)) {
      if (current) words.push(current);
      current = "";
    } else current += ch;
  }
  if (current) words.push(current);
  return words.filter((word) => word !== "!important");
}

const decls = declarations();

/** [start, end) ranges of every `:root { … }` and `@property … { … }` block. */
function definitionBlocks(css) {
  const ranges = [];
  for (const m of css.matchAll(/:root\s*\{|@property\s+--[\w-]+\s*\{/g)) {
    ranges.push([m.index, css.indexOf("}", m.index) + 1]);
  }
  return ranges;
}
const lineOf = (css, index) => css.slice(0, index).split("\n").length;

// Every token defined in a `:root` block of App.css or glass.css (both always
// load), with its raw value; later blocks override earlier ones by name.
const definedTokens = new Map();
for (const { name, css } of sheets.filter((s) => s.name === "App.css" || s.name === "glass.css")) {
  for (const [start, end] of definitionBlocks(css)) {
    const block = css.slice(start, end);
    if (!block.startsWith(":root")) continue;
    for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)[;}]/g)) {
      definedTokens.set(m[1], { value: m[2].trim(), file: name });
    }
  }
}

/** `#abc` → `#aabbcc`, `#abcd` → `#aabbccdd`, lowercased. */
function normalizeHex(hex) {
  const h = hex.toLowerCase();
  return h.length === 4 || h.length === 5 ? `#${[...h.slice(1)].map((c) => c + c).join("")}` : h;
}

// Neutral tokens: the canvas, surfaces, text ramp and ink-on-fill colours.
// Semantic and decorative tokens are excluded on purpose: a decorative stop
// that happens to equal --critter must not be forced to borrow it.
const NEUTRAL_TOKEN = /^--(?:bg|surface-[\w-]+|text|text-[\w-]+|on-[\w-]+)$/;
const neutralByHex = new Map();
for (const [token, { value }] of definedTokens) {
  if (!NEUTRAL_TOKEN.test(token)) continue;
  if (/^#[0-9a-f]{3,8}$/i.test(value)) neutralByHex.set(normalizeHex(value), token);
}

describe("design tokens", () => {
  it("reads the scales from :root", () => {
    expect(fontSteps.size).toBeGreaterThan(5);
    expect(spaceSteps.size).toBeGreaterThan(5);
    expect(radiusSteps.size).toBeGreaterThan(3);
  });

  it("uses an --fs-* token for every font-size on the type scale", () => {
    const offenders = decls
      .filter(
        ({ prop, value }) =>
          prop === "font-size" && fontSteps.has(value.replace(/\s*!important$/, "")),
      )
      .map(({ where, value }) => `${where} font-size: ${value}`);
    expect(offenders).toEqual([]);
  });

  it("uses a --space-* token for padding, margin and gap steps", () => {
    const offenders = decls
      .filter(
        ({ prop, value }) =>
          SPACING_PROP.test(prop) && topLevelWords(value).some((w) => spaceSteps.has(w)),
      )
      .map(({ where, prop, value }) => `${where} ${prop}: ${value}`);
    expect(offenders).toEqual([]);
  });

  it("uses a --radius-* token for single-value radii that match one", () => {
    const offenders = decls
      .filter(({ prop, value }) => {
        if (prop !== "border-radius") return false;
        const words = topLevelWords(value);
        return words.length === 1 && radiusSteps.has(words[0]);
      })
      .map(({ where, value }) => `${where} border-radius: ${value}`);
    expect(offenders).toEqual([]);
  });

  it("only references --fs-*, --space-*, --radius-* and --fx-* tokens that exist", () => {
    const missing = new Set();
    for (const { name, css } of sheets) {
      for (const m of css.matchAll(/var\(\s*(--(?:fs|space|radius|fx|on-fx)-[\w-]+)/g)) {
        if (!rootTokens.has(m[1])) missing.add(`${name}: ${m[1]}`);
      }
    }
    expect([...missing]).toEqual([]);
  });

  it("drops var() fallbacks on tokens that are always defined", () => {
    // A fallback on a defined token is dead code that drifts from the real
    // value. Tokens set per element (e.g. --critter-pc) keep theirs.
    expect(definedTokens.has("--text")).toBe(true);
    const offenders = [];
    for (const { name, css } of sheets) {
      for (const m of css.matchAll(/var\(\s*(--[\w-]+)\s*,/g)) {
        if (definedTokens.has(m[1])) offenders.push(`${name}:${lineOf(css, m.index)} ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("takes neutral colours from their tokens, not hex literals", () => {
    expect(neutralByHex.size).toBeGreaterThan(5);
    const offenders = [];
    for (const { name, css } of sheets) {
      const blocks = definitionBlocks(css);
      for (const m of css.matchAll(/#[0-9a-f]{3,8}\b/gi)) {
        if (blocks.some(([start, end]) => m.index >= start && m.index < end)) continue;
        const token = neutralByHex.get(normalizeHex(m[0]));
        if (token) offenders.push(`${name}:${lineOf(css, m.index)} ${m[0]} → var(${token})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
