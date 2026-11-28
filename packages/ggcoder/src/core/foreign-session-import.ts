import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ContentPart, Message, Provider, ToolResult } from "@kenkaiiii/gg-ai";
import {
  APP_MARKER_CUSTOM_KIND,
  type AppMarkerPayload,
  type CustomEntry,
  type MessageEntry,
  type SessionManager,
} from "./session-manager.js";
import {
  asString,
  compactParts,
  extractCursorUserQuery,
  isRecord,
  joinText,
  normalizeTimestamp,
  parseJsonLine,
  textPart,
  toolCallPart,
  toolResultText,
} from "./foreign-transcript-blocks.js";

/**
 * Parse a foreign coding-agent transcript (Claude Code, Codex, Cursor) into
 * GG Coder messages so the thread can be resumed here.
 *
 * `project-discovery.ts` already walks `~/.claude/projects` and
 * `~/.codex/sessions`, but only to recover a cwd. This module reads the message
 * records themselves.
 *
 * Import is lossy **by design**: anything we cannot map faithfully is dropped
 * and counted, never fabricated. `ForeignImportResult.dropped` reports exactly
 * what was lost so the caller can record it on the imported session.
 */

export type ForeignFormat = "claude" | "codex" | "cursor";

export interface ForeignImportDropped {
  /** Tool results whose call we could not pair, or whose payload was unmappable. */
  toolResults: number;
  /** Records recognized as messages but with no usable content. */
  messages: number;
  /** Lines that were not valid JSON or not a known record shape. */
  records: number;
}

export interface ForeignImportResult {
  format: ForeignFormat;
  messages: Message[];
  /** Working directory recorded by the source agent, when it stored one. */
  cwd?: string;
  /** First user prompt, used as the session preview/title. */
  preview?: string;
  /** Epoch millis of the earliest record, when the source recorded timestamps. */
  startedAt?: number;
  dropped: ForeignImportDropped;
}

const EMPTY_DROPPED = (): ForeignImportDropped => ({ toolResults: 0, messages: 0, records: 0 });

/** Human-readable summary of what an import discarded. */
export function describeDropped(dropped: ForeignImportDropped): string {
  const parts: string[] = [];
  if (dropped.toolResults > 0) parts.push(`${dropped.toolResults} unmappable tool result(s)`);
  if (dropped.messages > 0) parts.push(`${dropped.messages} empty message record(s)`);
  if (dropped.records > 0) parts.push(`${dropped.records} unreadable line(s)`);
  return parts.length > 0 ? parts.join(", ") : "nothing";
}

// ── Format detection ───────────────────────────────────────

/**
 * Identify a transcript from its records. Detection is shape-based, not
 * filename-based, so a transcript copied out of its home directory still
 * imports correctly.
 */
export function detectForeignFormat(text: string): ForeignFormat | undefined {
  for (const line of text.split("\n").slice(0, 60)) {
    const record = parseJsonLine(line);
    if (!record) continue;
    const type = asString(record.type);
    // Codex rollout lines wrap everything in `payload`, and its own record
    // types (session_meta / response_item / event_msg / turn_context) are
    // unambiguous.
    if (
      type === "session_meta" ||
      type === "response_item" ||
      type === "event_msg" ||
      type === "turn_context"
    ) {
      return "codex";
    }
    // Pre-late-2025 Codex rollouts have no wrapper: the payload sits at the top
    // level, opening with a `{ id, timestamp, git }` header.
    if (
      type === undefined &&
      typeof record.id === "string" &&
      "timestamp" in record &&
      "git" in record
    ) {
      return "codex";
    }
    if (
      (type === "function_call" || type === "function_call_output" || type === "reasoning") &&
      !("uuid" in record)
    ) {
      return "codex";
    }
    // Claude Code records carry a uuid/parentUuid DAG alongside `message`.
    if ((type === "user" || type === "assistant") && "uuid" in record && "message" in record) {
      return "claude";
    }
    if (asString(record.source) === "cursor" || asString(record.client) === "cursor") {
      return "cursor";
    }
  }
  return undefined;
}

// ── Public entry point ─────────────────────────────────────

export function parseForeignTranscript(text: string, format?: ForeignFormat): ForeignImportResult {
  const resolved = format ?? detectForeignFormat(text);
  if (!resolved) {
    throw new Error(
      "Unrecognized transcript format. Supported: Claude Code, Codex and Cursor JSONL sessions.",
    );
  }
  switch (resolved) {
    case "claude":
      return parseClaudeTranscript(text);
    case "codex":
      return parseCodexTranscript(text);
    case "cursor":
      return parseCursorTranscript(text);
  }
}

