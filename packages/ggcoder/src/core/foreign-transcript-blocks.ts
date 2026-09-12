import type { ContentPart, TextContent, ToolCall } from "@kenkaiiii/gg-ai";

/**
 * Primitives shared by every foreign-transcript parser (Claude Code, Codex,
 * Cursor): content-block normalization, tool-call extraction and timestamps.
 *
 * The formats differ in their envelopes but agree on the substance — text,
 * thinking, tool calls and tool results — so the per-format parsers stay thin
 * and the risky normalization lives in exactly one place.
 */

/** Loose JSON object guard; foreign records are untrusted input. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Parse one JSONL line, returning undefined for blank or malformed lines. */
export function parseJsonLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Normalize a record's timestamp to epoch millis. Foreign formats use ISO
 * strings (Claude, Codex) or numeric epochs in seconds or millis (Cursor).
 * Returns undefined rather than guessing when the value is unusable.
 */
export function normalizeTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Anything below ~1e12 is seconds, not millis (1e12 ms ≈ 2001-09-09).
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  const text = asString(value);
  if (!text) return undefined;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Collapse a text block list into one string, dropping empties. */
export function joinText(parts: readonly string[]): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
}

export function textPart(text: string): TextContent {
  return { type: "text", text };
}

/**
 * Build a tool-call part from a foreign record. `args` may arrive as an object
 * (Claude `input`) or a JSON string (Codex `arguments`); an unparseable string
 * is preserved verbatim under `raw` rather than dropped, so a resumed thread
 * still shows what was attempted.
 */
export function toolCallPart(id: string, name: string, args: unknown): ToolCall {
  return { type: "tool_call", id, name, args: normalizeToolArgs(args) };
}

export function normalizeToolArgs(args: unknown): Record<string, unknown> {
  if (isRecord(args)) return args;
  const text = asString(args);
  if (text === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : { raw: text };
  } catch {
    return { raw: text };
  }
}

/**
 * Flatten a foreign tool result into plain text. Import is lossy by design: we
 * never fabricate structure we did not read, so anything that is not text
 * becomes a short placeholder instead of an invented block.
 */
export function toolResultText(content: unknown): string {
  const direct = asString(content);
  if (direct !== undefined) return direct;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (!isRecord(item)) continue;
      const text = asString(item.text);
      if (text !== undefined) parts.push(text);
      else if (item.type === "image") parts.push("[image omitted on import]");
    }
    return joinText(parts);
  }
  if (isRecord(content)) {
    const text = asString(content.text) ?? asString(content.output);
    if (text !== undefined) return text;
  }
  return "";
}

/** Drop empty text parts so an import never produces a blank message. */
export function compactParts(parts: ContentPart[]): ContentPart[] {
  return parts.filter(
    (part) => !((part.type === "text" || part.type === "thinking") && !part.text.trim()),
  );
}

/**
 * Context wrappers Cursor prepends to a user turn before the real prompt.
 * Each is stripped only when it sits before a trailing `<user_query>`; a
 * message carrying context we do NOT recognize is left completely intact
 * rather than silently truncated.
 */
const RECOGNIZED_CURSOR_WRAPPERS = ["cursor_commands", "timestamp", "additional_data"] as const;

const USER_QUERY_RE = /<user_query>([\s\S]*)<\/user_query>\s*$/;

/**
 * Extract the real prompt from a Cursor user message.
 *
 * Cursor wraps the typed prompt in `<user_query>` and prepends context blocks
 * (`<cursor_commands>`, `<timestamp>`, …). Importing the raw string leaks that
 * scaffolding into the session preview and title. We take the trailing
 * `<user_query>` only when everything before it is recognized context;
 * otherwise the message is returned unchanged, because unknown leading context
 * may be part of what the user actually said.
 */
export function extractCursorUserQuery(raw: string): string {
  const match = USER_QUERY_RE.exec(raw);
  if (!match) return raw;
  const lead = raw.slice(0, match.index).trim();
  if (lead && !isRecognizedCursorContext(lead)) return raw;
  return match[1]!.trim();
}

function isRecognizedCursorContext(lead: string): boolean {
  let rest = lead;
  while (rest) {
    const tag = RECOGNIZED_CURSOR_WRAPPERS.find((name) => rest.startsWith(`<${name}>`));
    if (!tag) return false;
    const close = rest.indexOf(`</${tag}>`);
    if (close === -1) return false;
    rest = rest.slice(close + tag.length + 3).trim();
  }
  return true;
}
