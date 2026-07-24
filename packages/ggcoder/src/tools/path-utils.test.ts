import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resolvePath, rejectSymlink } from "./path-utils.js";

describe("resolvePath", () => {
  it("resolves relative path from cwd", () => {
    const cwd = path.resolve("home", "user", "project");
    const result = resolvePath(cwd, "src/index.ts");
    expect(result).toBe(path.resolve(cwd, "src/index.ts"));
  });

  it("returns absolute path as-is", () => {
    const absolutePath = path.resolve(path.parse(process.cwd()).root, "etc", "hosts");
    const result = resolvePath(path.resolve("home", "user", "project"), absolutePath);
    expect(result).toBe(absolutePath);
  });

  it("expands ~ to home directory", () => {
    const result = resolvePath("/anywhere", "~");
    expect(result).toBe(os.homedir());
  });

  it("expands ~/path to homedir/path", () => {
    const result = resolvePath("/anywhere", "~/documents/file.txt");
    expect(result).toBe(path.join(os.homedir(), "documents/file.txt"));
  });
});

describe("rejectSymlink", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "path-utils-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("does not throw for a regular file", async () => {
    const filePath = path.join(tmpDir, "regular.txt");
    await fs.writeFile(filePath, "hello");
    await expect(rejectSymlink(filePath)).resolves.toBeUndefined();
  });

  it("throws for a symlink", async () => {
    const target = path.join(tmpDir, "target.txt");
    const link = path.join(tmpDir, "link.txt");
    await fs.writeFile(target, "hello");
    await fs.symlink(target, link);
    await expect(rejectSymlink(link)).rejects.toThrow("Refusing to follow symlink");
  });

  it("does not throw for a non-existent file (ENOENT swallowed)", async () => {
    const missing = path.join(tmpDir, "does-not-exist.txt");
    await expect(rejectSymlink(missing)).resolves.toBeUndefined();
  });
});