// ── Shared accumulator ─────────────────────────────────────

/**
 * Collects parsed parts into well-formed `Message[]`.
 *
 * Every format interleaves assistant text, tool calls and tool results across
 * separate records, so parsers push fragments and this class decides where a
 * message boundary falls: consecutive assistant parts merge into one assistant
 * message, and tool results batch into one `role:"tool"` message.
 */
class TranscriptBuilder {
  readonly messages: Message[] = [];
  readonly dropped = EMPTY_DROPPED();
  private pendingAssistant: ContentPart[] = [];
  private pendingToolResults: ToolResult[] = [];
  /** Tool-call ids seen so far, so an orphan result is dropped, not invented. */
  private readonly knownCallIds = new Set<string>();
  preview?: string;
  cwd?: string;
  startedAt?: number;

  noteTimestamp(value: unknown): void {
    const ms = normalizeTimestamp(value);
    if (ms !== undefined && (this.startedAt === undefined || ms < this.startedAt)) {
      this.startedAt = ms;
    }
  }

  noteCwd(value: unknown): void {
    const cwd = asString(value);
    if (cwd && !this.cwd) this.cwd = cwd;
  }

  pushUser(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) {
      this.dropped.messages += 1;
      return;
    }
    this.flush();
    if (!this.preview) this.preview = trimmed;
    this.messages.push({
      role: "user",
      content: trimmed,
      provenance: { source: "human", kind: "prompt", visibility: "transcript" },
    });
  }

  pushAssistant(parts: ContentPart[]): void {
    const usable = compactParts(parts);
    if (usable.length === 0) return;
    // A tool result must not be reordered before the call it answers.
    this.flushToolResults();
    for (const part of usable) {
      if (part.type === "tool_call") this.knownCallIds.add(part.id);
    }
    this.pendingAssistant.push(...usable);
  }

  pushToolResult(callId: string, content: string, isError?: boolean): void {
    if (!this.knownCallIds.has(callId)) {
      // No matching call in this transcript: emitting it would invent a pairing
      // the provider will reject on resume.
      this.dropped.toolResults += 1;
      return;
    }
    this.flushAssistant();
    this.pendingToolResults.push({
      type: "tool_result",
      toolCallId: callId,
      content,
      ...(isError ? { isError: true } : {}),
    });
  }

  private flushAssistant(): void {
    if (this.pendingAssistant.length === 0) return;
    this.messages.push({ role: "assistant", content: this.pendingAssistant });
    this.pendingAssistant = [];
  }

  private flushToolResults(): void {
    if (this.pendingToolResults.length === 0) return;
    this.messages.push({ role: "tool", content: this.pendingToolResults });
    this.pendingToolResults = [];
  }

  flush(): void {
    this.flushAssistant();
    this.flushToolResults();
  }

  /**
   * Finish the transcript. A trailing assistant message whose last act was an
   * unanswered tool call cannot be resumed (providers reject a dangling call),
   * so those trailing calls are dropped.
   */
  finish(format: ForeignFormat): ForeignImportResult {
    this.flush();
    this.dropTrailingUnansweredCalls();
    return {
      format,
      messages: this.messages,
      ...(this.cwd ? { cwd: this.cwd } : {}),
      ...(this.preview ? { preview: this.preview } : {}),
      ...(this.startedAt !== undefined ? { startedAt: this.startedAt } : {}),
      dropped: this.dropped,
    };
  }

  private dropTrailingUnansweredCalls(): void {
    const last = this.messages[this.messages.length - 1];
    if (!last || last.role !== "assistant" || typeof last.content === "string") return;
    const answered = new Set<string>();
    for (const message of this.messages) {
      if (message.role !== "tool") continue;
      for (const result of message.content) answered.add(result.toolCallId);
    }
    const kept = last.content.filter((part) => part.type !== "tool_call" || answered.has(part.id));
    if (kept.length === last.content.length) return;
    this.dropped.toolResults += last.content.length - kept.length;
    if (kept.length === 0) this.messages.pop();
    else last.content = kept;
  }
}

// ── Claude Code ────────────────────────────────────────────

