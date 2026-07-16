import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isLocalForkBranch } from "../vite.config";

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

function runDryRunOnBranch(branch: string) {
  const temporaryRepo = mkdtempSync(join(tmpdir(), "gg-local-branch-test-"));
  try {
    execFileSync("git", ["init", "--initial-branch", branch], { cwd: temporaryRepo });
    execFileSync("git", ["remote", "add", "upstream", "https://example.com/upstream.git"], {
      cwd: temporaryRepo,
    });
    return spawnSync(process.execPath, [script, "--dry-run", "--no-install", "--no-build"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_DIR: join(temporaryRepo, ".git"),
        GIT_WORK_TREE: temporaryRepo,
      },
    });
  } finally {
    rmSync(temporaryRepo, { force: true, recursive: true });
  }
}

describe("local-fixes updater dry run", () => {
  it("plans a guarded rebase/check without mutating git state", () => {
    const before = snapshot();
    const output = execFileSync(
      process.execPath,
      [script, "--dry-run", "--no-install", "--no-build", "--check"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    const after = snapshot();

    expect(output).toContain("Protected branch: custom/local-customizations");
    expect(output).toMatch(/\[dry-run] git fetch (?:upstream|origin) \+refs\/heads\/main:/);
    expect(output).toMatch(/\[dry-run] git branch gg-local-before-update-/);
    expect(output).toMatch(/\[dry-run] git rebase (?:upstream|origin)\/main/);
    expect(output).toContain("pnpm");
    expect(output).toContain("--filter gg-app check");
    expect(output).not.toContain("git merge");
    expect(output).not.toContain("downloadAndInstall");
    expect(after).toEqual(before);
  });

  it.each(["custom/local-customizations", "custom/local-customizations-v2"])(
    "accepts the canonical and temporary cutover branch: %s",
    (branch) => {
      const result = runDryRunOnBranch(branch);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Protected branch: custom/local-customizations");
    },
  );

  it("always rejects the read-only safety checkout", () => {
    const result = runDryRunOnBranch("custom/local-customizations-safety");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("read-only and can never be updated");
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

describe("local-patched branch detection", () => {
  it.each(["custom/local-customizations", "custom/local-customizations-v2"])(
    "detects an accepted local branch: %s",
    (branch) => {
      expect(isLocalForkBranch(branch)).toBe(true);
    },
  );

  it("does not detect the read-only safety branch by name", () => {
    expect(isLocalForkBranch("custom/local-customizations-safety")).toBe(false);
  });
});
