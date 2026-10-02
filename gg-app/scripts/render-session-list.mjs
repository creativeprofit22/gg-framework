/**
 * Render the ProjectPicker's session list to a static HTML file using the REAL
 * `App.css` + `appearance.css` (imported in that order by main.tsx), so the
 * source badge can be verified visually in either theme without needing the
 * native window (synthetic clicks into a Tauri webview require macOS
 * Accessibility permission, which CI and agents do not have).
 *
 * Markup here mirrors ProjectPicker.tsx's session rows, including the inline
 * styles Badge.tsx applies to coloured badges; the behavior itself is covered
 * by src/ProjectPicker.test.tsx.
 *
 * Usage: node scripts/render-session-list.mjs [outFile] [--theme dark|light]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = (file) => readFileSync(join(here, "..", "src", file), "utf-8");
const css = `${src("App.css")}\n${src("appearance.css")}`;

const args = process.argv.slice(2);
let theme = "dark";
const positional = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--theme") theme = args[++i] ?? "";
  else if (arg.startsWith("--theme=")) theme = arg.slice("--theme=".length);
  else positional.push(arg);
}
if (theme !== "dark" && theme !== "light") {
  throw new Error(`--theme must be "dark" or "light" (got "${theme}")`);
}
// The app's page background lives in index.html, not App.css — read it from
// there so this harness can never drift into rendering the UI on the wrong
// backdrop (which would hide any contrast problem in the badge).
const indexHtml = readFileSync(join(here, "..", "index.html"), "utf-8");
const pageBackground = /html,\s*body\s*\{[^}]*background:\s*([^;]+);/.exec(indexHtml)?.[1]?.trim();
if (!pageBackground) throw new Error("could not read the page background from index.html");
// index.html's backdrop is the Dark one; Light repaints the page with its --bg token.
const harnessBackground = theme === "light" ? "var(--bg)" : pageBackground;

// ProjectPicker applies these as inline styles from theme.ts, so read them from
// the same source rather than restating hex values that could drift.
const themeTs = src("theme.ts");
const themeColor = (key) => {
  const found = new RegExp(`\\b${key}:\\s*"([^"]+)"`).exec(themeTs)?.[1];
  if (!found) throw new Error(`could not read theme.${key} from theme.ts`);
  return found;
};
const TEXT = themeColor("text");
const TEXT_MUTED = themeColor("textMuted");
const out = resolve(
  positional[0] ?? join(here, "..", "..", ".gg", "screenshots", "session-list.html"),
);

// Read from the SOURCE_STYLES map in src/source-style.ts so the badge colours
// resolve through the same theme tokens the app uses (never restated hex).
const sourceStyleTs = src("source-style.ts");
const sourceStyle = (key) => {
  const entry = new RegExp(`(?:"${key}"|\\b${key}):\\s*\\{([^}]*)\\}`).exec(sourceStyleTs)?.[1];
  const label = entry && /label:\s*"([^"]+)"/.exec(entry)?.[1];
  const color = entry && /color:\s*"([^"]+)"/.exec(entry)?.[1];
  if (!label || !color)
    throw new Error(`could not read SOURCE_STYLES["${key}"] from source-style.ts`);
  return { label, color };
};
const SOURCE = { "claude-code": sourceStyle("claude-code"), codex: sourceStyle("codex") };

/** Same inline style Badge.tsx applies when given a `color`. */
const badgeStyle = (color) =>
  [
    `color:${color}`,
    `background:linear-gradient(180deg, color-mix(in srgb, ${color} 21.9608%, transparent) 0%, color-mix(in srgb, ${color} 9.4118%, transparent) 100%)`,
    `border-color:color-mix(in srgb, ${color} 40%, transparent)`,
    "box-shadow:0 1px 2px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.2)",
  ].join(";");

const sessions = [
  { preview: "Wire the retry into the fetch helper", when: "2m ago", msgs: 12 },
  { preview: "Ship the release flow", when: "1h ago", msgs: 48 },
  {
    preview: "Build a UI dashboard in HTML. Something suitable for 20-25 year olds",
    when: "1w ago",
    msgs: 44,
    source: "claude-code",
  },
  { preview: "login", when: "1w ago", msgs: 3, source: "claude-code" },
  { preview: "Why is the build slow?", when: "2w ago", msgs: 20, source: "codex" },
];

const rows = sessions
  .map((s) => {
    const meta = s.source ? SOURCE[s.source] : null;
    const tag = meta
      ? `<span class="badge picker-source-tag" style="${badgeStyle(meta.color)}">${meta.label}</span>`
      : "";
    return `
      <button class="picker-item"${meta ? ` title="From ${meta.label} — opens as a GG Coder session"` : ""}>
        <span class="picker-row">
          <span class="picker-name picker-preview" style="color:${TEXT}">${s.preview}</span>
          <span class="badge">${s.when}</span>
        </span>
        <span class="picker-meta" style="color:${TEXT_MUTED}">${tag}<span class="badge">${s.msgs} msgs</span></span>
      </button>`;
  })
  .join("\n");

writeFileSync(
  out,
  `<!doctype html>
<html${theme === "light" ? ' data-appearance-theme="light"' : ""}><head><meta charset="utf-8"><style>
${css}
html, body { background: ${harnessBackground}; }
body { margin: 0; padding: 24px; height: auto; overflow: auto; }
.harness { max-width: 640px; margin: 0 auto; }
.harness h2 { font-size: 13px; letter-spacing: .08em; text-transform: uppercase;
  color: var(--text-muted); margin: 0 0 12px; font-family: var(--mono); }
</style></head>
<body class="app">
  <div class="harness">
    <h2>Sessions &middot; ui-test</h2>
    <div class="picker-list">
      <div class="picker-reveal">${rows}</div>
    </div>
  </div>
</body></html>`,
  "utf-8",
);
console.log(out);
