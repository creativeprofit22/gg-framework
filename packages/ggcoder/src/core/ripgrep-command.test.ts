import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ripgrepOnPath } from "./ripgrep-command.js";
import { buildSystemPrompt } from "../system-prompt.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) fs.rmSync(dirs.pop() ?? "", { recursive: true, force: true });
});

function binDir(files: readonly string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-rg-"));
  dirs.push(dir);
  for (const f of files) fs.writeFileSync(path.join(dir, f), "");
  return dir;
}

const NOTE =
  /^- Shell: bash \(POSIX\); no `rg` installed: search code with the `grep` tool, as `grep -r` is slow here$/m;

// The host PATH minus any directory holding rg, so bash still resolves.
function pathWithoutRipgrep(): string {
  const sep = process.platform === "win32" ? ";" : ":";
  return (process.env.PATH ?? "")
    .split(sep)
    .filter(
      (dir) =>
        !ripgrepOnPath({ platform: process.platform, pathEnv: dir, pathExt: process.env.PATHEXT }),
    )
    .join(sep);
}

describe("ripgrepOnPath", () => {
  it("finds rg.exe on a Windows PATH", () => {
    const empty = binDir([]);
    const bin = binDir(["rg.exe"]);
    expect(ripgrepOnPath({ platform: "win32", pathEnv: `${empty};${bin}` })).toBe(true);
    expect(ripgrepOnPath({ platform: "win32", pathEnv: empty })).toBe(false);
  });

  it("ignores a directory named rg.exe", () => {
    const bin = binDir([]);
    fs.mkdirSync(path.join(bin, "rg.exe"));
    expect(ripgrepOnPath({ platform: "win32", pathEnv: bin })).toBe(false);
  });

  it.runIf(process.platform !== "win32")("finds a bare rg on a POSIX PATH", () => {
    const bin = binDir(["rg"]);
    expect(ripgrepOnPath({ platform: "linux", pathEnv: `/nonexistent:${bin}` })).toBe(true);
  });
});

describe("missing-ripgrep note in the prompt", () => {
  async function promptWithPath(pathEnv: string, toolNames?: readonly string[]): Promise<string> {
    const previous = process.env.PATH;
    process.env.PATH = pathEnv;
    try {
      return await buildSystemPrompt(binDir([]), undefined, false, undefined, toolNames);
    } finally {
      process.env.PATH = previous;
    }
  }

  it("tells the model to use the grep tool when rg is missing", async () => {
    expect(await promptWithPath(pathWithoutRipgrep())).toMatch(NOTE);
  });

  it("stays silent when rg is installed", async () => {
    const name = process.platform === "win32" ? "rg.exe" : "rg";
    const sep = process.platform === "win32" ? ";" : ":";
    const prompt = await promptWithPath(`${binDir([name])}${sep}${pathWithoutRipgrep()}`);
    expect(prompt).toMatch(/^- Shell: bash \(POSIX\)$/m);
  });

  it("stays silent without the grep tool or a bash shell", async () => {
    expect(await promptWithPath(pathWithoutRipgrep(), ["bash", "read"])).not.toContain(
      "no `rg` installed",
    );
    expect(await promptWithPath(binDir([]))).not.toContain("no `rg` installed");
  });
});
