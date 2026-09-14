/**
 * Render the ProjectPicker's session list to a static HTML file using the REAL
 * `App.css`, so the source badge can be verified visually without needing the
 * native window (synthetic clicks into a Tauri webview require macOS
 * Accessibility permission, which CI and agents do not have).
 *
 * Markup here mirrors ProjectPicker.tsx's session rows exactly; the behavior
 * itself is covered by src/ProjectPicker.test.tsx.
 *
 * Usage: node scripts/render-session-list.mjs [outFile]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "..", "src", "App.css"), "utf-8");
// The app's page background lives in index.html, not App.css — read it from
// there so this harness can never drift into rendering the UI on the wrong
// backdrop (which would hide any contrast problem in the badge).
const indexHtml = readFileSync(join(here, "..", "index.html"), "utf-8");
const pageBackground = /html,\s*body\s*\{[^}]*background:\s*([^;]+);/.exec(indexHtml)?.[1]?.trim();
if (!pageBackground) throw new Error("could not read the page background from index.html");

// ProjectPicker applies these as inline styles from theme.ts, so read them from
// the same source rather than restating hex values that could drift.
const themeTs = readFileSync(join(here, "..", "src", "theme.ts"), "utf-8");
const themeColor = (key) => {
  const found = new RegExp(`\\b${key}:\\s*"([^"]+)"`).exec(themeTs)?.[1];
  if (!found) throw new Error(`could not read theme.${key} from theme.ts`);
  return found;
};
const TEXT = themeColor("text");
const TEXT_MUTED = themeColor("textMuted");
const out = resolve(process.argv[2] ?? join(here, "..", "..", ".gg", "screenshots", "session-list.html"));

/** Mirrors the SOURCE_STYLES map in src/Badge.tsx. */
const SOURCE = {
  "claude-code": { label: "Claude Code", color: "#d97757" },
  codex: { label: "Codex", color: "#aeb6c2" },
};

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
      ? `<span class="picker-source-tag" style="color:${meta.color}">${meta.label}</span>`
      : "";
    return `
      <button class="picker-item"${meta ? ` title="From ${meta.label} — opens as a GG Coder session"` : ""}>
        <span class="picker-row">
          <span class="picker-name picker-preview" style="color:${TEXT}">${s.preview}</span>
          <span class="badge">${s.when}</span>
        </span>
        <span class="picker-meta" style="color:${TEXT_MUTED}">${tag}${s.msgs} msgs</span>
      </button>`;
  })
  .join("\n");

writeFileSync(
  out,
  `<!doctype html>
<html><head><meta charset="utf-8"><style>
${css}
html, body { background: ${pageBackground}; }
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
