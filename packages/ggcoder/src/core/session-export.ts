import type { Message, ToolResultContent } from "@kenkaiiii/gg-ai";
import {
  getHistoryMessageVisibility,
  restoreUserRow,
  restoreAssistantTexts,
} from "./session-history.js";

/**
 * Markdown transcript export.
 *
 * Renders a session's persisted messages into a single self-contained `.md`
 * file a human can read, paste into a PR, or hand to a teammate. Deliberately
 * NOT built on the webview's `Item[]`: the app keeps tool activity in the
 * pinned LiveToolPanel and never in the transcript, so serializing from there
 * would export a chat with the actual work missing.
 *
 * Bubble text goes through the SAME `restoreUserRow` / `restoreAssistantTexts`
 * helpers the `/history` resume path uses, so what lands in the file matches
 * what the user saw on screen (steering wrappers, attachment notes and
 * autopilot preambles stripped) rather than the raw provider payload.
 */

/** Hard cap on a single tool result's rendered text. Sessions already cap
 *  persisted tool text at 40k chars; an export is for reading, so it gets a
 *  much tighter budget — enough to see what happened, not a data dump. */
export const MAX_TOOL_RESULT_CHARS = 1500;
/** Hard cap on a single tool call's rendered arguments. */
export const MAX_TOOL_ARGS_CHARS = 800;

export interface SessionExportMeta {
  /** Workspace mode this session ran in — picks the filename + title wording. */
  mode: "chat" | "code";
  cwd: string;
  provider: string;
  model: string;
  /** Session id (a short prefix is shown in the header). */
  sessionId?: string;
  /** Export timestamp. Defaults to now. */
  date?: Date;
}

/**
 * How much of the agent's tool work to render.
 *
 * - `summary` (default) — one dim line per burst of tool calls, naming what ran
 *   (`read src/a.ts`, `bash pnpm build`). Keeps the narrative of what the agent
 *   did without the payloads. A real 1,346-message session is 708KB at `full`
 *   and 71KB here — the same story, minus the 90% no human was going to read.
 * - `none` — pure conversation, nothing but the two voices.
 * - `full` — collapsed `<details>` with arguments and (truncated) results. For
 *   debugging and bug reports, not for sharing.
 */
export type ToolDetail = "none" | "summary" | "full";

export interface SessionExportOptions {
  /** How much tool work to render. Default `summary`. */
  toolDetail?: ToolDetail;
  /** Render the model's reasoning blocks. Default false — thinking is scratch
   *  work, and a shared transcript is better without it. */
  includeThinking?: boolean;
}

/** Distinct entries named in one summary line before it says “+N more”. Sized
 *  for a coalesced burst (a whole run of tool work between two paragraphs), not
 *  a single message — too low and every line degenerates into “+37 more”. */
const MAX_SUMMARY_TOOLS = 8;

// ── Filename ───────────────────────────────────────────────

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** `2026-07-26-1402` — local time, sortable, and unique enough that two
 *  exports in the same day don't silently collide in the save dialog. */
export function exportTimestamp(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

/**
 * Default filename offered in the native save dialog, e.g.
 * `your-chat-2026-07-26-1402.md`. Coding sessions say `session` instead of
 * `chat` so a folder of exports stays self-describing.
 */
export function defaultExportFilename(mode: "chat" | "code", date = new Date()): string {
  const kind = mode === "chat" ? "chat" : "session";
  return `your-${kind}-${exportTimestamp(date)}.md`;
}

// ── Rendering helpers ──────────────────────────────────────

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const omitted = text.length - max;
  return `${text.slice(0, max)}\n… ${omitted.toLocaleString()} more characters truncated`;
}

/** Fence a block with enough backticks that any fences inside it survive. */
function fence(body: string, lang = ""): string {
  let ticks = 3;
  for (const run of body.match(/`{3,}/g) ?? []) ticks = Math.max(ticks, run.length + 1);
  const bar = "`".repeat(ticks);
  return `${bar}${lang}\n${body}\n${bar}`;
}

/** Flatten a tool result's content (string or block array) to display text.
 *  Image/video blocks become a one-line placeholder — inlining base64 would
 *  turn a screenshot-heavy session into an unopenable multi-megabyte file. */
function toolResultText(content: ToolResultContent): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "image") parts.push(`[image: ${block.mediaType}]`);
    else if (block.type === "video") parts.push(`[video: ${block.mediaType}]`);
  }
  return parts.join("\n");
}

/** Longest argument value the `<summary>` row shows before clipping. */
const SUMMARY_ARG_CHARS = 90;

/** Argument keys the summary row will show, most identifying first. */
const SUMMARY_ARG_KEYS = [
  "file_path",
  "path",
  "command",
  "pattern",
  "query",
  "url",
  "task",
] as const;

/** The argument key `toolSummary` picked for this call, if any. */
function summaryKey(args: Record<string, unknown>): string | undefined {
  return SUMMARY_ARG_KEYS.find((key) => {
    const v = args[key];
    return typeof v === "string" && v.trim().length > 0;
  });
}