/**
 * Claude Code writes one JSONL record per DAG node under
 * `~/.claude/projects/<encoded-cwd>/<session>.jsonl`. Message records are
 * `{ type: "user"|"assistant", message: { role, content }, uuid, cwd, timestamp }`
 * where `content` is a string or an Anthropic content-block array. Non-message
 * record types (system, file-history-snapshot, mode, …) are UI state, not
 * conversation, and are skipped without counting as data loss.
 */
export function parseClaudeTranscript(text: string): ForeignImportResult {
  const builder = new TranscriptBuilder();
  const CONVERSATION_TYPES = new Set(["user", "assistant"]);
  const SKIPPED_TYPES = new Set([
    "system",
    "summary",
    "mode",
    "permission-mode",
    "last-prompt",
    "file-history-snapshot",
  ]);

  for (const line of text.split("\n")) {
    const record = parseJsonLine(line);
    if (!record) {
      if (line.trim()) builder.dropped.records += 1;
      continue;
    }
    const type = asString(record.type);
    if (!type || SKIPPED_TYPES.has(type)) continue;
    if (!CONVERSATION_TYPES.has(type)) continue;
    // Sidechain records are a subagent's private thread, not this conversation.
    if (record.isSidechain === true) continue;

    builder.noteCwd(record.cwd);
    builder.noteTimestamp(record.timestamp);

    const message = isRecord(record.message) ? record.message : undefined;
    if (!message) continue;
    const content = message.content;

    if (type === "user") {
      const direct = asString(content);
      if (direct !== undefined) {
        builder.pushUser(direct);
        continue;
      }
      if (!Array.isArray(content)) continue;
      // A "user" record is also how Claude records tool_result blocks.
      const userText: string[] = [];
      for (const block of content) {
        if (!isRecord(block)) continue;
        if (block.type === "tool_result") {
          const callId = asString(block.tool_use_id);
          if (!callId) {
            builder.dropped.toolResults += 1;
            continue;
          }
          builder.pushToolResult(callId, toolResultText(block.content), block.is_error === true);
        } else if (block.type === "text") {
          const blockText = asString(block.text);
          if (blockText) userText.push(blockText);
        }
      }
      if (userText.length > 0) builder.pushUser(joinText(userText));
      continue;
    }

    const parts: ContentPart[] = [];
    const direct = asString(content);
    if (direct !== undefined) {
      parts.push(textPart(direct));
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!isRecord(block)) continue;
        switch (block.type) {
          case "text": {
            const blockText = asString(block.text);
            if (blockText) parts.push(textPart(blockText));
            break;
          }
          case "thinking": {
            const thinking = asString(block.thinking);
            if (thinking) parts.push({ type: "thinking", text: thinking });
            break;
          }
          case "tool_use": {
            const id = asString(block.id);
            const name = asString(block.name);
            if (id && name) parts.push(toolCallPart(id, name, block.input));
            break;
          }
          default:
            break;
        }
      }
    }
    builder.pushAssistant(parts);
  }

  return builder.finish("claude");
}

// ── Codex ──────────────────────────────────────────────────

/**
 * Codex rollouts live at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.
 * Current records are `{ timestamp, type, payload }` where `type` is
 * `session_meta` / `response_item` / `event_msg` / `turn_context`; older
 * rollouts wrote the payload at the top level with no wrapper.
 *
 * Only `response_item` carries the model conversation. `event_msg` duplicates
 * it for the UI, so importing both would double every turn.
 */
