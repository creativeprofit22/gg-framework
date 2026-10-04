import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolCall, ToolResult } from "@kenkaiiii/gg-ai";
import { catTargets, recordBashReads } from "./bash-read-evidence.js";
import { localOperations } from "./operations.js";
import type { ReadTracker } from "./read-tracker.js";
import { createEditTool } from "./edit.js";
import { createWriteTool } from "./write.js";

function call(command: string, id = "c1"): ToolCall {
  return { type: "tool_call", id, name: "bash", args: { command } };
}
function result(content: string, id = "c1", isError = false): ToolResult {
  return { type: "tool_result", toolCallId: id, content, isError };
}

describe("catTargets", () => {
  it.each([
    ["cat src/a.js", ["src/a.js"]],
    ["cat -n src/a.js src/b.js", ["src/a.js", "src/b.js"]],
    ["git status; cat package.json && cat -n src/x.ts", ["package.json", "src/x.ts"]],
    ['for f in src/a.js src/b.js; do echo "=== $f"; cat -n $f; done', ["src/a.js", "src/b.js"]],
    ['for f in a.js b.js; do echo "== $f"; cat "$f"; done; git log', ["a.js", "b.js"]],
    ["cat src/*.js", ["src/*.js"]],
    ['for f in src/*.js test/*.js; do echo "=== $f"; cat -n "$f"; done', ["src/*.js", "test/*.js"]],
  ])("%s", (command, expected) => {
    expect(catTargets(command)).toEqual(expected);
  });

  it.each([
    "cat $FILE",
    "cat src/**/*.js",
    "cat -A a.js",
    "cat a.js | head -5",
    "cat a.js > b.js",
    "head -20 a.js",
    "for f in a.js; do cat -n $f | head; done",
    "sed -n 1,20p a.js",
  ])("ignores %s", (command) => {
    expect(catTargets(command)).toEqual([]);
  });
});

describe("recordBashReads", () => {
  let dir: string;
  const content = "line one\nline two\nline three\n";

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "bash-read-"));
    await fs.mkdir(path.join(dir, "src"));
    await fs.writeFile(path.join(dir, "src/a.js"), content);
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("records a plain cat whose output holds the whole file", async () => {
    const tracker: ReadTracker = new Map();
    const done = await recordBashReads(
      tracker,
      dir,
      localOperations,
      [call("cat src/a.js")],
      [result(content)],
    );
    expect(done).toEqual([path.join(dir, "src/a.js")]);
    expect(tracker.get(path.join(dir, "src/a.js"))?.seen).toBe("all");
  });

  it("records cat -n output", async () => {
    const tracker: ReadTracker = new Map();
    const out = "=== src/a.js\n     1\tline one\n     2\tline two\n     3\tline three\n";
    await recordBashReads(
      tracker,
      dir,
      localOperations,
      [call('for f in src/a.js; do echo "=== $f"; cat -n $f; done')],
      [result(out)],
    );
    expect(tracker.get(path.join(dir, "src/a.js"))?.seen).toBe("all");
  });

  it("never records output the model did not fully receive", async () => {
    const tracker: ReadTracker = new Map();
    // Trimmed by the per-turn budget: the last line is missing.
    await recordBashReads(
      tracker,
      dir,
      localOperations,
      [call("cat src/a.js")],
      [result("line one\nline two\n[... trimmed ...]")],
    );
    expect(tracker.has(path.join(dir, "src/a.js"))).toBe(false);
  });

  it("never records a failed command or a file that changed after the cat", async () => {
    const tracker: ReadTracker = new Map();
    await recordBashReads(
      tracker,
      dir,
      localOperations,
      [call("cat src/a.js")],
      [result(content, "c1", true)],
    );
    expect(tracker.size).toBe(0);
    await fs.writeFile(path.join(dir, "src/a.js"), "rewritten\n");
    await recordBashReads(tracker, dir, localOperations, [call("cat src/a.js")], [result(content)]);
    expect(tracker.size).toBe(0);
  });

  it("expands a one-directory glob and records only files fully shown", async () => {
    await fs.writeFile(path.join(dir, "src/b.js"), "bee\n");
    await fs.writeFile(path.join(dir, "src/c.js"), "never shown\n");
    const tracker: ReadTracker = new Map();
    const out = "=== src/a.js\n" + content + "=== src/b.js\nbee\n=== src/c.js\nnever";
    await recordBashReads(
      tracker,
      dir,
      localOperations,
      [call('for f in src/*.js; do echo "=== $f"; cat "$f"; done')],
      [result(out)],
    );
    expect([...tracker.keys()].sort()).toEqual([
      path.join(dir, "src/a.js"),
      path.join(dir, "src/b.js"),
    ]);
  });

  it("lets write replace a file the model saw only through cat", async () => {
    const tracker: ReadTracker = new Map();
    await recordBashReads(tracker, dir, localOperations, [call("cat src/a.js")], [result(content)]);
    const write = createWriteTool(dir, tracker);
    await write.execute(
      { file_path: "src/a.js", content: "new\n" },
      { signal: new AbortController().signal, toolCallId: "w1" },
    );
    expect(await fs.readFile(path.join(dir, "src/a.js"), "utf8")).toBe("new\n");
  });

  it("still refuses write when the cat output was trimmed", async () => {
    const tracker: ReadTracker = new Map();
    await recordBashReads(
      tracker,
      dir,
      localOperations,
      [call("cat src/a.js")],
      [result("line one\n…")],
    );
    const write = createWriteTool(dir, tracker);
    await expect(
      write.execute(
        { file_path: "src/a.js", content: "new\n" },
        { signal: new AbortController().signal, toolCallId: "w2" },
      ),
    ).rejects.toThrow(/read first/i);
  });

  it("a fresh cat replaces a stale full read, so write is allowed again", async () => {
    const file = path.join(dir, "src/a.js");
    const tracker: ReadTracker = new Map();
    await recordBashReads(tracker, dir, localOperations, [call("cat src/a.js")], [result(content)]);
    // The model's own script rewrites the file; the recorded read is now stale.
    await fs.writeFile(file, "rewritten\n");
    await fs.utimes(file, new Date(), new Date(Date.now() + 5000));
    await recordBashReads(
      tracker,
      dir,
      localOperations,
      [call("cat src/a.js", "c2")],
      [result("rewritten\n", "c2")],
    );
    const write = createWriteTool(dir, tracker);
    await write.execute(
      { file_path: "src/a.js", content: "final\n" },
      { signal: new AbortController().signal, toolCallId: "w3" },
    );
    expect(await fs.readFile(file, "utf8")).toBe("final\n");
  });

  it("an edit after cat leaves the file fully known for a later write", async () => {
    const tracker: ReadTracker = new Map();
    await recordBashReads(tracker, dir, localOperations, [call("cat src/a.js")], [result(content)]);
    const edit = createEditTool(dir, tracker);
    await edit.execute(
      { file_path: "src/a.js", edits: [{ old_text: "line two", new_text: "line 2" }] },
      { signal: new AbortController().signal, toolCallId: "e1" },
    );
    expect(tracker.get(path.join(dir, "src/a.js"))?.seen).toBe("all");
  });
});
