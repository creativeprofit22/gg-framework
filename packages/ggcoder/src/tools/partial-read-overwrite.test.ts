import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";
import { createEditTool } from "./edit.js";
import { createTools } from "./index.js";
import type { ReadTracker } from "./read-tracker.js";

// A full-file `write` replaces every line, so it must only be allowed once the
// model has actually been shown every line of the current file. Otherwise a
// read cut short by offset/limit or the 2000-line cap lets the model silently
// delete the lines it never saw.

function ctx(id: string) {
  return { signal: new AbortController().signal, toolCallId: id };
}

function numberedLines(count: number): string {
  return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");
}

describe("write after a partial read", () => {
  let tmpDir: string;
  let readFiles: ReadTracker;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "partial-read-test-"));
    readFiles = new Map();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function setup(name: string, content: string) {
    const filePath = path.join(tmpDir, name);
    await fs.writeFile(filePath, content);
    return {
      filePath,
      read: createReadTool(tmpDir, readFiles),
      write: createWriteTool(tmpDir, readFiles),
      edit: createEditTool(tmpDir, readFiles),
    };
  }

  it("refuses to overwrite a file read with a limit, leaving it untouched", async () => {
    const original = numberedLines(50);
    const { filePath, read, write } = await setup("big.ts", original);
    await read.execute({ file_path: filePath, limit: 10 }, ctx("r1"));

    await expect(
      write.execute({ file_path: filePath, content: "replacement\n" }, ctx("w1")),
    ).rejects.toThrow(/only seen lines 1-10 of 50[\s\S]*offset=11/);
    expect(await fs.readFile(filePath, "utf-8")).toBe(original);
  });

  it("refuses to overwrite a file whose read was cut off by the 2000-line cap", async () => {
    const original = numberedLines(2500);
    const { filePath, read, write } = await setup("huge.ts", original);
    await read.execute({ file_path: filePath }, ctx("r1"));

    await expect(
      write.execute({ file_path: filePath, content: "replacement\n" }, ctx("w1")),
    ).rejects.toThrow(/only seen lines 1-2000 of 2500/);
    expect(await fs.readFile(filePath, "utf-8")).toBe(original);
  });

  it("allows the overwrite once the model has paged through every line", async () => {
    const { filePath, read, write } = await setup("huge.ts", numberedLines(2500));
    await read.execute({ file_path: filePath }, ctx("r1"));
    await read.execute({ file_path: filePath, offset: 2001 }, ctx("r2"));

    const result = await write.execute(
      { file_path: filePath, content: "replacement\n" },
      ctx("w1"),
    );
    expect(String(result)).toContain("Wrote");
    expect(await fs.readFile(filePath, "utf-8")).toBe("replacement\n");
  });

  it("names every unseen stretch when the reads left a gap", async () => {
    const { filePath, read, write } = await setup("gappy.ts", numberedLines(30));
    await read.execute({ file_path: filePath, limit: 10 }, ctx("r1"));
    await read.execute({ file_path: filePath, offset: 21 }, ctx("r2"));

    await expect(
      write.execute({ file_path: filePath, content: "replacement\n" }, ctx("w1")),
    ).rejects.toThrow(/only seen lines 1-10, 21-30 of 30/);
  });

  it("keeps targeted edits working after a partial read, but still blocks a full overwrite", async () => {
    const { filePath, read, write, edit } = await setup("mixed.ts", numberedLines(50));
    await read.execute({ file_path: filePath, limit: 10 }, ctx("r1"));

    await edit.execute(
      { file_path: filePath, edits: [{ old_text: "line 3\n", new_text: "line three\n" }] },
      ctx("e1"),
    );
    expect(await fs.readFile(filePath, "utf-8")).toContain("line three\nline 4");

    await expect(
      write.execute({ file_path: filePath, content: "replacement\n" }, ctx("w1")),
    ).rejects.toThrow(/Read the whole file/);
  });

  it("allows the overwrite after a full read followed by an edit", async () => {
    const { filePath, read, write, edit } = await setup("small.ts", numberedLines(5));
    await read.execute({ file_path: filePath }, ctx("r1"));
    await edit.execute(
      { file_path: filePath, edits: [{ old_text: "line 2", new_text: "line two" }] },
      ctx("e1"),
    );

    const result = await write.execute({ file_path: filePath, content: "fresh\n" }, ctx("w1"));
    expect(String(result)).toContain("Wrote");
  });

  // A line longer than the read tool's byte cap can never be shown. Counting
  // it as unseen would block `write` on the file forever (minified bundles,
  // one-line JSON), so the read reports the line and moves past it instead.
  it("does not trap a file whose line is too long to show", async () => {
    const { filePath, read, write } = await setup(
      "bundle.min.js",
      `${"x".repeat(60_000)}\nconsole.log(1);\n`,
    );

    const first = String(await read.execute({ file_path: filePath }, ctx("r1")));
    expect(first).toMatch(/Line 1 is too long to show[\s\S]*offset=2/);
    await expect(
      write.execute({ file_path: filePath, content: "fresh\n" }, ctx("w1")),
    ).rejects.toThrow(/offset=2/);

    await read.execute({ file_path: filePath, offset: 2 }, ctx("r2"));
    const result = await write.execute({ file_path: filePath, content: "fresh\n" }, ctx("w2"));
    expect(String(result)).toContain("Wrote");
  });

  it("allows rewriting a file the model itself wrote in full", async () => {
    const { filePath, read, write } = await setup("own.ts", numberedLines(50));
    await read.execute({ file_path: filePath }, ctx("r1"));
    await write.execute({ file_path: filePath, content: numberedLines(3000) }, ctx("w1"));

    const result = await write.execute({ file_path: filePath, content: "again\n" }, ctx("w2"));
    expect(String(result)).toContain("Wrote");
  });
});

describe("clearing the read tracker", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clear-read-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("makes the model re-read a file before overwriting it after the conversation is rewound", async () => {
    const filePath = path.join(tmpDir, "notes.md");
    await fs.writeFile(filePath, "keep me\n");
    const result = await createTools(tmpDir, { lspDiagnostics: false });
    try {
      const read = result.tools.find((t) => t.name === "read");
      const write = result.tools.find((t) => t.name === "write");
      if (!read || !write) throw new Error("read/write tools missing");

      await read.execute({ file_path: filePath }, ctx("r1"));
      result.clearReadTracker();

      await expect(
        write.execute({ file_path: filePath, content: "gone\n" }, ctx("w1")),
      ).rejects.toThrow(/must be read first/);
      expect(await fs.readFile(filePath, "utf-8")).toBe("keep me\n");
    } finally {
      await result.lspManager?.shutdownAll();
      result.processManager.shutdownAll();
    }
  });
});