export function parseCodexTranscript(text: string): ForeignImportResult {
  const builder = new TranscriptBuilder();

  for (const line of text.split("\n")) {
    const record = parseJsonLine(line);
    if (!record) {
      if (line.trim()) builder.dropped.records += 1;
      continue;
    }
    const wrapperType = asString(record.type);
    const payload = isRecord(record.payload) ? record.payload : record;
    builder.noteTimestamp(record.timestamp ?? payload.timestamp);

    if (wrapperType === "session_meta" || wrapperType === "turn_context") {
      builder.noteCwd(payload.cwd);
      continue;
    }
    // event_msg mirrors response_item for the TUI; taking both duplicates turns.
    if (wrapperType === "event_msg") continue;

    switch (asString(payload.type)) {
      case "message": {
        const role = asString(payload.role);
        const body = codexMessageText(payload.content);
        if (role === "user") {
          // Legacy rollouts record the cwd only inside <environment_context>,
          // so read it before deciding to skip that harness turn.
          builder.noteCwd(codexCwdFrom(body));
          // Codex injects environment/permission context as synthetic user and
          // developer turns; those are its harness, not the user's words.
          if (isCodexHarnessContext(body)) continue;
          builder.pushUser(body);
        } else if (role === "assistant") {
          builder.pushAssistant([textPart(body)]);
        }
        break;
      }
      case "reasoning": {
        const summary = codexReasoningText(payload.summary);
        if (summary) builder.pushAssistant([{ type: "thinking", text: summary }]);
        break;
      }
      case "function_call": {
        const callId = asString(payload.call_id) ?? asString(payload.id);
        const name = asString(payload.name);
        if (callId && name) builder.pushAssistant([toolCallPart(callId, name, payload.arguments)]);
        break;
      }
      case "function_call_output": {
        const callId = asString(payload.call_id);
        if (!callId) {
          builder.dropped.toolResults += 1;
          break;
        }
        builder.pushToolResult(callId, toolResultText(payload.output));
        break;
      }
      default:
        break;
    }
  }

  return builder.finish("codex");
}

const CODEX_CWD_RE = /<cwd>([^<]+)<\/cwd>/;

function codexCwdFrom(body: string): string | undefined {
  return CODEX_CWD_RE.exec(body)?.[1];
}

/** Codex's own injected context turns, which are harness text, not user input. */
function isCodexHarnessContext(body: string): boolean {
  const head = body.trimStart();
  return (
    head.startsWith("<environment_context>") ||
    head.startsWith("<permissions instructions>") ||
    head.startsWith("<user_instructions>")
  );
}

function codexMessageText(content: unknown): string {
  const direct = asString(content);
  if (direct !== undefined) return direct;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const blockText = asString(block.text);
    if (blockText) parts.push(blockText);
  }
  return joinText(parts);
}

function codexReasoningText(summary: unknown): string {
  if (!Array.isArray(summary)) return "";
  const parts: string[] = [];
  for (const block of summary) {
    if (!isRecord(block)) continue;
    const blockText = asString(block.text);
    if (blockText) parts.push(blockText);
  }
  return joinText(parts);
}

// ── Cursor ─────────────────────────────────────────────────

/**
 * Cursor exports a flat JSONL chat log: one record per turn, carrying a role
 * and either a plain `text`/`content` string or a content-block array.
 *
 * The part that actually matters on import is the wrapping: Cursor sends the
 * typed prompt inside `<user_query>`, preceded by context blocks such as
 * `<cursor_commands>` and `<timestamp>`. Importing that verbatim leaks harness
 * scaffolding into the session title and preview, so a recognized wrapper is
 * stripped while a message with UNRECOGNIZED leading context is kept intact —
 * that text may be something the user genuinely wrote.
 */
export function parseCursorTranscript(text: string): ForeignImportResult {
  const builder = new TranscriptBuilder();

  for (const line of text.split("\n")) {
    const record = parseJsonLine(line);
    if (!record) {
      if (line.trim()) builder.dropped.records += 1;
      continue;
    }
    builder.noteTimestamp(record.timestamp ?? record.createdAt ?? record.time);
    builder.noteCwd(record.cwd ?? record.workspacePath);

    const role = asString(record.role) ?? asString(record.type);
    const body = cursorBody(record);

    if (role === "user" || role === "human") {
      builder.pushUser(extractCursorUserQuery(body));
      continue;
    }
    if (role !== "assistant" && role !== "ai") continue;

    const parts: ContentPart[] = [];
    if (body) parts.push(textPart(body));
    for (const call of cursorToolCalls(record)) parts.push(call);
    builder.pushAssistant(parts);

    for (const result of cursorToolResults(record)) {
      builder.pushToolResult(result.callId, result.text, result.isError);
    }
  }

  return builder.finish("cursor");
}

function cursorBody(record: Record<string, unknown>): string {
  const direct = asString(record.text) ?? asString(record.content) ?? asString(record.message);
  if (direct !== undefined) return direct;
  const content = record.content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" || block.type === undefined) {
      const blockText = asString(block.text);
      if (blockText) parts.push(blockText);
    }
  }
  return joinText(parts);
}

