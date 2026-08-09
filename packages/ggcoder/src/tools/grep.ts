import readline from "node:readline";
import path from "node:path";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { sliceHead } from "@kenkaiiii/gg-ai";
import { resolvePath } from "./path-utils.js";
import { BINARY_EXTENSIONS } from "./read.js";
import { localOperations, type ToolOperations } from "./operations.js";

const GrepParams = z.object({
  pattern: z.string().describe("Search pattern (JavaScript regex; leading (?i) is supported)"),
  path: z.string().optional().describe("File or directory to search (defaults to cwd)"),
  include: z.string().optional().describe("Glob pattern to filter files (e.g. '*.ts')"),
  max_results: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Maximum matches to return (default: 50)"),
  case_insensitive: z.boolean().optional().describe("Case-insensitive search"),
});

const DEFAULT_MAX_RESULTS = 50;
const MAX_LINE_LENGTH = 500;
/** Skip files larger than 10 MB — single-line files (minified JS, data blobs) can OOM readline */
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_CANDIDATE_FILES = 10_000;
/** Wall-clock budget for a single grep call — catastrophic backtracking is count-bounded but not time-bounded */
const GREP_DEADLINE_MS = 5_000;
/** Long patterns are almost always mistakes and raise the cost of every pathological shape */
const MAX_PATTERN_LENGTH = 1_000;
/** Check the clock every N lines inside a file scan — cheap enough to be free, dense enough to bound one bad line */
const DEADLINE_CHECK_INTERVAL = 512;

/** Shared wall-clock budget for one grep call. */
interface Deadline {
  readonly expiresAt: number;
  hit: boolean;
}

function createDeadline(budgetMs = GREP_DEADLINE_MS): Deadline {
  return { expiresAt: Date.now() + budgetMs, hit: false };
}

function isExpired(deadline: Deadline): boolean {
  if (deadline.hit) return true;
  if (Date.now() >= deadline.expiresAt) {
    deadline.hit = true;
    return true;
  }
  return false;
}

const QUANTIFIER_CHARS = new Set(["+", "*", "?"]);
/** Quantifiers with no upper bound — only these make an outer group explode. */
const UNBOUNDED_QUANTIFIER_CHARS = new Set(["+", "*"]);
/** `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!`, `(?<name>` — a group modifier, not a quantifier. */
const GROUP_MODIFIER = /^\?(?::|=|!|<=|<!|<[^>]*>)/;

/**
 * Detect a quantified group whose body itself contains a quantifier — `(a+)+`,
 * `(\w+\s?)*`, `(x*){2,}`. These are the classic catastrophic-backtracking shapes:
 * a single long line can pin the event loop for minutes. Deliberately narrow —
 * it rejects the shapes models actually emit by accident, not every slow regex.
 */
function findNestedQuantifier(pattern: string): string | undefined {
  const groupStarts: number[] = [];
  let inClass = false;

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch === "(") {
      groupStarts.push(i);
      continue;
    }
    if (ch !== ")") continue;

    const start = groupStarts.pop();
    if (start === undefined) continue;

    const next = pattern[i + 1];
    // `(...)?` can never backtrack catastrophically — only unbounded outer
    // quantifiers (`+`, `*`, `{n,}`) can.
    const quantified =
      next !== undefined &&
      (UNBOUNDED_QUANTIFIER_CHARS.has(next) ||
        (next === "{" && /^\{\d*,\}/.test(pattern.slice(i + 1))));
    if (!quantified) continue;

    const body = pattern.slice(start + 1, i).replace(GROUP_MODIFIER, "");
    if (containsQuantifier(body)) {
      const end = next === "{" ? i + 1 + pattern.slice(i + 1).indexOf("}") + 1 : i + 2;
      return pattern.slice(start, end);
    }
  }

  return undefined;
}

function containsQuantifier(body: string): boolean {
  let inClass = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (QUANTIFIER_CHARS.has(ch)) return true;
    if (ch === "{" && /^\{\d*,\d*\}/.test(body.slice(i))) return true;
  }
  return false;
}

