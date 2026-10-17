import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveShell } from "./shell.js";
import { getMsysTempDir, getTempRoots } from "./temp-paths.js";
import { resolvePath } from "../tools/path-utils.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("./shell.js", () => ({ resolveShell: vi.fn() }));
let counter = 0;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveShell).mockReturnValue({
    file: `C:\\Git-${++counter}\\bin\\bash.exe`,
    args: ["-c", "cygpath -aw /tmp"],
    isCmdFallback: false,
  });
  vi.mocked(execFileSync).mockReturnValue("C:\\Users\\Test\\AppData\\Local\\Temp\r\n");
});

describe("temporary roots", () => {
  it.each(["darwin", "linux"] as const)(
    "includes system and conventional temp on %s without spawning",
    (platform) => {
      expect(getTempRoots(platform)).toEqual([...new Set([os.tmpdir(), "/tmp"])]);
      expect(execFileSync).not.toHaveBeenCalled();
    },
  );

  it("discovers and caches Windows Bash's actual temp mount", () => {
    const directory = "C:\\Users\\Test\\AppData\\Local\\Temp";
    expect(getMsysTempDir({ platform: "win32" })).toBe(directory);
    expect(getTempRoots("win32")).toContain(directory);
    expect(execFileSync).toHaveBeenCalledTimes(1);
    expect(resolveShell).toHaveBeenCalledWith("cygpath -aw /tmp", { platform: "win32" });
    expect(execFileSync).toHaveBeenCalledWith(
      expect.any(String),
      ["-c", "cygpath -aw /tmp"],
      expect.objectContaining({ timeout: 3000, windowsHide: true }),
    );
  });

  it("keeps native temp working without Git Bash", () => {
    vi.mocked(resolveShell).mockReturnValue({ file: "cmd.exe", args: [], isCmdFallback: true });
    expect(getTempRoots("win32")).toEqual([os.tmpdir()]);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(() => resolvePath("C:\\repo", "/tmp/file.txt", { platform: "win32" })).toThrow(
      "Cannot resolve Git Bash /tmp",
    );
  });

  it.each(["C:\\\r\n", "relative/tmp", "C:\\Temp\nextra", os.homedir()])(
    "refuses invalid or broad translator output %j",
    (output) => {
      vi.mocked(execFileSync).mockReturnValue(output);
      expect(getMsysTempDir({ platform: "win32" })).toBeNull();
    },
  );

  it("fails closed when translation fails", () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error("timeout");
    });
    expect(() => resolvePath("C:\\repo", "/tmp/x", { platform: "win32" })).toThrow(
      "Cannot resolve Git Bash /tmp",
    );
    expect(getTempRoots("win32")).toEqual([os.tmpdir()]);
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it("translates /tmp for file tools, but not similar names or POSIX paths", () => {
    const win = { platform: "win32" as const };
    expect(resolvePath("C:\\repo", "/tmp/file.txt", win)).toBe(
      "C:\\Users\\Test\\AppData\\Local\\Temp\\file.txt",
    );
    expect(resolvePath("C:\\repo", "/tmp", win)).toBe("C:\\Users\\Test\\AppData\\Local\\Temp");
    expect(resolvePath("C:\\repo", "/tmp//file.txt", win)).toBe(
      "C:\\Users\\Test\\AppData\\Local\\Temp\\file.txt",
    );
    expect(resolvePath("C:\\repo", "/tmp-other/file.txt", win)).toBe(
      path.resolve("C:\\repo", "/tmp-other/file.txt"),
    );
    expect(resolvePath("/repo", "/tmp/file.txt", { platform: "linux" })).toBe(
      path.resolve("/tmp/file.txt"),
    );
  });
});
