import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { prettifyError } from "zod";
import { createReadTool, BINARY_EXTENSIONS } from "./read.js";
import { lineHash } from "../core/hashline.js";
import type { ReadTracker } from "./read-tracker.js";

describe("createReadTool", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-tool-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function ctx(id: string) {
    return { signal: new AbortController().signal, toolCallId: id };
  }

  it("reads a file and returns numbered lines in cat -n format", async () => {
    const filePath = path.join(tmpDir, "hello.txt");
    await fs.writeFile(filePath, "alpha\nbeta\ngamma");

    const tool = createReadTool(tmpDir);
    const result = await tool.execute({ file_path: filePath }, ctx("test-1"));

    expect(result).toBe("     1\talpha\n     2\tbeta\n     3\tgamma");
  });

  it("returns all lines when no offset/limit provided", async () => {
    const filePath = path.join(tmpDir, "five.txt");
    await fs.writeFile(filePath, "a\nb\nc\nd\ne");

    const tool = createReadTool(tmpDir);
    const result = await tool.execute({ file_path: filePath }, ctx("test-2"));

    const lines = (result as string).split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("     1\ta");
    expect(lines[4]).toBe("     5\te");
  });

  it("supports offset parameter (1-based, skips first N-1 lines)", async () => {
    const filePath = path.join(tmpDir, "offset.txt");
    await fs.writeFile(filePath, "line1\nline2\nline3\nline4\nline5");

    const tool = createReadTool(tmpDir);
    const result = await tool.execute({ file_path: filePath, offset: 3 }, ctx("test-3"));

    expect(result).toBe("     3\tline3\n     4\tline4\n     5\tline5");
  });

  it("supports limit parameter (returns only N lines)", async () => {
    const filePath = path.join(tmpDir, "limit.txt");
    await fs.writeFile(filePath, "a\nb\nc\nd\ne");

    const tool = createReadTool(tmpDir);
    const result = await tool.execute({ file_path: filePath, limit: 2 }, ctx("test-4"));

    expect(result).toBe("     1\ta\n     2\tb");
  });

  it("supports offset + limit together", async () => {
    const filePath = path.join(tmpDir, "both.txt");
    await fs.writeFile(filePath, "a\nb\nc\nd\ne");

    const tool = createReadTool(tmpDir);
    const result = await tool.execute({ file_path: filePath, offset: 2, limit: 2 }, ctx("test-5"));

    expect(result).toBe("     2\tb\n     3\tc");
  });

  it("returns an image content block for image files", async () => {
    // Minimal valid 1×1 PNG — sharp needs a real decodable image to succeed.
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=";
    const filePath = path.join(tmpDir, "pixel.png");
    await fs.writeFile(filePath, Buffer.from(pngBase64, "base64"));

    const tool = createReadTool(tmpDir);
    const result = await tool.execute({ file_path: filePath }, ctx("test-img"));

    expect(typeof result).not.toBe("string");
    expect(result).toMatchObject({
      content: [
        { type: "text", text: expect.stringContaining("Read image file") },
        { type: "image", mediaType: "image/png", data: expect.any(String) },
      ],
      // Carries an inline terminal preview so the printer can render the image.
      details: {
        imagePreviews: [{ base64: expect.any(String), mediaType: "image/png" }],
      },
    });
  });

  it("detects non-image binary files and returns size notice", async () => {
    const filePath = path.join(tmpDir, "archive.zip");
    const buf = Buffer.alloc(128, 0xff);
    await fs.writeFile(filePath, buf);

    const tool = createReadTool(tmpDir);
    const result = await tool.execute({ file_path: filePath }, ctx("test-6"));

    expect(result).toBe(`Binary file: ${filePath} (.zip, 128 bytes)`);
  });

  it("records the read in the tracker with mtime + hash", async () => {
    const filePath = path.join(tmpDir, "tracked.txt");
    await fs.writeFile(filePath, "content");

    const readFiles: ReadTracker = new Map();
    const tool = createReadTool(tmpDir, readFiles);
    await tool.execute({ file_path: filePath }, ctx("test-7"));

    const entry = readFiles.get(filePath);
    expect(entry).toBeDefined();
    expect(typeof entry?.mtimeMs).toBe("number");
    expect(entry?.hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("anchors option", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-anchors-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function ctx(id: string) {
    return { signal: new AbortController().signal, toolCallId: id };
  }

  it("prefixes each line with a hash│ anchor when anchors: true", async () => {
    const filePath = path.join(tmpDir, "a.txt");
    await fs.writeFile(filePath, "alpha\nbeta\ngamma");

    const tool = createReadTool(tmpDir);
    const result = (await tool.execute(
      { file_path: filePath, anchors: true },
      ctx("a1"),
    )) as string;

    const lines = result.split("\n");
    // hash (4 hex) + │ + 6-wide line number + tab + content, hash from real 0-based index.
    expect(lines[0]).toBe(`${lineHash("alpha", 0)}│     1\talpha`);
    expect(lines[1]).toBe(`${lineHash("beta", 1)}│     2\tbeta`);
    expect(lines[2]).toBe(`${lineHash("gamma", 2)}│     3\tgamma`);
  });

  it("anchor hashes use the real file index under offset", async () => {
    const filePath = path.join(tmpDir, "b.txt");
    await fs.writeFile(filePath, "l1\nl2\nl3\nl4\nl5");

    const tool = createReadTool(tmpDir);
    const result = (await tool.execute(
      { file_path: filePath, offset: 3, anchors: true },
      ctx("a2"),
    )) as string;

    const lines = result.split("\n");
    // First shown line is file line 3 (0-based index 2).
    expect(lines[0]).toBe(`${lineHash("l3", 2)}│     3\tl3`);
  });

  it("default call (no anchors) is unchanged", async () => {
    const filePath = path.join(tmpDir, "c.txt");
    await fs.writeFile(filePath, "x\ny");

    const tool = createReadTool(tmpDir);
    const result = await tool.execute({ file_path: filePath }, ctx("a3"));

    expect(result).toBe("     1\tx\n     2\ty");
  });
});

describe("BINARY_EXTENSIONS", () => {
  it("contains expected entries", () => {
    expect(BINARY_EXTENSIONS.has(".pdf")).toBe(true);
    expect(BINARY_EXTENSIONS.has(".exe")).toBe(true);
    expect(BINARY_EXTENSIONS.has(".wasm")).toBe(true);
  });

  it("no longer contains image extensions (they are handled as image attachments)", () => {
    expect(BINARY_EXTENSIONS.has(".png")).toBe(false);
    expect(BINARY_EXTENSIONS.has(".jpg")).toBe(false);
    expect(BINARY_EXTENSIONS.has(".webp")).toBe(false);
  });
});

describe("read argument errors", () => {
  /** The text the agent loop hands back to the model for rejected arguments. */
  function argumentError(args: Record<string, unknown>): string {
    const result = createReadTool(os.tmpdir()).parameters.safeParse({
      file_path: "/tmp/a.ts",
      ...args,
    });
    return result.success ? "" : prettifyError(result.error);
  }

  it.each([
    ["a range string as offset", { offset: "[98, 242]" }, "offset must be ONE line number"],
    ["an array as offset", { offset: [98, 242] }, "offset must be ONE line number"],
    ["offset 0", { offset: 0 }, "offset must be ONE line number"],
    ["a range string as limit", { limit: "100-200" }, "limit must be ONE line count"],
  ])("shows the fix for %s", (_label, args, expected) => {
    expect(argumentError(args)).toContain(expected);
  });

  it("shows how to express a line range", () => {
    // Haiku repeated "[98, 242]" after a bare "expected number" until the
    // three-strike stop ended the whole sub-agent run.
    expect(argumentError({ offset: "[98, 242]" })).toContain("pass offset: 98 and limit: 145");
  });

  it("still accepts a single line number and count", () => {
    expect(argumentError({ offset: 98, limit: 145 })).toBe("");
  });
});
