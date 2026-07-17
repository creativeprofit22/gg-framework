import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { freshInstallerForPlatform } from "./build-local-hotfix.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

function fixture(): { root: string; nsis: string } {
  const root = mkdtempSync(join(tmpdir(), "gg-local-installer-"));
  temporaryDirectories.push(root);
  const nsis = join(root, "target", "release", "bundle", "nsis");
  mkdirSync(nsis, { recursive: true });
  return { root, nsis };
}

describe("local installer freshness", () => {
  it("selects a Windows NSIS installer created by the current build", () => {
    const { root, nsis } = fixture();
    const startedAt = Date.now();
    const installer = join(nsis, "Supah-Coder_1.2.3_x64-setup.exe");
    writeFileSync(installer, "installer");

    expect(freshInstallerForPlatform(root, "win32", startedAt)).toBe(installer);
  });

  it("rejects a stale Windows installer from an earlier build", () => {
    const { root, nsis } = fixture();
    const installer = join(nsis, "old-setup.exe");
    writeFileSync(installer, "old installer");
    const old = new Date(Date.now() - 60_000);
    utimesSync(installer, old, old);

    expect(freshInstallerForPlatform(root, "win32", Date.now())).toBeNull();
  });
});
