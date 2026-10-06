import path from "node:path";
import type { ToolCall, ToolResult } from "@kenkaiiii/gg-ai";
import { recordRead, type ReadTracker } from "./read-tracker.js";
import type { ToolOperations } from "./operations.js";
import { resolvePath } from "./path-utils.js";

/**
 * Credit `bash` file dumps as reads, so `edit`/`write` after `cat src/a.ts`
 * does not force a second read of the same bytes.
 *
 * Fail-closed by construction: a file counts only when the command is a plain
 * listing of file paths or one-directory globs (`cat`, `cat -n`, or the
 * `for f in …; do cat …; done` idiom), the tool succeeded, and the CURRENT
 * file content appears verbatim in the output the model actually received
 * (after per-turn trimming). Anything the model did not literally see is
 * never recorded.
 */

/** Literal paths, optionally with a `*` in the last segment (`src/*.js`).
 *  No variables, substitutions, redirections, or recursive globs. */
const SAFE_PATH = /^[\w./@+-]*(?:\*[\w.@+-]*)?$/;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_GLOB_MATCHES = 64;

/** Paths a command prints in full, or [] when it is not a pure file dump. */
export function catTargets(command: string): string[] {
  const segments = command
    .split(/;|&&|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const targets: string[] = [];
  const literal = (a: string): boolean => SAFE_PATH.test(a) && a.length > 0 && !a.startsWith("-");
  for (const seg of segments) {
    const cat = /^cat(?:\s+-n)?\s+(.+)$/.exec(seg);
    if (cat?.[1]) {
      const args = cat[1].split(/\s+/);
      if (args.every(literal)) targets.push(...args);
    }
  }
  // `for f in a b; do echo "== $f"; cat -n $f; done` — explicit word list only.
  const forLoop = /\bfor (\w+) in ([^;\n]+?)\s*;\s*do\b([\s\S]*?)\bdone\b/.exec(command);
  if (forLoop?.[1] && forLoop[2] && forLoop[3]) {
    const v = forLoop[1];
    const body = forLoop[3];
    const catsVar = new RegExp(`\\bcat(?:\\s+-n)?\\s+"?\\$\\{?${v}\\}?"?(?=\\s*(?:;|$|\\n))`).test(
      body,
    );
    const words = forLoop[2].trim().split(/\s+/);
    if (catsVar && words.every(literal)) targets.push(...words);
  }
  return [...new Set(targets)];
}

/**
 * Expand one target to concrete files. A `*` is matched within its own
 * directory only (shell semantics, dotfiles excluded); a glob that matches
 * nothing yields nothing.
 */
async function expandTarget(cwd: string, target: string, ops: ToolOperations): Promise<string[]> {
  if (!target.includes("*")) return [resolvePath(cwd, target)];
  const slash = target.lastIndexOf("/");
  const dir = resolvePath(cwd, slash >= 0 ? target.slice(0, slash) || "/" : ".");
  const pattern = target.slice(slash + 1);
  const [head = "", tail = ""] = pattern.split("*");
  const entries = await ops.readdir(dir, { withFileTypes: true });
  return entries
    .filter(
      (e) =>
        e.isFile() &&
        !e.name.startsWith(".") &&
        e.name.length >= head.length + tail.length &&
        e.name.startsWith(head) &&
        e.name.endsWith(tail),
    )
    .map((e) => path.join(dir, e.name))
    .sort()
    .slice(0, MAX_GLOB_MATCHES);
}

/** `cat -n` prefixes each line with a right-aligned number and a tab. */
function numbered(content: string): string {
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines.map((line, i) => `${String(i + 1).padStart(6)}\t${line}`).join("\n");
}

function resultText(result: ToolResult): string {
  if (typeof result.content === "string") return result.content;
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/**
 * Record reads proven by one step's bash calls. Call with the tool results
 * exactly as appended to the transcript (post-trim).
 */
export async function recordBashReads(
  tracker: ReadTracker,
  cwd: string,
  ops: ToolOperations,
  toolCalls: readonly ToolCall[],
  toolResults: readonly ToolResult[],
): Promise<string[]> {
  const recorded: string[] = [];
  const byId = new Map(toolResults.map((r) => [r.toolCallId, r]));
  for (const call of toolCalls) {
    if (call.name !== "bash") continue;
    const result = byId.get(call.id);
    const command = call.args["command"];
    if (!result || result.isError || typeof command !== "string") continue;
    const targets = catTargets(command);
    if (targets.length === 0) continue;
    const output = resultText(result);
    const files: string[] = [];
    for (const target of targets) {
      try {
        files.push(...(await expandTarget(cwd, target, ops)));
      } catch {
        // Unresolvable path or unreadable directory: nothing was proven.
      }
    }
    // Always re-record: an older full read may be stale (the file changed since),
    // and this output is what the model saw most recently.
    for (const resolved of new Set(files)) {
      try {
        const stat = await ops.stat(resolved);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
        const content = await ops.readFile(resolved);
        const body = content.endsWith("\n") ? content.slice(0, -1) : content;
        if (body.length === 0) continue;
        if (!output.includes(body) && !output.includes(numbered(content))) continue;
        recordRead(tracker, resolved, content, stat.mtimeMs);
        recorded.push(resolved);
      } catch {
        // Missing or unreadable: nothing was proven.
      }
    }
  }
  return recorded;
}
