import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AssistantMessage, Message } from "@kenkaiiii/gg-ai";
import {
  detectForeignFormat,
  importForeignSession,
  parseForeignTranscript,
  type ForeignFormat,
} from "./foreign-session-import.js";
import { extractCursorUserQuery } from "./foreign-transcript-blocks.js";
import { APP_MARKER_CUSTOM_KIND, SessionManager } from "./session-manager.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");

const FIXTURE_FILE: Record<ForeignFormat, string> = {
  claude: path.join(FIXTURES, "claude-transcript.jsonl"),
  codex: path.join(FIXTURES, "codex-transcript.jsonl"),
  cursor: path.join(FIXTURES, "cursor-transcript.jsonl"),
};

async function parseFixture(format: ForeignFormat) {
  return parseForeignTranscript(await fs.readFile(FIXTURE_FILE[format], "utf-8"));
}

function assistantParts(message: Message | undefined): AssistantMessage["content"] {
  if (!message || message.role !== "assistant") throw new Error("expected an assistant message");
  return message.content;
}

function allText(messages: Message[]): string {
  return JSON.stringify(messages);
}

describe("detectForeignFormat", () => {
  it("identifies each format from its record shapes", async () => {
    for (const format of ["claude", "codex", "cursor"] as const) {
      const text = await fs.readFile(FIXTURE_FILE[format], "utf-8");
      expect(detectForeignFormat(text)).toBe(format);
    }
  });

  it("returns undefined for an unrelated JSONL file", () => {
    expect(detectForeignFormat('{"hello":"world"}\n{"a":1}')).toBeUndefined();
  });

  it("throws a clear error when asked to parse an unknown format", () => {
    expect(() => parseForeignTranscript('{"hello":"world"}')).toThrow(/Unrecognized transcript/);
  });
});

describe("Claude Code import", () => {
  it("maps prompts, thinking, tool calls and tool results", async () => {
    const result = await parseFixture("claude");
    expect(result.cwd).toBe("/Users/dev/widgets");
    expect(result.preview).toBe("Add a retry to the fetch helper.");
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);

    const parts = assistantParts(result.messages[1]);
    expect(Array.isArray(parts)).toBe(true);
    expect((parts as { type: string }[]).map((p) => p.type)).toEqual([
      "thinking",
      "text",
      "tool_call",
    ]);

    const toolMessage = result.messages[2];
    expect(toolMessage?.role).toBe("tool");
    if (toolMessage?.role === "tool") {
      expect(toolMessage.content[0]?.toolCallId).toBe("toolu_1");
      expect(toolMessage.content[0]?.content).toContain("export async function get");
    }
  });

  it("skips sidechain (subagent) records", async () => {
    const result = await parseFixture("claude");
    expect(allText(result.messages)).not.toContain("subagent chatter");
  });

  it("drops an orphan tool result rather than inventing a pairing", async () => {
    const result = await parseFixture("claude");
    expect(allText(result.messages)).not.toContain("no matching call");
    expect(result.dropped.toolResults).toBe(1);
  });

  it("counts unparseable lines instead of failing the import", async () => {
    const result = await parseFixture("claude");
    expect(result.dropped.records).toBe(1);
  });
});

describe("Codex import", () => {
  it("maps the conversation without duplicating event_msg mirrors", async () => {
    const result = await parseFixture("codex");
    expect(result.cwd).toBe("/Users/dev/widgets");
    expect(result.preview).toBe("Why is the build slow?");
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    // "Why is the build slow?" appears in both an event_msg and a response_item.
    const userMessages = result.messages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);
  });

  it("skips Codex's own harness context turns", async () => {
    const result = await parseFixture("codex");
    expect(allText(result.messages)).not.toContain("permissions instructions");
  });

  it("parses a JSON-string function_call into structured args", async () => {
    const result = await parseFixture("codex");
    const parts = assistantParts(result.messages[1]) as { type: string; args?: unknown }[];
    const call = parts.find((part) => part.type === "tool_call");
    expect(call?.args).toEqual({ command: ["bash", "-lc", "cat tsup.config.ts"] });
  });
});

