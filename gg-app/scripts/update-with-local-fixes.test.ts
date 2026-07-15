import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const script = join(here, "update-with-local-fixes.mjs");

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

function snapshot(): { head: string; refs: string; status: string } {
  return {
    head: git("rev-parse", "HEAD"),
    refs: git("for-each-ref", "--format=%(refname) %(objectname)"),
    status: git("status", "--porcelain=v1", "--untracked-files=all"),
  };
}

describe("local-fixes updater dry run", () => {
  it("plans a guarded rebase/check without mutating git state", () => {
    const before = snapshot();
    const output = execFileSync(
      process.execPath,
      [script, "--dry-run", "--allow-other-branch", "--no-install", "--no-build", "--check"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    const after = snapshot();

    expect(output).toContain("Protected branch: custom/local-customizations-v2");
    expect(output).toMatch(/\[dry-run] git fetch (?:upstream|origin) \+refs\/heads\/main:/);
    expect(output).toMatch(/\[dry-run] git branch gg-local-before-update-/);
    expect(output).toMatch(/\[dry-run] git rebase (?:upstream|origin)\/main/);
    expect(output).toContain("pnpm");
    expect(output).toContain("--filter gg-app check");
    expect(output).not.toContain("git merge");
    expect(output).not.toContain("downloadAndInstall");
    expect(after).toEqual(before);
  });

  it("never accepts the read-only safety branch as an update target", () => {
    const before = snapshot();
    const result = spawnSync(
      process.execPath,
      [
        script,
        "--dry-run",
        "--allow-other-branch",
        "--branch",
        "custom/local-customizations-safety",
        "--no-install",
        "--no-build",
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("read-only and can never be an update target");
    expect(snapshot()).toEqual(before);
  });
});