export function createGrepTool(
  cwd: string,
  ops: ToolOperations = localOperations,
  /** Wall-clock budget for one call. Overridable so tests can trip it without a 5s wait. */
  deadlineMs: number = GREP_DEADLINE_MS,
): AgentTool<typeof GrepParams> {
  return {
    name: "grep",
    description:
      "Search file contents using regex. Returns filepath:line_number:content for matches. " +
      "Respects .gitignore. Skips binary files.",
    parameters: GrepParams,
    async execute({ pattern, path: searchPath, include, max_results, case_insensitive }) {
      const dir = searchPath ? resolvePath(cwd, searchPath) : cwd;
      const maxResults = max_results ?? DEFAULT_MAX_RESULTS;
      // Models commonly emit the RE2/PCRE-style leading `(?i)` flag. JavaScript
      // rejects it as an invalid group, so translate that safe, unambiguous form
      // to the equivalent RegExp flag while preserving the explicit tool option.
      const hasInlineCaseInsensitiveFlag = pattern.startsWith("(?i)");
      const normalizedPattern = hasInlineCaseInsensitiveFlag ? pattern.slice(4) : pattern;
      const flags = case_insensitive || hasInlineCaseInsensitiveFlag ? "gi" : "g";

      if (pattern.length > MAX_PATTERN_LENGTH) {
        throw new Error(
          `Invalid regex pattern: ${pattern.length} characters exceeds the ${MAX_PATTERN_LENGTH}-character limit. ` +
            `Search for a shorter literal substring and filter the results instead.`,
        );
      }

      const nested = findNestedQuantifier(normalizedPattern);
      if (nested) {
        throw new Error(
          `Invalid regex pattern: nested quantifier \`${nested}\` can backtrack catastrophically. ` +
            `Rewrite it as a literal or an anchored pattern (e.g. \`^\\w+$\` instead of \`(\\w+)+$\`).`,
        );
      }

      let regex: RegExp;
      try {
        regex = new RegExp(normalizedPattern, flags);
      } catch (err) {
        throw new Error(`Invalid regex pattern: ${(err as Error).message}`, { cause: err });
      }

      const deadline = createDeadline(deadlineMs);

      // Check if dir is a file
      const stat = await ops.stat(dir);
      if (stat.isFile()) {
        const results = await searchFile(dir, regex, cwd, maxResults, ops, deadline);
        return formatResults(results, maxResults, false, deadline.hit, deadlineMs);
      }

      // Enumerate files
      const fg = await import("fast-glob");
      // Backslashes are picomatch ESCAPES, not separators: a Windows-shaped
      // `include` (e.g. `src\**\*.ts`) would match nothing.
      const globPattern = (include ?? "**/*").replace(/\\/g, "/");
      const entries = await fg.default(globPattern, {
        cwd: dir,
        dot: false,
        onlyFiles: true,
        ignore: ["**/node_modules/**", "**/.git/**"],
        suppressErrors: true,
        followSymbolicLinks: false,
        objectMode: true,
        stats: false,
      });

      const results: string[] = [];
      let scannedCandidates = 0;
      let candidateLimitHit = false;
      for (const item of entries) {
        if (results.length >= maxResults) break;
        if (isExpired(deadline)) break;
        if (scannedCandidates >= MAX_CANDIDATE_FILES) {
          candidateLimitHit = true;
          break;
        }
        scannedCandidates += 1;

        const entry = typeof item === "string" ? item : item.path;
        const ext = path.extname(entry).toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) continue;

        const filePath = path.join(dir, entry);
        const fileResults = await searchFile(
          filePath,
          regex,
          cwd,
          maxResults - results.length,
          ops,
          deadline,
        );
        results.push(...fileResults);
      }

      return formatResults(results, maxResults, candidateLimitHit, deadline.hit, deadlineMs);
    },
  };
}

async function searchFile(
  filePath: string,
  regex: RegExp,
  cwd: string,
  maxResults: number,
  ops: ToolOperations,
  deadline: Deadline,
): Promise<string[]> {
  const results: string[] = [];
  const relPath = path.relative(cwd, filePath);

  // Skip oversized files — readline buffers entire lines in memory, so a single-line
  // file (minified JS, data blobs) can exceed V8's max string length and crash.
  try {
    const fileStat = await ops.stat(filePath);
    if (fileStat.size > MAX_FILE_SIZE) return results;
  } catch {
    return results;
  }

  const stream = ops.createReadStream(filePath, "utf-8");
  try {
    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    let lineNum = 0;
    try {
      for await (const line of rl) {
        lineNum++;
        if (lineNum % DEADLINE_CHECK_INTERVAL === 0 && isExpired(deadline)) break;

        // Bail out if line contains null bytes (binary file not caught by extension check)
        if (lineNum <= 5 && line.includes("\0")) {
          break;
        }

        // Reset lastIndex for global regex
        regex.lastIndex = 0;
        if (regex.test(line)) {
          // Truncate long lines to prevent massive output from binary/minified files
          const truncatedLine =
            line.length > MAX_LINE_LENGTH ? sliceHead(line, MAX_LINE_LENGTH) + "…" : line;
          results.push(`${relPath}:${lineNum}:${truncatedLine}`);
          if (results.length >= maxResults) {
            break;
          }
        }
      }
    } finally {
      rl.close();
    }
  } catch {
    // Skip unreadable files
  } finally {
    stream.destroy();
  }

  return results;
}

function deadlineNotice(deadlineMs: number): string {
  return `[Stopped after ${deadlineMs / 1000}s — narrow the pattern or pass a narrower path/include]`;
}

function formatResults(
  results: string[],
  maxResults: number,
  candidateLimitHit = false,
  deadlineHit = false,
  deadlineMs = GREP_DEADLINE_MS,
): string {
  if (results.length === 0) {
    let empty = "No matches found.";
    if (candidateLimitHit) {
      empty += ` [Stopped after scanning ${MAX_CANDIDATE_FILES} candidate files]`;
    }
    if (deadlineHit) empty += ` ${deadlineNotice(deadlineMs)}`;
    return empty;
  }

  let output = results.join("\n");
  if (results.length >= maxResults) {
    output += `\n\n[Truncated at ${maxResults} matches]`;
  } else {
    output += `\n\n${results.length} match(es) found`;
  }
  if (candidateLimitHit) {
    output += `\n[Stopped after scanning ${MAX_CANDIDATE_FILES} candidate files]`;
  }
  if (deadlineHit) {
    output += `\n${deadlineNotice(deadlineMs)}`;
  }
  return output;
}