describe("Cursor import", () => {
  it("strips recognized context wrappers from the user query", async () => {
    const result = await parseFixture("cursor");
    expect(result.preview).toBe("Rename the Button component to IconButton.");
    expect(result.preview).not.toContain("cursor_commands");
    expect(result.preview).not.toContain("<timestamp>");
  });

  it("carries no wrapper text anywhere in the imported messages", async () => {
    const result = await parseFixture("cursor");
    const serialized = allText(result.messages);
    expect(serialized).not.toContain("<cursor_commands>");
    expect(serialized).not.toContain("<timestamp>");
    expect(serialized).not.toContain("user opened src/index.ts");
  });

  it("keeps a message with unrecognized leading context intact", async () => {
    const result = await parseFixture("cursor");
    const users = result.messages.filter((m) => m.role === "user");
    expect(users[1]?.content).toContain("<mystery_context>");
    expect(users[1]?.content).toContain("Now add a size prop.");
  });

  it("pairs tool calls with their results", async () => {
    const result = await parseFixture("cursor");
    const toolMessage = result.messages.find((m) => m.role === "tool");
    expect(toolMessage?.role).toBe("tool");
    if (toolMessage?.role === "tool") {
      expect(toolMessage.content[0]?.toolCallId).toBe("tc_1");
      expect(toolMessage.content[0]?.content).toBe("1 file changed");
    }
  });

  it("normalizes second-precision timestamps to millis", async () => {
    const result = await parseFixture("cursor");
    expect(result.startedAt).toBe(1784544000 * 1000);
  });
});

describe("extractCursorUserQuery", () => {
  it("returns plain text unchanged", () => {
    expect(extractCursorUserQuery("just a prompt")).toBe("just a prompt");
  });

  it("unwraps a bare user_query", () => {
    expect(extractCursorUserQuery("<user_query>hello</user_query>")).toBe("hello");
  });

  it("refuses to truncate unknown leading context", () => {
    const raw = "<unknown>ctx</unknown>\n<user_query>hi</user_query>";
    expect(extractCursorUserQuery(raw)).toBe(raw);
  });

  it("leaves an unterminated wrapper alone", () => {
    const raw = "<cursor_commands>oops\n<user_query>hi</user_query>";
    expect(extractCursorUserQuery(raw)).toBe(raw);
  });
});

describe("importForeignSession", () => {
  let root: string;
  let sessionManager: SessionManager;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "gg-import-"));
    sessionManager = new SessionManager(path.join(root, "sessions"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("writes a resumable session that round-trips through the normal loader", async () => {
    const imported = await importForeignSession({
      filePath: FIXTURE_FILE.claude,
      sessionManager,
      provider: "anthropic",
      model: "claude-sonnet-5",
    });

    expect(imported.cwd).toBe("/Users/dev/widgets");
    expect(imported.messageCount).toBe(4);

    const loaded = await sessionManager.load(imported.sessionPath);
    expect(loaded).not.toBeNull();
    expect(loaded!.header.cwd).toBe("/Users/dev/widgets");
    expect(loaded!.header.preview).toBe("Add a retry to the fetch helper.");

    const messages = sessionManager.getMessages(loaded!.entries, loaded!.header.leafId);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  });

  it("records an import marker naming the source and what was dropped", async () => {
    const imported = await importForeignSession({
      filePath: FIXTURE_FILE.claude,
      sessionManager,
      provider: "anthropic",
      model: "claude-sonnet-5",
    });

    const loaded = await sessionManager.load(imported.sessionPath);
    const markers = sessionManager.getAppMarkers(loaded!.entries, loaded!.header.leafId);
    const importMarker = markers.find((marker) => marker.kind === "import");
    expect(importMarker).toBeDefined();
    expect(importMarker?.data.source).toBe("claude");
    expect(String(importMarker?.data.dropped)).toContain("tool result");

    // The marker must stay OFF the message DAG so the model never sees it.
    const custom = loaded!.entries.filter(
      (entry) => entry.type === "custom" && entry.kind === APP_MARKER_CUSTOM_KIND,
    );
    expect(custom).toHaveLength(1);
    expect(custom[0]?.parentId).toBeNull();
  });

  it("imports a Cursor thread with no wrapper text in its preview", async () => {
    const imported = await importForeignSession({
      filePath: FIXTURE_FILE.cursor,
      sessionManager,
      provider: "anthropic",
      model: "claude-sonnet-5",
    });

    expect(imported.preview).toBe("Rename the Button component to IconButton.");
    const loaded = await sessionManager.load(imported.sessionPath);
    expect(loaded!.header.preview).not.toContain("cursor_commands");
    expect(loaded!.header.preview).not.toContain("<timestamp>");
  });

  it("prefers an explicit cwd over the one recorded by the source agent", async () => {
    const imported = await importForeignSession({
      filePath: FIXTURE_FILE.codex,
      sessionManager,
      provider: "anthropic",
      model: "claude-sonnet-5",
      cwd: "/Users/dev/elsewhere",
    });
    expect(imported.cwd).toBe("/Users/dev/elsewhere");
  });

  it("fails clearly on a missing file", async () => {
    await expect(
      importForeignSession({
        filePath: path.join(root, "nope.jsonl"),
        sessionManager,
        provider: "anthropic",
        model: "claude-sonnet-5",
      }),
    ).rejects.toThrow(/Could not read transcript/);
  });
});
