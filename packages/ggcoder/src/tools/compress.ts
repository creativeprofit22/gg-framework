import { estimateTokens } from "../core/compaction/token-estimator.js";

/**
 * Content-aware tool-output compression.
 *
 * Today's tool path shrinks oversized output with blunt head/tail line cuts
 * (`truncate.ts`). That throws away whichever half the model didn't get — a
 * stack trace buried in the middle of a 10k-line log, the one failing assertion
 * between thousands of passing ones, the shape of a giant JSON array.
 *
 * `compressOutput` keeps the *signal* instead of a positional slice:
 *  - logs: collapse repeated runs, keep every error/warn line + local context,
 *    keep head and tail, drop only the boring middle.
 *  - JSON: keep array shape + a sample, replace the long tail with a count.
 *  - text: middle-out (head + tail) so the command/context AND the result survive.
 *
 * It is lossy by design but information-preserving: the goal is fewer tokens
 * with the same understanding. Pair with an overflow file for full reversibility.
 */

export interface CompressResult {
  content: string;
  /** Which strategy fired — for telemetry / benchmarking. */
  strategy: "json" | "log" | "text" | "none";
  originalTokens: number;
  compressedTokens: number;
}

export interface CompressOptions {
  /** Don't compress below this token count — small output isn't worth touching. */
  minTokens?: number;
  /** Lines of context to keep on each side of an important log line. */
  contextLines?: number;
  /** Head/tail lines always retained. */
  headLines?: number;
  tailLines?: number;
  /** Max elements kept per JSON array before summarising the rest. */
  jsonArraySample?: number;
}

const DEFAULTS = {
  minTokens: 400,
  contextLines: 2,
  headLines: 8,
  tailLines: 8,
  jsonArraySample: 5,
} satisfies Required<CompressOptions>;

/** Lines that must never be dropped from a log. */
const IMPORTANT =
  /\b(error|fatal|panic|exception|traceback|fail(?:ed|ure)?|warn(?:ing)?|assert|fault|denied|refused|timeout|unhandled|rejected|✗|✖|❌)\b|^\s*at\s+|Error:|Caused by:/i;

function tokens(text: string): number {
  return estimateTokens(text);
}

function result(
  content: string,
  strategy: CompressResult["strategy"],
  original: string,
): CompressResult {
  return {
    content,
    strategy,
    originalTokens: tokens(original),
    compressedTokens: tokens(content),
  };
}

/**
 * Compress a tool output string, auto-detecting its content type.
 */
export function compressOutput(raw: string, opts: CompressOptions = {}): CompressResult {
  const o = { ...DEFAULTS, ...opts };
  if (tokens(raw) < o.minTokens) return result(raw, "none", raw);

  const trimmed = raw.trim();
  if (trimmed.length > 1 && (trimmed[0] === "{" || trimmed[0] === "[")) {
    const json = tryCompressJson(trimmed, o);
    if (json !== null) return result(json, "json", raw);
  }

  const lines = raw.split("\n");
  const importantCount = lines.reduce((n, l) => (IMPORTANT.test(l) ? n + 1 : n), 0);
  // Treat as a log when it's many lines OR carries error signal worth isolating.
  if (lines.length > o.headLines + o.tailLines + 10 && (importantCount > 0 || lines.length > 200)) {
    return result(compressLog(lines, o), "log", raw);
  }

  return result(compressText(lines, o), "text", raw);
}

/* ----------------------------------------------------------------------- */
/* Log: keep error lines + context, collapse repeats, drop the boring middle */
/* ----------------------------------------------------------------------- */

