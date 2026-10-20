import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Guards Notes and Roadmap styles against drift back to one-off values. Every
// colour, font size, radius and shadow in a Notes rule must come from the
// tokens in App.css `:root`. Scope: all of NotesRoadmap.css (the fork's Notes
// sheet) plus any App.css or Deck.css rule whose selector or enclosing rule
// names a `.notes-` or `.roadmap-` class. Rule idea (flag off-token values, suggest the nearest step) from
// shadcn-ui/lint `no-arbitrary-values` (MIT); no code is shared.
// Rules and how to extend them: .gg/style-pack.md, "Notes style-drift guard".

/**
 * Reviewed exceptions. One entry suppresses one exact declaration (every rule
 * finding on it); two identical declarations need two entries. An entry that
 * matches nothing fails, so the list never outlives the code it excuses.
 * Shape: { file, selector, prop, value, reason }, sorted by file then selector.
 * @type {ReadonlyArray<{ file: string; selector: string; prop: string; value: string; reason: string }>}
 */
const ALLOWLIST = [];

// CSS Color 4 named colours, sorted. `transparent` and `currentcolor` are
// allowed and handled separately.
const NAMED_COLOURS = new Set([
  "aliceblue",
  "antiquewhite",
  "aqua",
  "aquamarine",
  "azure",
  "beige",
  "bisque",
  "black",
  "blanchedalmond",
  "blue",
  "blueviolet",
  "brown",
  "burlywood",
  "cadetblue",
  "chartreuse",
  "chocolate",
  "coral",
  "cornflowerblue",
  "cornsilk",
  "crimson",
  "cyan",
  "darkblue",
  "darkcyan",
  "darkgoldenrod",
  "darkgray",
  "darkgreen",
  "darkgrey",
  "darkkhaki",
  "darkmagenta",
  "darkolivegreen",
  "darkorange",
  "darkorchid",
  "darkred",
  "darksalmon",
  "darkseagreen",
  "darkslateblue",
  "darkslategray",
  "darkslategrey",
  "darkturquoise",
  "darkviolet",
  "deeppink",
  "deepskyblue",
  "dimgray",
  "dimgrey",
  "dodgerblue",
  "firebrick",
  "floralwhite",
  "forestgreen",
  "fuchsia",
  "gainsboro",
  "ghostwhite",
  "gold",
  "goldenrod",
  "gray",
  "green",
  "greenyellow",
  "grey",
  "honeydew",
  "hotpink",
  "indianred",
  "indigo",
  "ivory",
  "khaki",
  "lavender",
  "lavenderblush",
  "lawngreen",
  "lemonchiffon",
  "lightblue",
  "lightcoral",
  "lightcyan",
  "lightgoldenrodyellow",
  "lightgray",
  "lightgreen",
  "lightgrey",
  "lightpink",
  "lightsalmon",
  "lightseagreen",
  "lightskyblue",
  "lightslategray",
  "lightslategrey",
  "lightsteelblue",
  "lightyellow",
  "lime",
  "limegreen",
  "linen",
  "magenta",
  "maroon",
  "mediumaquamarine",
  "mediumblue",
  "mediumorchid",
  "mediumpurple",
  "mediumseagreen",
  "mediumslateblue",
  "mediumspringgreen",
  "mediumturquoise",
  "mediumvioletred",
  "midnightblue",
  "mintcream",
  "mistyrose",
  "moccasin",
  "navajowhite",
  "navy",
  "oldlace",
  "olive",
  "olivedrab",
  "orange",
  "orangered",
  "orchid",
  "palegoldenrod",
  "palegreen",
  "paleturquoise",
  "palevioletred",
  "papayawhip",
  "peachpuff",
  "peru",
  "pink",
  "plum",
  "powderblue",
  "purple",
  "rebeccapurple",
  "red",
  "rosybrown",
  "royalblue",
  "saddlebrown",
  "salmon",
  "sandybrown",
  "seagreen",
  "seashell",
  "sienna",
  "silver",
  "skyblue",
  "slateblue",
  "slategray",
  "slategrey",
  "snow",
  "springgreen",
  "steelblue",
  "tan",
  "teal",
  "thistle",
  "tomato",
  "turquoise",
  "violet",
  "wheat",
  "white",
  "whitesmoke",
  "yellow",
  "yellowgreen",
]);
// Forced-colours palette keywords; allowed only inside `@media (forced-colors: active)`.
const SYSTEM_COLOURS = new Set([
  "buttonface",
  "buttontext",
  "canvas",
  "canvastext",
  "graytext",
  "highlight",
  "highlighttext",
  "linktext",
]);
const COLOUR_FUNCTION = /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;
const HEX_COLOUR = /#[0-9a-f]{3,8}(?![\w-])/i;
const MIN_FONT_PX = 12;

