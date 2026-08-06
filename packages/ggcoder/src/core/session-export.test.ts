import { describe, it, expect } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import {
  sessionToMarkdown,
  defaultExportFilename,
  exportTimestamp,
  toolSummary,
  renderToolArgs,
  renderToolSummaryLine,
  MAX_TOOL_RESULT_CHARS,
} from "./session-export.js";

const meta = {
  mode: "code" as const,
  cwd: "/tmp/proj",
  provider: "anthropic",
  model: "claude-opus-5",
  sessionId: "bcdb5390-e218-4279-840f-043a97973602",
  date: new Date(2026, 6, 26, 14, 2),
};

describe("defaultExportFilename", () => {
  it("names chat sessions your-chat-<date>", () => {
    expect(defaultExportFilename("chat", new Date(2026, 6, 26, 14, 2))).toBe(
      "your-chat-2026-07-26-1402.md",
    );
  });

  it("names coding sessions your-session-<date>", () => {
    expect(defaultExportFilename("code", new Date(2026, 0, 5, 9, 7))).toBe(
      "your-session-2026-01-05-0907.md",
    );
  });

  it("zero-pads every component", () => {
    expect(exportTimestamp(new Date(2026, 0, 2, 3, 4))).toBe("2026-01-02-0304");
  });
});

describe("toolSummary", () => {
  it("prefers the most identifying argument", () => {
    expect(toolSummary("read", { file_path: "src/a.ts", limit: 5 })).toBe("read · src/a.ts");
    expect(toolSummary("bash", { command: "pnpm build" })).toBe("bash · pnpm build");
  });

  it("falls back to the bare name when nothing identifies it", () => {
    expect(toolSummary("ls", {})).toBe("ls");
  });

  it("collapses whitespace and clips long values", () => {
    expect(toolSummary("bash", { command: "echo  a\n  b" })).toBe("bash · echo a b");
    expect(toolSummary("bash", { command: "x".repeat(200) })).toMatch(/…$/);
  });
});

describe("renderToolArgs", () => {
  it("drops a lone string argument the summary already showed whole", () => {
    expect(renderToolArgs({ command: "pnpm build" })).toBeNull();
    expect(renderToolArgs({ file_path: "src/a.ts" })).toBeNull();
  });

  it("renders a long or multi-line command as a shell fence, not escaped JSON", () => {
    const command = `grep -rn "cwd" a.ts | head -20; ${"x".repeat(90)}`;
    const out = renderToolArgs({ command });
    expect(out).toContain("```sh");
    expect(out).toContain('grep -rn "cwd" a.ts');
    // The whole point: no JSON backslash-escaping of the shell quotes.
    expect(out).not.toContain('\\"');
  });

  it("renders multi-key arguments as pretty JSON", () => {
    const out = renderToolArgs({ file_path: "a.ts", limit: 5 });
    expect(out).toContain("```json");
    expect(out).toContain('"limit": 5');
  });

  it("keeps a lone argument the summary row never showed", () => {
    // `agent` isn't a summary key, so dropping it would lose the only detail.
    expect(renderToolArgs({ agent: "bee" })).toContain("bee");
  });

  it("returns null for empty arguments", () => {
    expect(renderToolArgs({})).toBeNull();
    expect(renderToolArgs({ command: "   " })).toBeNull();
  });
});

describe("renderToolSummaryLine", () => {
  const call = (name: string, args: Record<string, unknown>, failed = false) => ({
    name,
    args,
    failed,
  });

  it("names each tool with its primary argument", () => {
    expect(
      renderToolSummaryLine([
        call("read", { file_path: "src/a.ts" }),
        call("bash", { command: "pnpm build" }),
      ]),
    ).toBe("_🔧 read src/a.ts · bash pnpm build_");
  });

  it("dedupes repeats so a re-read file is named once", () => {
    const line = renderToolSummaryLine([
      call("read", { file_path: "a.ts" }),
      call("read", { file_path: "a.ts" }),
    ]);
    expect(line).toBe("_🔧 read a.ts_");
  });

  it("caps a long burst with a +N more tail", () => {
    const calls = Array.from({ length: 12 }, (_, i) => call("read", { file_path: `f${i}.ts` }));
    const line = renderToolSummaryLine(calls) ?? "";
    expect(line).toContain("+4 more");
    expect(line).toContain("read f0.ts");
    expect(line).not.toContain("f11.ts");
  });

  it("surfaces failures so a skimmer sees them without re-exporting", () => {
    expect(
      renderToolSummaryLine([
        call("bash", { command: "false" }, true),
        call("read", { file_path: "a.ts" }),
      ]),
    ).toContain("— 1 failed");
  });

  it("clips a long argument", () => {
    const line = renderToolSummaryLine([call("bash", { command: "x".repeat(200) })]) ?? "";
    expect(line).toContain("…");
    expect(line.length).toBeLessThan(80);
  });

  it("returns null when nothing ran", () => {
    expect(renderToolSummaryLine([])).toBeNull();
  });
});