function compressLog(lines: string[], o: Required<CompressOptions>): string {
  // 1. Collapse consecutive identical / near-identical runs into one entry.
  //    `exact` tracks whether every line in the run was byte-identical, so the
  //    emitted marker can be honest: "(×N)" only when truly identical, otherwise
  //    "(×N similar)" so the model never assumes the shown text (e.g. a single
  //    timestamp) was repeated verbatim across the whole run.
  const collapsed: { text: string; count: number; idx: number; exact: boolean }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const prev = collapsed[collapsed.length - 1];
    if (prev && normalize(prev.text) === normalize(lines[i])) {
      prev.count++;
      if (lines[i] !== prev.text) prev.exact = false;
    } else {
      collapsed.push({ text: lines[i], count: 1, idx: i, exact: true });
    }
  }

  // 2. Mark which collapsed entries to keep: head, tail, important + context.
  const keep = new Set<number>();
  for (let i = 0; i < Math.min(o.headLines, collapsed.length); i++) keep.add(i);
  for (let i = Math.max(0, collapsed.length - o.tailLines); i < collapsed.length; i++) keep.add(i);
  for (let i = 0; i < collapsed.length; i++) {
    if (IMPORTANT.test(collapsed[i].text)) {
      for (let j = i - o.contextLines; j <= i + o.contextLines; j++) {
        if (j >= 0 && j < collapsed.length) keep.add(j);
      }
    }
  }

  // 3. Emit, replacing dropped gaps with a single omission marker.
  const out: string[] = [];
  let droppedLines = 0;
  let gapStart = -1;
  const flushGap = () => {
    if (droppedLines > 0) {
      out.push(`… ${droppedLines} line${droppedLines === 1 ? "" : "s"} omitted …`);
      droppedLines = 0;
      gapStart = -1;
    }
  };
  for (let i = 0; i < collapsed.length; i++) {
    if (keep.has(i)) {
      flushGap();
      const e = collapsed[i];
      if (e.count > 1) out.push(`${e.text}  (×${e.count}${e.exact ? "" : " similar"})`);
      else out.push(e.text);
    } else {
      if (gapStart === -1) gapStart = i;
      droppedLines += collapsed[i].count;
    }
  }
  flushGap();
  return out.join("\n");
}

/**
 * Strip only *volatile noise* (timestamps, hex addresses) so lines that differ
 * solely by a leading timestamp collapse as repeats. Deliberately does NOT nuke
 * arbitrary integers: when the number IS the content (`line 5998` vs `line 5999`,
 * a port, an id), the lines must stay distinct so the tail isn't flattened into
 * a single "(×N)" and genuinely different output isn't reported as repetition.
 */
function normalize(line: string): string {
  return line
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "<ts>")
    .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, "<ts>")
    .replace(/0x[0-9a-f]+/gi, "<addr>")
    .trim();
}

/* ----------------------------------------------------------------------- */
/* JSON: keep shape + a sample of long arrays, summarise the rest            */
/* ----------------------------------------------------------------------- */

function tryCompressJson(text: string, o: Required<CompressOptions>): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const shrunk = shrinkJson(parsed, o);
  return JSON.stringify(shrunk, null, 2);
}

function shrinkJson(value: unknown, o: Required<CompressOptions>): unknown {
  if (Array.isArray(value)) {
    if (value.length <= o.jsonArraySample) return value.map((v) => shrinkJson(v, o));
    const sample = value.slice(0, o.jsonArraySample).map((v) => shrinkJson(v, o));
    sample.push(`… ${value.length - o.jsonArraySample} more of ${value.length} items omitted …`);
    return sample;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = shrinkJson(v, o);
    return out;
  }
  return value;
}

/* ----------------------------------------------------------------------- */
/* Text: middle-out so both the command/context and the result survive       */
/* ----------------------------------------------------------------------- */

function compressText(lines: string[], o: Required<CompressOptions>): string {
  const budget = o.headLines + o.tailLines;
  if (lines.length <= budget) return lines.join("\n");
  const head = lines.slice(0, o.headLines);
  const tail = lines.slice(lines.length - o.tailLines);
  const dropped = lines.length - budget;
  return [...head, `… ${dropped} lines omitted …`, ...tail].join("\n");
}

/* ----------------------------------------------------------------------- */
/* Tool-output integration seam                                              */
/* ----------------------------------------------------------------------- */

export interface ToolOutputCompression {
  content: string;
  /** Human/agent-facing summary of what was kept, for the truncation notice. */
  notice: string;
  strategy: CompressResult["strategy"];
}

/**
 * Compress output that a tool was ALREADY going to truncate.
 *
 * This is the only sanctioned live integration point. It is invoked solely on
 * the over-limit branch of a tool (bash / task_output) — where today's
 * alternative is a blind tail slice that discards the head and any mid-stream
 * error. It keeps generous head/tail (tool output is tail-oriented) plus every
 * error line and collapses repeats. The caller still writes the full original
 * to an overflow file, so this stays fully reversible.
 */
export function compressToolOutput(raw: string): ToolOutputCompression {
  const r = compressOutput(raw, { headLines: 12, tailLines: 30, minTokens: 0 });
  const saved = r.originalTokens - r.compressedTokens;
  const notice =
    r.strategy === "none"
      ? ""
      : `Compressed (${r.strategy}): kept errors + head/tail, collapsed repeats — ~${saved} fewer tokens.`;
  return { content: r.content, notice, strategy: r.strategy };
}