/** Replaces comments with spaces, keeping offsets and line numbers. */
function blankComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

/**
 * Walks braces and returns every style block (a rule whose prelude is not an
 * at-rule) with its selector, enclosing at-rule preludes, and its own
 * top-level declarations with 1-based line numbers.
 */
function parseBlocks(source) {
  const css = blankComments(source);
  const lineStarts = [0];
  for (let i = 0; i < css.length; i++) if (css[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (offset) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  const blocks = [];
  const stack = [];
  let segmentStart = 0;
  let parens = 0;
  let quote = "";
  const takeDeclaration = (end) => {
    const frame = stack.at(-1);
    const text = css.slice(segmentStart, end);
    segmentStart = end + 1;
    if (!frame || frame.isAtRule) return;
    const colon = text.indexOf(":");
    if (colon < 0 || text.trim() === "") return;
    const lead = text.length - text.trimStart().length;
    frame.declarations.push({
      prop: text.slice(0, colon).trim().toLowerCase(),
      value: text.slice(colon + 1).trim(),
      line: lineOf(segmentStart - 1 - text.length + lead),
    });
  };

  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") parens++;
    else if (ch === ")") parens = Math.max(0, parens - 1);
    else if (parens > 0) continue;
    else if (ch === "{") {
      const raw = css.slice(segmentStart, i);
      const prelude = raw.trim().replace(/\s+/g, " ");
      const lead = raw.length - raw.trimStart().length;
      stack.push({
        prelude,
        isAtRule: prelude.startsWith("@"),
        line: lineOf(segmentStart + lead),
        declarations: [],
      });
      segmentStart = i + 1;
    } else if (ch === ";") takeDeclaration(i);
    else if (ch === "}") {
      takeDeclaration(i);
      const frame = stack.pop();
      if (frame && !frame.isAtRule) {
        blocks.push({
          selector: frame.prelude,
          context: stack.filter((f) => !f.isAtRule).map((f) => f.prelude),
          atRules: stack.filter((f) => f.isAtRule).map((f) => f.prelude),
          line: frame.line,
          declarations: frame.declarations,
        });
      }
    }
  }
  return blocks;
}

const isRootOnly = (selector) =>
  selector.split(",").every((part) => /^:root(?:\[[^\]]*\])*$/.test(part.trim()));
const isPropertyRule = (block) => block.atRules.some((at) => /^@property\b/i.test(at));
const isForcedColours = (block) =>
  block.atRules.some((at) => /forced-colors\s*:\s*active/i.test(at));
const NOTES_CLASS = /\.(?:notes|roadmap)-[\w-]/;
// Sheets owned by Notes are scanned whole; other sheets only for Notes rules.
const FULL_SCOPE_SHEETS = new Set(["NotesRoadmap.css"]);

/** Custom properties declared in root-only blocks (any theme or media). */
function rootTokensOf(blocks) {
  const tokens = new Map();
  for (const block of blocks) {
    if (!isRootOnly(block.selector)) continue;
    for (const { prop, value } of block.declarations) {
      if (prop.startsWith("--") && !tokens.has(prop)) tokens.set(prop, value);
    }
  }
  return tokens;
}

