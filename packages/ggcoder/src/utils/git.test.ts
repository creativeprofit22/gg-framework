import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { slowRevParseGit } from "../test-support/slow-git.js";
import {
  getGitDirtyFileCount,
  isGitRepo,
  runBackgroundGit,
  withoutRepositoryRedirectEnv,
} from "./git.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("getGitDirtyFileCount", () => {
  it("counts staged, modified, and untracked files", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gg-git-dirty-"));
    tempDirs.push(cwd);
    await execFileAsync("git", ["init"], { cwd });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd });
    await execFileAsync("git", ["config", "user.name", "GG Test"], { cwd });

    await writeFile(path.join(cwd, "modified.txt"), "original\n");
    await execFileAsync("git", ["add", "modified.txt"], { cwd });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd });
    expect(await getGitDirtyFileCount(cwd)).toBe(0);

    await writeFile(path.join(cwd, "modified.txt"), "changed\n");
    await writeFile(path.join(cwd, "staged.txt"), "staged\n");
    await execFileAsync("git", ["add", "staged.txt"], { cwd });
    await writeFile(path.join(cwd, "untracked.txt"), "untracked\n");

    expect(await getGitDirtyFileCount(cwd)).toBe(3);
  });

  it("rejects outside a git repository so callers can preserve the last known count", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gg-not-git-"));
    tempDirs.push(cwd);

    await expect(getGitDirtyFileCount(cwd)).rejects.toBeDefined();
  });
});

describe("isGitRepo", () => {
  it("is false when git answers that the folder is not a repo", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gg-not-git-"));
    tempDirs.push(cwd);

    expect(await isGitRepo(cwd)).toBe(false);
  });

  // Regression: a git call that timed out on a busy CI machine was reported
  // as "not a repo", so a goal window's titlebar lost the project's changes.
  it.skipIf(process.platform === "win32")(
    "rejects instead of answering false when git does not answer in time",
    async () => {
      const cwd = await mkdtemp(path.join(tmpdir(), "gg-git-slow-"));
      tempDirs.push(cwd);
      await execFileAsync("git", ["init", "-q"], { cwd });
      tempDirs.push(await slowRevParseGit(1));

      await expect(isGitRepo(cwd, { timeoutMs: 100 })).rejects.toBeDefined();
      expect(await isGitRepo(cwd, { timeoutMs: 5_000 })).toBe(true);
    },
  );
});

describe("isolateRepository", () => {
  it("drops repository-redirect and config-injection variables case-insensitively", () => {
    const env = withoutRepositoryRedirectEnv({
      GIT_DIR: "/elsewhere",
      git_work_tree: "/elsewhere",
      GIT_COMMON_DIR: "x",
      GIT_INDEX_FILE: "x",
      GIT_OBJECT_DIRECTORY: "x",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "x",
      GIT_NAMESPACE: "x",
      GIT_CONFIG_PARAMETERS: "'core.pager'='evil'",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.pager",
      Git_Config_Value_0: "evil",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_DATE: "2026-01-01",
      PATH: "/bin",
    });
    expect(Object.keys(env).sort()).toEqual(["GIT_AUTHOR_DATE", "GIT_TERMINAL_PROMPT", "PATH"]);
  });

  it("ignores an inherited GIT_DIR pointing at another repository", async () => {
    const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "gg-git-isolate-")));
    const other = await realpath(await mkdtemp(path.join(tmpdir(), "gg-git-other-")));
    tempDirs.push(cwd, other);
    await execFileAsync("git", ["init"], { cwd });
    await execFileAsync("git", ["init"], { cwd: other });
    vi.stubEnv("GIT_DIR", path.join(other, ".git"));

    const leaked = await runBackgroundGit(["rev-parse", "--absolute-git-dir"], { cwd });
    expect(await realpath(leaked.stdout.trim())).toBe(await realpath(path.join(other, ".git")));
    const isolated = await runBackgroundGit(["rev-parse", "--absolute-git-dir"], {
      cwd,
      isolateRepository: true,
    });
    expect(await realpath(isolated.stdout.trim())).toBe(await realpath(path.join(cwd, ".git")));
  });
});