describe("sessionToMarkdown", () => {
  it("renders a header with model, project and short session id", () => {
    const md = sessionToMarkdown(meta, []);
    expect(md).toContain("# Coding session");
    expect(md).toContain("**Model:** claude-opus-5 (anthropic)");
    expect(md).toContain("**Project:** `/tmp/proj`");
    expect(md).toContain("**Session:** `bcdb5390`");
    expect(md).toContain("_This session has no messages yet._");
  });

  it("titles chat sessions differently", () => {
    expect(sessionToMarkdown({ ...meta, mode: "chat" }, [])).toContain("# Chat transcript");
  });

  it("renders user and assistant turns with role headings", () => {
    const messages: Message[] = [
      { role: "system", content: "SECRET SYSTEM PROMPT" },
      { role: "user", content: "hello there" },
      { role: "assistant", content: [{ type: "text", text: "hi back" }] },
    ];
    const md = sessionToMarkdown(meta, messages);
    expect(md).toContain("## 🧑‍💻 You\n\nhello there");
    expect(md).toContain("## ✨ GG Coder\n\nhi back");
    // The system prompt is ours, never the user's to share.
    expect(md).not.toContain("SECRET SYSTEM PROMPT");
  });

  it("splits an assistant message into one section per text block", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
    ];
    const md = sessionToMarkdown(meta, messages);
    expect(md.match(/## ✨ GG Coder/g)).toHaveLength(2);
  });

  it("pairs tool calls with their results in a collapsed details block at full", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "reading it" },
          { type: "tool_call", id: "t1", name: "read", args: { file_path: "src/a.ts" } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "t1", content: "line one\nline two" }],
      },
    ];
    const md = sessionToMarkdown(meta, messages, { toolDetail: "full" });
    expect(md).toContain("<summary>🔧 read · src/a.ts</summary>");
    expect(md).toContain("line one\nline two");
    expect(md).toContain("</details>");
  });

  it("marks failed tool calls", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "t1", name: "bash", args: { command: "false" } }],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "t1", content: "exit 1", isError: true }],
      },
    ];
    expect(sessionToMarkdown(meta, messages, { toolDetail: "full" })).toContain(
      "— failed</summary>",
    );
  });

  it("coalesces a run of tool-only messages into one line", () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "text", text: "let me look" }] },
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "t1", name: "read", args: { file_path: "a.ts" } }],
      },
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "t2", name: "bash", args: { command: "ls" } }],
      },
      { role: "assistant", content: [{ type: "text", text: "found it" }] },
    ];
    const md = sessionToMarkdown(meta, messages);
    // One marker for the whole run, naming both tools — not one per message.
    expect(md.match(/🔧/g)).toHaveLength(1);
    expect(md).toContain("_🔧 read a.ts · bash ls_");
    // …and it lands between the two paragraphs, in narrative order.
    expect(md.indexOf("let me look")).toBeLessThan(md.indexOf("🔧"));
    expect(md.indexOf("🔧")).toBeLessThan(md.indexOf("found it"));
  });

  it("flushes pending tool work before a user turn", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "t1", name: "read", args: { file_path: "a.ts" } }],
      },
      { role: "user", content: "stop" },
    ];
    const md = sessionToMarkdown(meta, messages);
    expect(md.indexOf("🔧")).toBeLessThan(md.indexOf("## 🧑‍💻 You"));
  });

  it("summarizes tools by default instead of dumping them", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "t1", name: "read", args: { file_path: "a.ts" } }],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "t1", content: "SECRET FILE BODY" }],
      },
    ];
    const md = sessionToMarkdown(meta, messages);
    expect(md).toContain("_🔧 read a.ts_");
    // The default is for humans: no payloads, no fold-out blocks.
    expect(md).not.toContain("<details>");
    expect(md).not.toContain("SECRET FILE BODY");
  });

  it("omits tools entirely at none", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "done" },
          { type: "tool_call", id: "t1", name: "read", args: { file_path: "a.ts" } },
        ],
      },
    ];
    const md = sessionToMarkdown(meta, messages, { toolDetail: "none" });
    expect(md).toContain("done");
    expect(md).not.toContain("🔧");
  });

  it("is dramatically smaller at the default than at full", () => {
    const messages: Message[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push({
        role: "assistant",
        content: [{ type: "tool_call", id: `t${i}`, name: "bash", args: { command: `run ${i}` } }],
      });
      messages.push({
        role: "tool",
        content: [{ type: "tool_result", toolCallId: `t${i}`, content: "y".repeat(4000) }],
      });
    }
    const summary = sessionToMarkdown(meta, messages);
    const full = sessionToMarkdown(meta, messages, { toolDetail: "full" });
    expect(summary.length).toBeLessThan(full.length / 10);
  });

  it("truncates oversized tool output instead of dumping it", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "t1", name: "bash", args: {} }],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "t1", content: "x".repeat(50_000) }],
      },
    ];
    const md = sessionToMarkdown(meta, messages, { toolDetail: "full" });
    expect(md).toContain("more characters truncated");
    expect(md).not.toContain("no messages yet");
    expect(md.length).toBeLessThan(MAX_TOOL_RESULT_CHARS * 3);
  });

  it("never inlines image data from a tool result", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "t1", name: "screenshot", args: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: "t1",
            content: [
              { type: "text", text: "captured" },
              { type: "image", mediaType: "image/png", data: "AAAABBBBCCCC" },
            ],
          },
        ],
      },
    ];
    const md = sessionToMarkdown(meta, messages, { toolDetail: "full" });
    expect(md).toContain("[image: image/png]");
    expect(md).not.toContain("AAAABBBBCCCC");
  });

  it("escapes fences inside tool output so the block cannot break out", () => {
    const messages: Message[] = [
      { role: "assistant", content: [{ type: "tool_call", id: "t1", name: "read", args: {} }] },
      {
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "t1", content: "```\nnested\n```" }],
      },
    ];
    expect(sessionToMarkdown(meta, messages, { toolDetail: "full" })).toContain(
      "````\n```\nnested\n```\n````",
    );
  });

  it("hides thinking by default and shows it on request", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "internal reasoning" },
          { type: "text", text: "answer" },
        ],
      },
    ];
    expect(sessionToMarkdown(meta, messages)).not.toContain("internal reasoning");
    const withThinking = sessionToMarkdown(meta, messages, { includeThinking: true });
    expect(withThinking).toContain("💭 Thinking");
    expect(withThinking).toContain("internal reasoning");
  });

  it("renders hook and compaction injections as quiet markers, not user bubbles", () => {
    const messages: Message[] = [
      { role: "user", content: "real prompt" },
      { role: "user", content: "Ideal? Review the actual work you just did." },
      { role: "user", content: "[Previous conversation summary] blah" },
    ];
    const md = sessionToMarkdown(meta, messages);
    expect(md.match(/## 🧑‍💻 You/g)).toHaveLength(1);
    expect(md).toContain("_(agent self-correction check)_");
    expect(md).toContain("_(conversation compacted here)_");
  });

  it("strips attachment notes the bubble never showed", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image", mediaType: "image/png", data: "ZZZZ" },
        ],
      },
    ];
    const md = sessionToMarkdown(meta, messages);
    expect(md).toContain("look at this");
    expect(md).toContain("_1 image attached_");
    expect(md).not.toContain("ZZZZ");
  });

  it("ends with exactly one trailing newline and no triple blank lines", () => {
    const messages: Message[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: [{ type: "text", text: "b" }] },
    ];
    const md = sessionToMarkdown(meta, messages);
    expect(md.endsWith("\n")).toBe(true);
    expect(md.endsWith("\n\n")).toBe(false);
    expect(md).not.toMatch(/\n{3}/);
  });
});
