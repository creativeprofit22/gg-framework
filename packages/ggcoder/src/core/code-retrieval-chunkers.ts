/**
 * Line-scanning symbol chunkers for the languages without an AST on hand.
 *
 * TS/JS is chunked from a real TypeScript AST (see `code-retrieval.ts`).
 * Everything else is chunked here by declaration patterns plus brace or
 * indentation tracking. That is deliberately dependency-free: a parser per
 * language would cost five more dependencies and a startup penalty on every
 * search, to sharpen boundaries that BM25 ranking is already tolerant of.
 */
import type { Chunk } from "./code-retrieval.js";

export type BraceLanguage = "go" | "rust" | "java" | "csharp";

interface BraceLanguageRules {
  /** Declaration patterns; capture group 1 is the symbol name when present. */
  declarations: RegExp[];
  /**
   * Blocks that GROUP declarations rather than being one (a C# namespace, a
   * Rust module). Their contents are chunked individually instead of the whole
   * block collapsing into a single chunk.
   */
  containers: RegExp[];
  /** Line-comment marker, stripped before braces are counted. */
  lineComment: string;
}

const BRACE_RULES: Record<BraceLanguage, BraceLanguageRules> = {
  go: {
    declarations: [
      // Methods carry a receiver: `func (w *Widget) Render() {`.
      /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
      /^type\s+([A-Za-z_]\w*)/,
      /^(?:var|const)\s+([A-Za-z_]\w*)/,
    ],
    containers: [],
    lineComment: "//",
  },
  rust: {
    declarations: [
      /^(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/,
      /^(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?(?:struct|enum|trait|union|type|const|static)\s+([A-Za-z_]\w*)/,
      /^macro_rules!\s+([A-Za-z_]\w*)/,
      // `impl<T> Display for Widget<T> {` — named for the type it implements.
      /^(?:unsafe\s+)?impl\b[^{]*/,
    ],
    containers: [/^(?:pub(?:\([^)]*\))?\s+)?mod\s+[A-Za-z_]\w*/],
    lineComment: "//",
  },
  java: {
    declarations: [
      /^(?:(?:public|private|protected|static|final|abstract|sealed|non-sealed|strictfp)\s+)*(?:class|interface|enum|record|@interface)\s+([A-Za-z_]\w*)/,
    ],
    containers: [],
    lineComment: "//",
  },
  csharp: {
    declarations: [
      /^(?:(?:public|private|protected|internal|static|sealed|abstract|partial|readonly|unsafe|file)\s+)*(?:class|interface|struct|enum|record)\s+([A-Za-z_]\w*)/,
    ],
    containers: [/^namespace\s+[A-Za-z_][\w.]*/],
    lineComment: "//",
  },
};

/** Hard span cap, so an unbalanced file cannot produce one whole-file chunk. */
const MAX_CHUNK_LINES = 2000;

/**
 * Chunk a brace-delimited language.
 *
 * Declarations are recognised only at the current top level, where "top level"
 * follows container blocks inward: a type inside a C# namespace is top level, a
 * method inside that type is not — it belongs to its type's chunk, exactly as
 * the TS chunker treats class members.
 */
export function chunkByBraces(rel: string, source: string, language: BraceLanguage): Chunk[] {
  const rules = BRACE_RULES[language];
  const lines = source.split("\n");
  const chunks: Chunk[] = [];
  const containerDepths: number[] = [];
  const state = { inBlockComment: false };
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const code = stripNoise(lines[i], rules.lineComment, state);
    const trimmed = code.trim();

    if (depth === containerDepths.length && trimmed) {
      if (rules.containers.some((re) => re.test(trimmed))) {
        containerDepths.push(depth);
        depth += netBraces(code);
        continue;
      }
      const symbol = matchDeclaration(trimmed, rules.declarations, language);
      if (symbol) {
        const end = findBlockEnd(lines, i, rules.lineComment, { ...state });
        chunks.push({
          file: rel,
          symbol,
          text: lines.slice(i, end + 1).join("\n"),
          startLine: i + 1,
        });
        // Replay the block to keep block-comment state honest. Its braces are
        // balanced by construction, so `depth` is unchanged.
        for (let j = i + 1; j <= end; j++) stripNoise(lines[j], rules.lineComment, state);
        i = end;
        continue;
      }
    }

    depth += netBraces(code);
    while (containerDepths.length > 0 && depth <= containerDepths[containerDepths.length - 1]) {
      containerDepths.pop();
    }
  }
  return chunks;
}

function matchDeclaration(
  trimmed: string,
  declarations: readonly RegExp[],
  language: BraceLanguage,
): string | undefined {
  for (const pattern of declarations) {
    const match = pattern.exec(trimmed);
    if (!match) continue;
    if (match[1]) return match[1];
    // Unnamed pattern — currently only Rust `impl`, named for its target type.
    if (language === "rust") return implTargetName(match[0]);
  }
  return undefined;
}

/** `impl<T> Display for Widget<T>` → `Widget`: the type being implemented. */
function implTargetName(header: string): string {
  const withoutGenerics = header.replace(/<[^<>]*>/g, " ");
  const afterFor = /\bfor\b(.*)$/.exec(withoutGenerics);
  const target = (afterFor ? afterFor[1] : withoutGenerics.replace(/^\s*(?:unsafe\s+)?impl/, ""))
    .replace(/\bwhere\b.*$/, "")
    .trim();
  const identifiers = target.match(/[A-Za-z_]\w*/g);
  return identifiers?.[identifiers.length - 1] ?? "impl";
}

/** Trailing characters that mean the declaration continues on the next line. */
const CONTINUATION = /[,([{=+\-&|:<>?\\]$/;

/**
 * Last line of the declaration starting at `start`.
 *
 * Two phases. The header phase reads until the body's opening brace, tolerating
 * a signature split across lines (unbalanced parens, a trailing comma, a brace
 * parked on its own line). If the header completes with no brace at all, the
 * declaration is a bodiless statement — `const Port = 8080`, `type Alias = ...;`
 * — and ends right there. Getting that wrong is expensive: the chunk would run
 * on and swallow the declarations after it, which then vanish from the index.
 *
 * The body phase then counts braces to the matching close.
 */
function findBlockEnd(
  lines: readonly string[],
  start: number,
  lineComment: string,
  state: { inBlockComment: boolean },
): number {
  let depth = 0;
  let parens = 0;
  let opened = false;
  const limit = Math.min(lines.length, start + MAX_CHUNK_LINES);
  for (let i = start; i < limit; i++) {
    const code = stripNoise(lines[i], lineComment, state);
    const trimmed = code.trim();
    if (!opened) {
      if (code.includes("{")) {
        opened = true;
      } else {
        parens += netOf(code, "(", ")") + netOf(code, "[", "]");
        if (trimmed.endsWith(";")) return i;
        const nextStartsBlock = (lines[i + 1] ?? "").trim().startsWith("{");
        if (parens <= 0 && trimmed && !CONTINUATION.test(trimmed) && !nextStartsBlock) return i;
        continue;
      }
    }
    depth += netBraces(code);
    if (depth <= 0) return i;
  }
  return opened ? limit - 1 : start;
}

function netOf(code: string, open: string, close: string): number {
  let net = 0;
  for (const ch of code) {
    if (ch === open) net++;
    else if (ch === close) net--;
  }
  return net;
}

function netBraces(code: string): number {
  let net = 0;
  for (const ch of code) {
    if (ch === "{") net++;
    else if (ch === "}") net--;
  }
  return net;
}

/**
 * Blank out string literals and comments so their braces are never counted.
 * `state.inBlockComment` carries across lines, and escapes are honoured so a
 * trailing escaped quote does not leave a string open forever.
 */
function stripNoise(line: string, lineComment: string, state: { inBlockComment: boolean }): string {
  let out = "";
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (state.inBlockComment) {
      if (ch === "*" && line[i + 1] === "/") {
        state.inBlockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "/" && line[i + 1] === "*") {
      state.inBlockComment = true;
      i++;
      continue;
    }
    if (lineComment && line.startsWith(lineComment, i)) break;
    out += ch;
  }
  return out;
}

const PYTHON_DECLARATIONS: readonly RegExp[] = [
  /^(?:async\s+)?def\s+([A-Za-z_]\w*)/,
  /^class\s+([A-Za-z_]\w*)/,
  // Module-level constants — the Python analogue of an exported const.
  /^([A-Z_][A-Z0-9_]*)\s*(?::[^=]+)?=/,
];

/**
 * Chunk Python by indentation: a top-level declaration owns every following
 * line indented past column 0, plus any decorators stacked directly above it
 * (a decorator belongs to its declaration, not to a chunk of its own).
 */
export function chunkByIndentation(rel: string, source: string): Chunk[] {
  const lines = source.split("\n");
  const chunks: Chunk[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || /^\s/.test(line)) continue;
    let symbol: string | undefined;
    for (const pattern of PYTHON_DECLARATIONS) {
      const match = pattern.exec(line);
      if (match) {
        symbol = match[1];
        break;
      }
    }
    if (!symbol) continue;

    let start = i;
    while (start > 0 && /^@\w/.test(lines[start - 1])) start--;

    let end = i;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j];
      if (next.trim() === "") continue;
      if (!/^\s/.test(next)) break;
      end = j;
      if (end - start >= MAX_CHUNK_LINES) break;
    }

    chunks.push({
      file: rel,
      symbol,
      text: lines.slice(start, end + 1).join("\n"),
      startLine: start + 1,
    });
    i = end;
  }
  return chunks;
}
