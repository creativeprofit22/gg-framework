import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resolvePath, rejectSymlink } from "./path-utils.js";

describe("resolvePath", () => {
  it("resolves relative path from cwd", () => {
    const result = resolvePath("/home/user/project", "src/index.ts");
    expect(result).toBe(path.resolve("/home/user/project", "src/index.ts"));
  });

  it("returns an absolute path without re-rooting it at the cwd", () => {
    // `/etc/hosts` is absolute on Windows too (drive-rooted), but resolving it
    // attaches the current drive — `D:\etc\hosts`. The invariant under test is
    // "not joined onto the cwd", so compare against the platform's own
    // resolution rather than a POSIX literal.
    const result = resolvePath("/home/user/project", "/etc/hosts");
    expect(result).toBe(path.resolve("/etc/hosts"));
    expect(result).not.toContain("project");
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