/** Smallest px a token renders at: `Npx`, or the floor of `clamp(Npx, …)`. */
function minPx(value) {
  const plain = value.match(/^(\d+(?:\.\d+)?)px$/);
  if (plain) return Number(plain[1]);
  const clamp = value.match(/^clamp\(\s*(\d+(?:\.\d+)?)px\s*,/);
  return clamp ? Number(clamp[1]) : undefined;
}

/** Token names with a px size, sorted by size then name. */
function pxScale(tokens, prefix, min = 0) {
  return [...tokens]
    .filter(([name]) => name.startsWith(prefix))
    .map(([name, value]) => ({ name, px: minPx(value) }))
    .filter((step) => step.px !== undefined && step.px >= min)
    .sort((a, b) => a.px - b.px || a.name.localeCompare(b.name));
}

function nearest(scale, px) {
  let best;
  for (const step of scale) {
    if (!best || Math.abs(step.px - px) < Math.abs(best.px - px)) best = step;
  }
  return best ? `var(${best.name}) (${best.px}px)` : "a token";
}

/** Splits on a separator outside parentheses. */
function splitTop(value, separator) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth === 0 && separator.test(ch)) {
      if (current.trim()) parts.push(current.trim());
      current = "";
    } else current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

const stripImportant = (value) => value.replace(/\s*!important\s*$/i, "").trim();

