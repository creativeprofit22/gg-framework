import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resolvePath, rejectSymlink, msysToWindowsPath } from "./path-utils.js";

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

describe("msysToWindowsPath", () => {
  const win = { platform: "win32" as NodeJS.Platform };

  it("translates /c/... to a native drive path", () => {
    expect(msysToWindowsPath("/c/Users/ken/proj/src/a.ts", win)).toBe(
      "C:\\Users\\ken\\proj\\src\\a.ts",
    );
    expect(msysToWindowsPath("/d/repo", win)).toBe("D:\\repo");
  });

  it("uppercases the drive letter regardless of input case", () => {
    expect(msysToWindowsPath("/C/Users/ken", win)).toBe("C:\\Users\\ken");
  });

  it("translates the //c/ and /cygdrive/c/ spellings identically", () => {
    expect(msysToWindowsPath("//c/Users/x", win)).toBe("C:\\Users\\x");
    expect(msysToWindowsPath("/cygdrive/c/Users/x", win)).toBe("C:\\Users\\x");
  });

  it("maps a drive-only path to the drive ROOT, not the drive-relative cwd", () => {
    expect(msysToWindowsPath("/c", win)).toBe("C:\\");
    expect(msysToWindowsPath("/c/", win)).toBe("C:\\");
    expect(msysToWindowsPath("/cygdrive/d", win)).toBe("D:\\");
  });

  it("leaves MSYS virtual mounts alone rather than guessing", () => {
    expect(msysToWindowsPath("/tmp/x", win)).toBe("/tmp/x");
    expect(msysToWindowsPath("/usr/bin/git", win)).toBe("/usr/bin/git");
    expect(msysToWindowsPath("/home/ken", win)).toBe("/home/ken");
  });

  it("requires a single-letter segment terminated by / or end-of-string", () => {
    expect(msysToWindowsPath("/config/app.json", win)).toBe("/config/app.json");
    expect(msysToWindowsPath("/cygdrive", win)).toBe("/cygdrive");
  });

  it("leaves an already-native Windows path unchanged", () => {
    expect(msysToWindowsPath("C:\\x", win)).toBe("C:\\x");
    expect(msysToWindowsPath("C:/x", win)).toBe("C:/x");
  });

  it("leaves relative paths unchanged", () => {
    expect(msysToWindowsPath("src/index.ts", win)).toBe("src/index.ts");
    expect(msysToWindowsPath("./a.ts", win)).toBe("./a.ts");
    expect(msysToWindowsPath("", win)).toBe("");
  });

  it("never translates on non-Windows platforms (/c/foo is a real POSIX path)", () => {
    for (const platform of ["darwin", "linux"] as NodeJS.Platform[]) {
      expect(msysToWindowsPath("/c/foo", { platform })).toBe("/c/foo");
      expect(msysToWindowsPath("/cygdrive/c/foo", { platform })).toBe("/cygdrive/c/foo");
      expect(msysToWindowsPath("//c/foo", { platform })).toBe("//c/foo");
    }
  });
});

describe("resolvePath with MSYS input", () => {
  it("translates before resolving", () => {
    // path.resolve is host-dependent, so compare against resolving the already
    // translated form: without the MSYS step this would resolve `/c/Users/...`
    // verbatim, which is a different string on every platform.
    const result = resolvePath("D:\\proj", "/c/Users/ken/a.ts", { platform: "win32" });
    expect(result).toBe(path.resolve("D:\\proj", "C:\\Users\\ken\\a.ts"));
  });

  it("leaves /c/foo as a POSIX path when not on Windows", () => {
    expect(resolvePath("/home/user/project", "/c/foo", { platform: "linux" })).toBe(
      path.resolve("/c/foo"),
    );
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
