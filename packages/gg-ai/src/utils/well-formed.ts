import type { ContentPart, Message, ToolResult, ToolResultContent } from "../types.js";

/**
 * Lone (unpaired) UTF-16 surrogate. A string holding one cannot be encoded as
 * valid UTF-8, so `JSON.stringify` emits a `\uD83D`-style escape that every
 * provider's JSON parser rejects:
 *
 *   "The request body is not valid JSON: no low surrogate in string"  (Anthropic)
 *   "Bad Request"                                                     (OpenAI)
 *
 * They enter the conversation from outside our control — a model streaming a
 * split emoji escape inside tool-call arguments, a character-indexed truncation
 * that cut an astral character in half, or file/shell bytes that decoded to a
 * half pair — and then persist in history, so every later turn fails too,
 * including after a retry or a model switch.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LONE_SURROGATE_GLOBAL = new RegExp(LONE_SURROGATE, "g");
const REPLACEMENT = "\uFFFD";

/** True when the string contains at least one unpaired surrogate. */
export function hasLoneSurrogate(text: string): boolean {
  // `isWellFormed` (Node 20+) is a native linear scan — far cheaper than regex
  // over megabyte-sized transcripts. Fall back for older runtimes.
  const isWellFormed = (text as { isWellFormed?: () => boolean }).isWellFormed;
  if (typeof isWellFormed === "function") return !isWellFormed.call(text);
  return LONE_SURROGATE.test(text);
}

/** Replace unpaired surrogates with U+FFFD; returns the input when already valid. */
export function toWellFormedText(text: string): string {
  if (!hasLoneSurrogate(text)) return text;
  const toWellFormed = (text as { toWellFormed?: () => string }).toWellFormed;
  if (typeof toWellFormed === "function") return toWellFormed.call(text);
  return text.replace(LONE_SURROGATE_GLOBAL, REPLACEMENT);
}

/** True when `code` is a high surrogate — the first half of an astral pair. */
function isHighSurrogate(code: number | undefined): boolean {
  return code !== undefined && code >= 0xd800 && code <= 0xdbff;
}

/** True when `code` is a low surrogate — the second half of an astral pair. */
function isLowSurrogate(code: number | undefined): boolean {
  return code !== undefined && code >= 0xdc00 && code <= 0xdfff;
}

/** `text.slice(0, chars)` that never cuts an astral character in half. */
export function sliceHead(text: string, chars: number): string {
  if (chars <= 0) return "";
  if (chars >= text.length) return text;
  const end = isHighSurrogate(text.charCodeAt(chars - 1)) ? chars - 1 : chars;
  return text.slice(0, end);
}

/** `text.slice(-chars)` that never cuts an astral character in half. */
export function sliceTail(text: string, chars: number): string {
  if (chars <= 0) return "";
  if (chars >= text.length) return text;
  const start = text.length - chars;
  return text.slice(isLowSurrogate(text.charCodeAt(start)) ? start + 1 : start);
}

/** Sanitize arbitrary JSON-ish data (tool args, server tool payloads), cloning only when needed. */
function sanitizeJsonValue(value: unknown): unknown {
  if (typeof value === "string") return toWellFormedText(value);
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const sanitized = sanitizeJsonValue(item);
      if (sanitized !== item) changed = true;
      return sanitized;
    });
    return changed ? next : value;
  }
  if (value !== null && typeof value === "object") {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const sanitizedKey = toWellFormedText(key);
      const sanitized = sanitizeJsonValue(item);
      if (sanitizedKey !== key || sanitized !== item) changed = true;
      next[sanitizedKey] = sanitized;
    }
    return changed ? next : value;
  }
  return value;
}

function sanitizeRecord(value: Record<string, unknown>): Record<string, unknown> {
  return sanitizeJsonValue(value) as Record<string, unknown>;
}

/** Sanitize one content block. Base64 media payloads are skipped — they are
 *  ASCII by construction and can be megabytes, so scanning them is pure cost. */
function sanitizePart<T extends ContentPart>(part: T): T {
  switch (part.type) {
    case "text":
    case "thinking": {
      // `signature` is provider-issued and must round-trip byte-for-byte.
      const text = toWellFormedText(part.text);
      return text === part.text ? part : { ...part, text };
    }
    case "tool_call": {
      const args = sanitizeRecord(part.args);
      return args === part.args ? part : { ...part, args };
    }
    case "server_tool_call": {
      const input = sanitizeJsonValue(part.input);
      return input === part.input ? part : { ...part, input };
    }
    case "server_tool_result": {
      const data = sanitizeJsonValue(part.data);
      return data === part.data ? part : { ...part, data };
    }
    case "raw": {
      const data = sanitizeRecord(part.data);
      return data === part.data ? part : { ...part, data };
    }
    default:
      return part;
  }
}

function sanitizeParts<T extends ContentPart>(parts: T[]): T[] {
  let changed = false;
  const next = parts.map((part) => {
    const sanitized = sanitizePart(part);
    if (sanitized !== part) changed = true;
    return sanitized as T;
  });
  return changed ? next : parts;
}

function sanitizeToolResultContent(content: ToolResultContent): ToolResultContent {
  if (typeof content === "string") return toWellFormedText(content);
  return sanitizeParts(content);
}

function sanitizeToolResults(results: ToolResult[]): ToolResult[] {
  let changed = false;
  const next = results.map((result) => {
    const content = sanitizeToolResultContent(result.content);
    if (content === result.content) return result;
    changed = true;
    return { ...result, content };
  });
  return changed ? next : results;
}

function sanitizeMessage(message: Message): Message {
  if (message.role === "tool") {
    const content = sanitizeToolResults(message.content);
    return content === message.content ? message : { ...message, content };
  }
  if (typeof message.content === "string") {
    const content = toWellFormedText(message.content);
    return content === message.content ? message : { ...message, content };
  }
  const content = sanitizeParts(message.content);
  return content === message.content ? message : ({ ...message, content } as Message);
}

/**
 * Strip unpaired surrogates from everything headed for the wire. Returns the
 * same array (and same message objects) when the history is already valid, so
 * the clean path stays allocation-free.
 */
export function sanitizeMessagesForWire(messages: Message[]): Message[] {
  let sanitized: Message[] | undefined;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    const next = sanitizeMessage(message);
    if (next === message) continue;
    sanitized ??= messages.slice();
    sanitized[index] = next;
  }
  return sanitized ?? messages;
}