/** One-line summary of a tool call for the `<details>` summary row: the tool
 *  name plus its most identifying argument (path, command, pattern, …). */
export function toolSummary(name: string, args: Record<string, unknown>): string {
  const key = summaryKey(args);
  const primary = key ? String(args[key]) : "";
  const oneLine = primary.replace(/\s+/g, " ").trim();
  const clipped =
    oneLine.length > SUMMARY_ARG_CHARS ? `${oneLine.slice(0, SUMMARY_ARG_CHARS - 1)}…` : oneLine;
  return clipped ? `${name} · ${clipped}` : name;
}

/**
 * Render a tool call's arguments, or null when there's nothing worth showing.
 *
 * A lone string argument (the overwhelmingly common shape — `bash`'s command, a
 * `web_fetch` url) is rendered raw in a fence: `JSON.stringify` would turn a
 * shell one-liner into unreadable `\"` / `\n` soup. It's dropped entirely when
 * the summary row already showed that exact value in full, so short calls don't
 * say the same thing twice. Everything else falls back to pretty JSON.
 */
export function renderToolArgs(args: Record<string, unknown>): string | null {
  const entries = Object.entries(args);
  const only = entries.length === 1 ? entries[0] : undefined;
  if (only && typeof only[1] === "string") {
    const [key, raw] = only as [string, string];
    const value = raw.trim();
    if (!value) return null;
    // Redundant only when the summary actually rendered THIS key and didn't
    // clip it — an unlisted key (e.g. subagent's `agent`) never reached the
    // summary, so its value still has to be shown here.
    const shownWhole =
      key === summaryKey(args) && value.replace(/\s+/g, " ").length <= SUMMARY_ARG_CHARS;
    if (shownWhole) return null;
    return fence(truncate(value, MAX_TOOL_ARGS_CHARS), key === "command" ? "sh" : "");
  }
  const json = JSON.stringify(args, null, 2);
  if (!json || json === "{}") return null;
  return fence(truncate(json, MAX_TOOL_ARGS_CHARS), "json");
}

/** Longest argument value a summary line shows per tool — tighter than the
 *  `<details>` row, since several of these share one line. */
const SUMMARY_LINE_ARG_CHARS = 44;

/**
 * One dim line standing in for a burst of tool calls, e.g.
 * `_🔧 read src/a.ts · bash pnpm build · edit App.tsx · +4 more_`.
 *
 * Entries are deduped so an agent that reads the same file three times says it
 * once, and capped so a 40-tool burst doesn't become a wall. Failures are still
 * called out — a reader skimming for what went wrong shouldn't have to re-export
 * at `full` to discover that something did.
 */
export function renderToolSummaryLine(
  calls: readonly { name: string; args: Record<string, unknown>; failed: boolean }[],
): string | null {
  if (calls.length === 0) return null;
  const seen: string[] = [];
  for (const call of calls) {
    const key = summaryKey(call.args);
    const arg = key ? String(call.args[key]).replace(/\s+/g, " ").trim() : "";
    const clipped =
      arg.length > SUMMARY_LINE_ARG_CHARS ? `${arg.slice(0, SUMMARY_LINE_ARG_CHARS - 1)}…` : arg;
    const label = clipped ? `${call.name} ${clipped}` : call.name;
    if (!seen.includes(label)) seen.push(label);
  }
  const shown = seen.slice(0, MAX_SUMMARY_TOOLS);
  const hidden = seen.length - shown.length;
  const parts = [...shown];
  if (hidden > 0) parts.push(`+${hidden} more`);
  const failures = calls.filter((c) => c.failed).length;
  const suffix = failures > 0 ? ` — ${failures} failed` : "";
  return `_🔧 ${parts.join(" · ")}${suffix}_`;
}