function colourProblem(value, forcedColours) {
  if (HEX_COLOUR.test(value)) return "raw hex colour; use a colour token via var()";
  if (COLOUR_FUNCTION.test(value)) return "raw colour function; use a colour token via var()";
  const words = value
    .replace(/(["'])(?:\\.|(?!\1).)*\1/g, " ")
    .replace(/url\([^)]*\)/gi, " ")
    .replace(/--[\w-]+/g, " ")
    .match(/(?<![\w-])[a-z][a-z0-9-]*(?![\w-])/gi);
  for (const word of words ?? []) {
    const lower = word.toLowerCase();
    if (NAMED_COLOURS.has(lower)) return `named colour "${word}"; use a colour token via var()`;
    if (SYSTEM_COLOURS.has(lower) && !forcedColours) {
      return `system colour "${word}" outside @media (forced-colors: active)`;
    }
  }
  return undefined;
}

function fontSizeProblem(value, tokens) {
  const v = stripImportant(value);
  if (v === "inherit") return undefined;
  const scale = pxScale(tokens, "--fs-", MIN_FONT_PX);
  const token = v.match(/^var\((--fs-[\w-]+)\)$/)?.[1];
  if (token) {
    const px = tokens.has(token) ? minPx(tokens.get(token)) : undefined;
    if (px === undefined) return `unknown font-size token ${token}`;
    if (px < MIN_FONT_PX)
      return `${token} is ${px}px, below ${MIN_FONT_PX}px; use ${nearest(scale, px)}`;
    return undefined;
  }
  const px = minPx(v);
  const hint =
    px === undefined ? `a --fs-* token of at least ${MIN_FONT_PX}px` : nearest(scale, px);
  return `font-size not from a token; use ${hint}`;
}

function radiusProblem(value, tokens) {
  const scale = pxScale(tokens, "--radius-");
  for (const word of splitTop(stripImportant(value), /[\s/]/)) {
    if (word === "0" || word === "50%") continue;
    const token = word.match(/^var\((--radius-[\w-]+)\)$/)?.[1];
    if (token && tokens.has(token)) continue;
    if (token) return `unknown radius token ${token}`;
    const px = minPx(word);
    return `radius "${word}" not from a token; use ${px === undefined ? "a --radius-* token" : nearest(scale, px)}`;
  }
  return undefined;
}

const RING = /^(?:inset\s+)?0\s+0\s+0\s+\d+(?:\.\d+)?px\s+var\(--[\w-]+\)$/;

function shadowProblem(value, tokens) {
  const v = stripImportant(value);
  if (v === "none") return undefined;
  for (const layer of splitTop(v, /,/)) {
    const token = layer.match(/^var\((--[\w-]*shadow[\w-]*)\)$/)?.[1];
    if (token && tokens.has(token)) continue;
    if (token) return `unknown shadow token ${token}`;
    if (RING.test(layer)) continue;
    return `shadow "${layer}" not from a token; use var(--shadow-sm|md|lg|raised) or an "[inset] 0 0 0 <n>px var(--…)" ring`;
  }
  return undefined;
}

/** Every rule finding for one sheet's in-scope blocks. */
function findingsFor(file, blocks, tokens) {
  const findings = [];
  for (const block of blocks) {
    for (const { prop, value, line } of block.declarations) {
      const problems = [colourProblem(value, isForcedColours(block))];
      if (prop === "font-size") problems.push(fontSizeProblem(value, tokens));
      if (prop === "font" && stripImportant(value) !== "inherit") {
        problems.push("font shorthand may only be inherit; set font-size from a --fs-* token");
      }
      if (/^border(?:-[a-z]+)*-radius$/.test(prop)) problems.push(radiusProblem(value, tokens));
      if (prop === "box-shadow") problems.push(shadowProblem(value, tokens));
      for (const message of problems) {
        if (message) findings.push({ file, line, selector: block.selector, prop, value, message });
      }
    }
  }
  return findings;
}

/** Style blocks a sheet contributes to the Notes scope. */
function notesBlocks(file, blocks) {
  return blocks.filter((block) => {
    if (isRootOnly(block.selector) || isPropertyRule(block)) return false;
    if (FULL_SCOPE_SHEETS.has(file)) return true;
    return [...block.context, block.selector].some((s) => NOTES_CLASS.test(s));
  });
}

const matches = (entry, finding) =>
  entry.file === finding.file &&
  entry.selector === finding.selector &&
  entry.prop === finding.prop &&
  entry.value === finding.value;

/**
 * Each entry consumes one declaration: the first unconsumed matching finding
 * plus that declaration's other rule findings (same line, distinct message).
 * Entries that consume nothing are stale; unconsumed findings stay open.
 */
function applyAllowlist(entries, findings) {
  const consumed = new Set();
  const stale = [];
  for (const entry of entries) {
    const first = findings.findIndex((f, i) => !consumed.has(i) && matches(entry, f));
    if (first === -1) {
      stale.push(entry);
      continue;
    }
    const { line } = findings[first];
    const messages = new Set();
    findings.forEach((f, i) => {
      if (i < first || consumed.has(i) || f.line !== line || !matches(entry, f)) return;
      if (messages.has(f.message)) return;
      messages.add(f.message);
      consumed.add(i);
    });
  }
  return { open: findings.filter((_, i) => !consumed.has(i)), stale };
}

const format = (f) => `${f.file}:${f.line} ${f.selector} { ${f.prop}: ${f.value} } → ${f.message}`;

const readSheet = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
const appBlocks = parseBlocks(readSheet("App.css"));
const tokens = rootTokensOf(appBlocks);
const SHEETS = [
  { file: "App.css", blocks: appBlocks },
  { file: "NotesRoadmap.css", blocks: parseBlocks(readSheet("NotesRoadmap.css")) },
  // Loaded after App.css (AgentPane.tsx), so its Notes rules win and are checked too.
  { file: "Deck.css", blocks: parseBlocks(readSheet("Deck.css")) },
];
const scoped = SHEETS.map(({ file, blocks }) => ({ file, blocks: notesBlocks(file, blocks) }));
const findings = scoped.flatMap(({ file, blocks }) => findingsFor(file, blocks, tokens));
const allowed = applyAllowlist(ALLOWLIST, findings);

describe("notes style drift checker", () => {
  const check = (css, file = "NotesRoadmap.css") =>
    findingsFor(file, notesBlocks(file, parseBlocks(css)), tokens).map((f) => f.message);

  it("rejects raw colours and allows tokens, color-mix and keywords", () => {
    expect(check(".a { color: rgba(0, 0, 0, 0.5); }")).toHaveLength(1);
    expect(check(".a { background: #fff; }")).toHaveLength(1);
    expect(check(".a { border-color: white; }")).toHaveLength(1);
    expect(check(".a { --x: oklch(0.5 0.1 200); }")).toHaveLength(1);
    expect(check(".a { color: color-mix(in srgb, red 10%, transparent); }")).toHaveLength(1);
    expect(check(".a { background: color-mix(in srgb, var(--x) 10%, transparent); }")).toEqual([]);
    expect(check(".a { color: currentColor; border-color: var(--border-red); }")).toEqual([]);
    expect(check(".a { white-space: nowrap; animation: roadmap-reminder-in 1s; }")).toEqual([]);
  });

  it("allows system colours only in forced-colours media", () => {
    expect(check("@media (forced-colors: active) { .a { color: CanvasText; } }")).toEqual([]);
    expect(check(".a { color: CanvasText; }")).toHaveLength(1);
    expect(check("@media (max-width: 1px) { .a { background: Highlight; } }")).toHaveLength(1);
  });

  it("requires font sizes from tokens of at least 12px and suggests the nearest", () => {
    expect(check(".a { font-size: 10px; }")).toEqual([
      "font-size not from a token; use var(--fs-sm) (12px)",
    ]);
    expect(check(".a { font-size: var(--fs-xs); }")[0]).toMatch(/below 12px; use var\(--fs-sm\)/);
    expect(check(".a { font-size: var(--fs-nope); }")).toHaveLength(1);
    expect(check(".a { font-size: 1.2em; }")).toHaveLength(1);
    expect(check(".a { font: 12px sans-serif; }")).toHaveLength(1);
    expect(check(".a { font-size: var(--fs-read); font: inherit; }")).toEqual([]);
    expect(check(".a { font-size: var(--fs-sm) !important; } .b { font-size: inherit; }")).toEqual(
      [],
    );
  });

  it("requires radii from tokens, 0 or 50% and suggests the nearest", () => {
    expect(check(".a { border-radius: 3px; }")).toEqual([
      'radius "3px" not from a token; use var(--radius-sm) (4px)',
    ]);
    expect(check(".a { border-top-left-radius: 7px; }")).toHaveLength(1);
    expect(check(".a { border-radius: 0 var(--radius-button) var(--radius-button) 0; }")).toEqual(
      [],
    );
    expect(check(".a { border-radius: 50%; } .b { border-radius: var(--radius-pill); }")).toEqual(
      [],
    );
  });

  it("requires shadows from tokens or edge rings", () => {
    expect(check(".a { box-shadow: 0 4px 8px -2px var(--x); }")).toHaveLength(1);
    expect(check(".a { box-shadow: var(--shadow-nope); }")).toHaveLength(1);
    expect(check(".a { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3); }")).toHaveLength(2);
    expect(check(".a { box-shadow: none; } .b { box-shadow: var(--shadow-raised); }")).toEqual([]);
    expect(
      check(".a { box-shadow: inset 0 0 0 1px var(--border-strong), var(--shadow-lg); }"),
    ).toEqual([]);
    expect(check(".a { box-shadow: 0 0 0 3px var(--x); }")).toEqual([]);
    expect(check(".a { box-shadow: 0 0 4px 3px var(--x); }")).toHaveLength(1);
  });

  it("ignores comments, :root and @property, and keeps line numbers", () => {
    const css =
      ".a {\n  /* color: red; */\n  color: var(--x);\n  border-radius: 2px;\n}\n:root { --y: #000; }\n@property --z { initial-value: red; }";
    const [finding] = findingsFor(
      "NotesRoadmap.css",
      notesBlocks("NotesRoadmap.css", parseBlocks(css)),
      tokens,
    );
    expect(finding).toMatchObject({ line: 4, selector: ".a", prop: "border-radius" });
    expect(check(css)).toHaveLength(1);
  });

  it("scopes App.css to Notes and Roadmap selectors only", () => {
    const css =
      ".notes-input { color: red; }\n.roadmap-draft-trigger-count { font-size: 10px; }\n" +
      ".composer, .notes-x:hover { color: red; }\n.composer { color: red; }\n.notesy { color: red; }";
    const hits = findingsFor("App.css", notesBlocks("App.css", parseBlocks(css)), tokens);
    expect(hits.map((f) => f.selector)).toEqual([
      ".notes-input",
      ".roadmap-draft-trigger-count",
      ".composer, .notes-x:hover",
    ]);
  });

  it("scopes Deck.css to Notes and Roadmap rules, including container queries", () => {
    const css =
      ".chat-head-trail .roadmap-draft-trigger { font-size: 11.5px; }\n" +
      ".title-pins > .btn { font-size: 11.5px; }\n" +
      "@container conversation-pane (max-width: 560px) {\n" +
      "  .roadmap-draft-trigger > span { border-radius: 3px; }\n" +
      "  .chat-head-strip { box-shadow: 0 4px 8px var(--x); }\n" +
      "}";
    const hits = findingsFor("Deck.css", notesBlocks("Deck.css", parseBlocks(css)), tokens);
    expect(hits.map((f) => [f.line, f.selector, f.message])).toEqual([
      [
        1,
        ".chat-head-trail .roadmap-draft-trigger",
        "font-size not from a token; use var(--fs-sm) (12px)",
      ],
      [
        4,
        ".roadmap-draft-trigger > span",
        'radius "3px" not from a token; use var(--radius-sm) (4px)',
      ],
    ]);
  });

  it("lets each allowlist entry consume exactly one declaration", () => {
    const scan = (css) =>
      findingsFor("NotesRoadmap.css", notesBlocks("NotesRoadmap.css", parseBlocks(css)), tokens);
    const entry = {
      file: "NotesRoadmap.css",
      selector: ".a",
      prop: "color",
      value: "red",
      reason: "fixture exception",
    };
    const twice = scan(".a { color: red; }\n.a { color: red; }");
    expect(twice).toHaveLength(2);
    const one = applyAllowlist([entry], twice);
    expect(one.open.map((f) => f.line)).toEqual([2]);
    expect(one.stale).toEqual([]);
    expect(applyAllowlist([entry, entry], twice)).toEqual({ open: [], stale: [] });

    const once = scan(".a { color: red; }");
    expect(applyAllowlist([entry, entry], once)).toEqual({ open: [], stale: [entry] });

    const shadow = { ...entry, prop: "box-shadow", value: "0 1px 2px rgba(0, 0, 0, 0.3)" };
    const both = scan(`.a { box-shadow: ${shadow.value}; }`);
    expect(both).toHaveLength(2);
    expect(applyAllowlist([shadow], both)).toEqual({ open: [], stale: [] });
  });
});

describe("Notes styles", () => {
  it("scan real Notes declarations", () => {
    const count = (file) =>
      scoped.find((s) => s.file === file)?.blocks.reduce((n, b) => n + b.declarations.length, 0) ??
      0;
    expect(count("NotesRoadmap.css")).toBeGreaterThan(1000);
    expect(count("App.css")).toBeGreaterThan(100);
    expect(count("Deck.css")).toBeGreaterThan(0);
    expect(pxScale(tokens, "--fs-", MIN_FONT_PX).length).toBeGreaterThan(3);
    expect(pxScale(tokens, "--radius-").length).toBeGreaterThan(3);
  });

  it("use tokens for colour, font size, radius and shadow", () => {
    expect(allowed.open.map(format)).toEqual([]);
  });

  it("keep a reviewed, sorted allowlist with no stale entries", () => {
    expect(allowed.stale).toEqual([]);
    expect(ALLOWLIST.filter((entry) => entry.reason.trim().length < 10)).toEqual([]);
    const keys = ALLOWLIST.map((e) => `${e.file}\u0000${e.selector}\u0000${e.prop}`);
    expect(keys).toEqual([...keys].sort());
  });
});