function cursorToolCalls(record: Record<string, unknown>): ContentPart[] {
  const raw = record.toolCalls ?? record.tool_calls;
  if (!Array.isArray(raw)) return [];
  const calls: ContentPart[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = asString(item.id) ?? asString(item.callId);
    const name = asString(item.name) ?? asString(item.tool);
    if (!id || !name) continue;
    calls.push(toolCallPart(id, name, item.args ?? item.arguments ?? item.input));
  }
  return calls;
}

function cursorToolResults(
  record: Record<string, unknown>,
): { callId: string; text: string; isError?: boolean }[] {
  const raw = record.toolResults ?? record.tool_results;
  if (!Array.isArray(raw)) return [];
  const results: { callId: string; text: string; isError?: boolean }[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const callId = asString(item.callId) ?? asString(item.toolCallId) ?? asString(item.id);
    if (!callId) continue;
    results.push({
      callId,
      text: toolResultText(item.result ?? item.output ?? item.content),
      ...(item.isError === true ? { isError: true } : {}),
    });
  }
  return results;
}

// ── Writing an importable session ──────────────────────────

export interface ImportedSession {
  sessionId: string;
  sessionPath: string;
  cwd: string;
  messageCount: number;
  format: ForeignFormat;
  dropped: ForeignImportDropped;
  preview?: string;
}

export interface ImportForeignSessionOptions {
  /** Path to the foreign JSONL transcript. */
  filePath: string;
  sessionManager: SessionManager;
  provider: Provider;
  model: string;
  /** Overrides the cwd recorded by the source agent. */
  cwd?: string;
  /** Skips detection when the caller already knows the format. */
  format?: ForeignFormat;
}

/**
 * Read a foreign transcript and write it out as a real GG Coder session, so it
 * resumes through the existing loader with no reader changes: a v2
 * `SessionHeader` from `SessionManager.create()`, one `MessageEntry` per
 * message chained through `parentId`, and a final leaf pointer.
 *
 * An `import` app marker records the source and everything the import dropped —
 * import is lossy by definition, and a silent loss is worse than a noted one.
 */
export async function importForeignSession(
  opts: ImportForeignSessionOptions,
): Promise<ImportedSession> {
  let text: string;
  try {
    text = await fs.readFile(opts.filePath, "utf-8");
  } catch (err) {
    throw new Error(
      `Could not read transcript at ${opts.filePath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const parsed = parseForeignTranscript(text, opts.format);
  if (parsed.messages.length === 0) {
    throw new Error(`No conversation found in ${path.basename(opts.filePath)}.`);
  }

  const cwd = opts.cwd ?? parsed.cwd ?? process.cwd();
  const created = await opts.sessionManager.create(cwd, opts.provider, opts.model, {
    ...(parsed.preview ? { preview: parsed.preview } : {}),
  });

  let parentId: string | null = null;
  for (const message of parsed.messages) {
    const id = crypto.randomUUID();
    const entry: MessageEntry = {
      type: "message",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      message,
    };
    await opts.sessionManager.appendEntry(created.path, entry);
    parentId = id;
  }

  const marker: AppMarkerPayload = {
    version: 1,
    kind: "import",
    afterMessageCount: parsed.messages.length,
    data: {
      source: parsed.format,
      sourcePath: opts.filePath,
      messageCount: parsed.messages.length,
      dropped: describeDropped(parsed.dropped),
      droppedCounts: { ...parsed.dropped },
    },
  };
  const markerEntry: CustomEntry = {
    type: "custom",
    kind: APP_MARKER_CUSTOM_KIND,
    id: crypto.randomUUID(),
    // parentId null keeps the marker off the message DAG, so the model never
    // sees it while the host can still interleave it back into the transcript.
    parentId: null,
    timestamp: new Date().toISOString(),
    data: marker,
  };
  await opts.sessionManager.appendEntry(created.path, markerEntry);

  if (parentId) await opts.sessionManager.updateLeaf(created.path, parentId);

  return {
    sessionId: created.id,
    sessionPath: created.path,
    cwd,
    messageCount: parsed.messages.length,
    format: parsed.format,
    dropped: parsed.dropped,
    ...(parsed.preview ? { preview: parsed.preview } : {}),
  };
}

/** Never-throwing result shape shared by the CLI, the sidecar and the app. */
export type ImportForeignTranscriptResult =
  | {
      ok: true;
      sessionId: string;
      sessionPath: string;
      cwd: string;
      format: ForeignFormat;
      messageCount: number;
      /** Human-readable summary of what the lossy import discarded. */
      dropped: string;
      preview?: string;
    }
  | { ok: false; error: string };