function renderToolBlock(
  name: string,
  args: Record<string, unknown>,
  result: { text: string; isError: boolean } | undefined,
): string {
  const lines: string[] = [];
  const flag = result?.isError ? " — failed" : "";
  lines.push(`<details>`);
  lines.push(`<summary>🔧 ${escapeHtml(toolSummary(name, args))}${flag}</summary>`);
  lines.push("");
  const renderedArgs = renderToolArgs(args);
  if (renderedArgs) lines.push(renderedArgs);
  if (result && result.text.trim()) {
    lines.push("");
    lines.push(fence(truncate(result.text.trim(), MAX_TOOL_RESULT_CHARS)));
  }
  lines.push("");
  lines.push(`</details>`);
  return lines.join("\n");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Main serializer ────────────────────────────────────────

/**
 * Render a session's messages as Markdown.
 *
 * System messages are always dropped (the system prompt is ours, not the
 * user's, and shipping it in a shared file leaks internals). Compaction
 * summaries and self-correction hook prompts are machine-facing injections —
 * they render as a quiet italic marker instead of a user bubble, exactly like
 * the app shows them.
 */
export function sessionToMarkdown(
  meta: SessionExportMeta,
  messages: readonly Message[],
  options: SessionExportOptions = {},
): string {
  const { toolDetail = "summary", includeThinking = false } = options;
  const date = meta.date ?? new Date();

  // Pair tool calls with their results up front — the result lives in a later
  // `tool` message, but it belongs with the call that produced it (inside its
  // `<details>` block at `full`, or as the failure count at `summary`).
  const resultsByCallId = new Map<string, { text: string; isError: boolean }>();
  for (const msg of messages) {
    if (msg.role !== "tool") continue;
    for (const tr of msg.content) {
      resultsByCallId.set(tr.toolCallId, {
        text: toolResultText(tr.content),
        isError: tr.isError ?? false,
      });
    }
  }

  const out: string[] = [];
  const title = meta.mode === "chat" ? "Chat transcript" : "Coding session";
  out.push(`# ${title}`);
  out.push("");
  const metaLines = [
    `- **Date:** ${date.toLocaleString()}`,
    `- **Model:** ${meta.model} (${meta.provider})`,
    `- **Project:** \`${meta.cwd}\``,
  ];
  if (meta.sessionId) metaLines.push(`- **Session:** \`${meta.sessionId.slice(0, 8)}\``);
  out.push(metaLines.join("\n"));
  out.push("");
  out.push("---");

  // Anything the reader would consider content: a bubble, a reply, or a tool
  // call. Only a truly empty session gets the placeholder line.
  let rows = 0;

  // At `summary`, tool calls accumulate across consecutive assistant messages
  // and flush as ONE line when the narrative resumes (prose, a user turn, or
  // the end). A tool-using agent emits one assistant message per call, so
  // per-message lines would stack twenty identical-looking markers between two
  // paragraphs — which is the very noise this mode exists to remove. Coalesced,
  // that run reads as a single “then it went and did these things” beat.
  let pending: { name: string; args: Record<string, unknown>; failed: boolean }[] = [];
  const flushPending = (): void => {
    if (pending.length === 0) return;
    const line = renderToolSummaryLine(pending);
    pending = [];
    if (!line) return;
    rows++;
    out.push("");
    out.push(line);
  };

  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "tool") continue;
    const visibility = getHistoryMessageVisibility(msg);
    if (visibility === "hidden") continue;

    if (msg.role === "user") {
      const restored = restoreUserRow(msg.content, msg.provenance);
      const text = restored.text.trim();
      const isHook = !msg.provenance && HOOK_PREFIXES.some((p) => text.startsWith(p));
      const isCompaction =
        visibility === "summary" ||
        (!msg.provenance && text.startsWith("[Previous conversation summary]"));
      flushPending();
      // Legacy generated rows rely on framing; tagged rows trust provenance.
      if (!msg.provenance && (restored.notification || restored.autopilotInjected)) continue;
      if (isHook) {
        out.push("");
        out.push(`> _(agent self-correction check)_`);
        continue;
      }
      if (isCompaction) {
        rows++;
        out.push("");
        out.push(`> _(conversation compacted here)_`);
        continue;
      }
      if (!text && restored.images.length === 0) continue;
      rows++;
      out.push("");
      out.push("## 🧑‍💻 You");
      out.push("");
      if (text) out.push(text);
      if (restored.images.length > 0) {
        out.push("");
        out.push(
          `_${restored.images.length} image${restored.images.length === 1 ? "" : "s"} attached_`,
        );
      }
      continue;
    }

    // Assistant: reasoning (optional), then one section per text block, then
    // any tool calls it made.
    if (includeThinking && typeof msg.content !== "string") {
      const thinking = msg.content
        .filter((c) => c.type === "thinking")
        .map((c) => (c.type === "thinking" ? c.text : ""))
        .join("\n")
        .trim();
      if (thinking) {
        flushPending();
        out.push("");
        out.push("<details>");
        out.push("<summary>💭 Thinking</summary>");
        out.push("");
        out.push(thinking);
        out.push("");
        out.push("</details>");
      }
    }

    for (const blockText of restoreAssistantTexts(msg.content)) {
      if (!blockText.trim()) continue;
      flushPending();
      rows++;
      out.push("");
      out.push("## ✨ GG Coder");
      out.push("");
      out.push(blockText.trim());
    }

    if (toolDetail !== "none" && typeof msg.content !== "string") {
      const calls = msg.content.flatMap((block) =>
        block.type === "tool_call"
          ? [{ id: block.id, name: block.name, args: block.args ?? {} }]
          : [],
      );
      if (toolDetail === "full") {
        for (const call of calls) {
          rows++;
          out.push("");
          out.push(renderToolBlock(call.name, call.args, resultsByCallId.get(call.id)));
        }
      } else {
        for (const call of calls) {
          pending.push({
            name: call.name,
            args: call.args,
            failed: resultsByCallId.get(call.id)?.isError ?? false,
          });
        }
      }
    }
  }
  flushPending();

  if (rows === 0) {
    out.push("");
    out.push("_This session has no messages yet._");
  }

  out.push("");
  return `${out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;
}

/** Prefixes of the agent's self-correction hook prompts (mirrors the sidecar's
 *  `detectHookKind`) — machine-facing injections, never user bubbles. */
const HOOK_PREFIXES = [
  "Ideal? Review the actual work",
  "Stuck? You've repeated essentially",
  "Re-ground. The conversation was just compacted",
] as const;
