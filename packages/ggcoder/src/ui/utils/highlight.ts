import path from "node:path";

/** Map file extension to cli-highlight language name */
const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  sh: "bash",
  zsh: "bash",
  bash: "bash",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  html: "xml",
  xml: "xml",
  css: "css",
  scss: "scss",
  sql: "sql",
  toml: "ini",
  dockerfile: "dockerfile",
};

/** Get language from a file path's extension */
export function langFromPath(filePath: string): string | undefined {
  const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
  return EXT_TO_LANG[ext];
}

interface HighlightModule {
  highlight(code: string, options: { language: string; ignoreIllegals?: boolean }): string;
  supportsLanguage(lang: string): boolean;
}

// Lazy-load cli-highlight so it doesn't block initial render.
// First call returns plain text; subsequent calls use the loaded highlighter.
let hlModule: HighlightModule | undefined;
let loadAttempted = false;

function ensureLoaded(): HighlightModule | undefined {
  if (hlModule) return hlModule;
  if (loadAttempted) return undefined;
  loadAttempted = true;
  // Kick off async load for next call
  import("cli-highlight").then(
    (m) => {
      // Bundler interop: when tsup bundles cli-highlight as CJS into a chunk
      // (gg-boss does this), dynamic ESM `import()` returns
      // `{ default: { supportsLanguage, highlight, ... } }` with no named
      // exports at the top level. Native Node ESM loader DOES mirror named
      // exports up, so probing for the actual method works in both modes.
      const candidate = m as unknown as HighlightModule & { default?: HighlightModule };
      if (typeof candidate.supportsLanguage === "function") {
        hlModule = candidate;
      } else if (candidate.default && typeof candidate.default.supportsLanguage === "function") {
        hlModule = candidate.default;
      }
      // else: shape we don't recognise — stay undefined, fall back to plain text.
    },
    () => {
      // Failed to load — will fall back to plain text permanently
    },
  );
  return undefined;
}

/**
 * Syntax-highlight code. Returns ANSI string.
 * Falls back to raw code if the highlighter hasn't loaded yet or language is unknown.
 */
export function highlightCode(code: string, language?: string): string {
  if (!language) return code;
  const hl = ensureLoaded();
  if (!hl || !hl.supportsLanguage(language)) return code;
  try {
    return hl.highlight(code, { language, ignoreIllegals: true });
  } catch {
    return code;
  }
}
