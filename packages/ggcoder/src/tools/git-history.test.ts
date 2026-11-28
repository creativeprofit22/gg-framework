import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createGitHistoryTool, validateHistoryPath, type GitHistoryLimits } from "./git-history.js";

const execFileAsync = promisify(execFile);

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const NOW = new Date("2026-10-29T00:00:00.000Z");
const LONG_SUBJECT = `Refactor ${"x".repeat(300)}`;

async function git(cwd: string, args: string[], date?: string): Promise<void> {
  await execFileAsync("git", args, {
    cwd,
    env: date ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : process.env,
  });
}

async function writeFiles(cwd: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(cwd, name)), { recursive: true });
    await writeFile(path.join(cwd, name), content);
  }
}

async function commit(cwd: string, files: Record<string, string>, subject: string, date: string) {
  await writeFiles(cwd, files);
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-q", "-m", subject], date);
}

async function initRepo(cwd: string): Promise<void> {
  await git(cwd, ["init", "-q"]);
  await git(cwd, ["config", "user.email", "secret@example.com"]);
  await git(cwd, ["config", "user.name", "Secret Author"]);
  await git(cwd, ["config", "core.autocrlf", "false"]);
}

function context(signal: AbortSignal = new AbortController().signal) {
  return { signal, toolCallId: "call-1" };
}

async function run(
  cwd: string,
  args: Record<string, unknown>,
  limits?: Partial<GitHistoryLimits>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const tool = createGitHistoryTool(cwd, { now: () => NOW, limits });
  const text = await tool.execute(args as never, context(signal));
  return JSON.parse(String(text)) as Record<string, unknown>;
}

describe.skipIf(!gitAvailable())("git_history", () => {
  let repo = "";
  const extraDirs: string[] = [];

  beforeAll(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "gg-git-history-"));
    await initRepo(repo);
    await commit(
      repo,
      { "src/a.ts": "1", "src/b.ts": "1", "docs/readme.md": "1" },
      "Add sources",
      "2026-01-01T10:00:00Z",
    );
    await commit(
      repo,
      { "src/a.ts": "2", "src/b.ts": "2" },
      "Fix bug reported by bob@example.org\tnow",
      "2026-02-01T10:00:00Z",
    );
    await commit(
      repo,
      { "src/a.ts": "3", "src/sp ace/ü.ts": "1" },
      LONG_SUBJECT,
      "2026-03-01T10:00:00Z",
    );
    await commit(
      repo,
      {
        "src/a.ts": "4",
        "big/0.txt": "0",
        "big/1.txt": "1",
        "big/2.txt": "2",
        "big/3.txt": "3",
        "big/4.txt": "4",
      },
      "Bulk import",
      "2026-04-01T10:00:00Z",
    );
  }, 30_000);

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(extraDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("counts commits per file, newest window, deterministic ordering", async () => {
    const result = await run(repo, { action: "change_frequency" });
    expect(result).toMatchObject({
      status: "ok",
      action: "change_frequency",
      path: null,
      commitsRead: 4,
      shallow: false,
      window: { sinceDays: 365, since: "2025-10-29T00:00:00.000Z", oldestCommitDate: "2026-01-01" },
      truncated: { commits: false, entries: false, output: false, largeCommitsSkipped: 0 },
    });
    expect(result.entries).toEqual([
      { path: "src/a.ts", commits: 4 },
      { path: "src/b.ts", commits: 2 },
      { path: "big/0.txt", commits: 1 },
      { path: "big/1.txt", commits: 1 },
      { path: "big/2.txt", commits: 1 },
      { path: "big/3.txt", commits: 1 },
      { path: "big/4.txt", commits: 1 },
      { path: "docs/readme.md", commits: 1 },
      { path: "src/sp ace/ü.ts", commits: 1 },
    ]);
    const again = await run(repo, { action: "change_frequency" });
    expect(JSON.stringify(again)).toBe(JSON.stringify(result));
  });

  it("groups by folder at the requested depth", async () => {
    const depth1 = await run(repo, { action: "change_frequency", group_by: "folder", depth: 1 });
    expect(depth1.entries).toEqual([
      { path: "src", commits: 4 },
      { path: "big", commits: 1 },
      { path: "docs", commits: 1 },
    ]);
    const depth2 = await run(repo, { action: "change_frequency", group_by: "folder" });
    expect(depth2.entries).toEqual([
      { path: "src", commits: 4 },
      { path: "big", commits: 1 },
      { path: "docs", commits: 1 },
      { path: "src/sp ace", commits: 1 },
    ]);
  });

  it("limits frequency to a path and to the since window", async () => {
    const scoped = await run(repo, { action: "change_frequency", path: "src/b.ts" });
    expect(scoped.entries).toEqual([{ path: "src/b.ts", commits: 2 }]);
    const recent = await run(repo, { action: "change_frequency", since_days: 250 });
    expect(recent.commitsRead).toBe(2);
  });

  it("lists sanitized subjects newest first without emails", async () => {
    const result = await run(repo, { action: "recent_subjects" });
    const entries = result.entries as { commit: string; date: string; subject: string }[];
    expect(entries.map((e) => e.date)).toEqual([
      "2026-04-01",
      "2026-03-01",
      "2026-02-01",
      "2026-01-01",
    ]);
    expect(entries[0]?.subject).toBe("Bulk import");
    expect(Array.from(entries[1]?.subject ?? "")).toHaveLength(160);
    expect(entries[1]?.subject.endsWith("…")).toBe(true);
    expect(entries[2]?.subject).toBe("Fix bug reported by [email] now");
    for (const entry of entries) expect(entry.commit).toMatch(/^[0-9a-f]{4,}$/);
  });

  it("reports co-changed files, skipping large commits", async () => {
    const result = await run(
      repo,
      { action: "co_changes", path: "src/a.ts" },
      { largeCommitFiles: 3 },
    );
    expect(result.entries).toEqual([
      { path: "src/b.ts", commits: 2 },
      { path: "docs/readme.md", commits: 1 },
      { path: "src/sp ace/ü.ts", commits: 1 },
    ]);
    expect(result.truncated).toMatchObject({ largeCommitsSkipped: 1 });
    await expect(run(repo, { action: "co_changes" })).rejects.toThrow(/requires path/);
  });

  it("never returns author identity, emails or diff text", async () => {
    for (const args of [
      { action: "change_frequency" },
      { action: "recent_subjects" },
      { action: "co_changes", path: "src/a.ts" },
    ]) {
      const text = JSON.stringify(await run(repo, args));
      expect(text).not.toMatch(/@|Secret Author|diff --git|\+\+\+|@@/);
    }
  });

  it("caps commits, entries and output size", async () => {
    const commits = await run(repo, { action: "recent_subjects", max_commits: 2 });
    expect(commits.commitsRead).toBe(2);
    expect(commits.truncated).toMatchObject({ commits: true });
    expect(commits.window).toMatchObject({ oldestCommitDate: "2026-03-01" });

    const entries = await run(repo, { action: "change_frequency", limit: 2 });
    expect(entries.entries).toHaveLength(2);
    expect(entries.truncated).toMatchObject({ entries: true });

    const tool = createGitHistoryTool(repo, { now: () => NOW, limits: { maxOutputChars: 600 } });
    const text = String(await tool.execute({ action: "change_frequency" }, context()));
    expect(text.length).toBeLessThanOrEqual(600);
    const parsed = JSON.parse(text) as { entries: unknown[]; truncated: { output: boolean } };
    expect(parsed.truncated.output).toBe(true);
    expect(parsed.entries.length).toBeLessThan(9);

    expect(await run(repo, { action: "change_frequency" }, { maxBuffer: 4 })).toMatchObject({
      status: "unavailable",
      reason: "output-too-large",
    });
  });

  it("reports the overall time limit plainly", async () => {
    expect(await run(repo, { action: "change_frequency" }, { overallTimeoutMs: 1 })).toMatchObject({
      status: "unavailable",
      reason: "timed-out",
    });
  });

  it("rejects when cancelled before or during the call", async () => {
    const pre = new AbortController();
    pre.abort();
    await expect(
      run(repo, { action: "change_frequency" }, undefined, pre.signal),
    ).rejects.toThrow();

    const mid = new AbortController();
    const pending = run(repo, { action: "change_frequency" }, undefined, mid.signal);
    setTimeout(() => mid.abort(), 0);
    await expect(pending).rejects.toThrow();
  });

  it("reports a non-git folder and an empty repository plainly", async () => {
    const plain = await mkdtemp(path.join(tmpdir(), "gg-git-history-plain-"));
    const empty = await mkdtemp(path.join(tmpdir(), "gg-git-history-empty-"));
    extraDirs.push(plain, empty);
    await initRepo(empty);
    expect(await run(plain, { action: "change_frequency" })).toMatchObject({
      status: "unavailable",
      reason: "not-a-git-repository",
    });
    expect(await run(empty, { action: "recent_subjects" })).toMatchObject({
      status: "unavailable",
      reason: "no-commits",
    });
  });

  it("rejects traversal, option injection, pathspec magic and unknown keys before running git", async () => {
    const missing = path.join(tmpdir(), "gg-git-history-does-not-exist");
    for (const bad of [
      "../x",
      "a/../../x",
      "./src",
      ".git/config",
      "src/.GIT/x",
      "--output=x",
      "-p",
      ":(glob)**",
      ":/",
      "src\0x",
      "",
    ]) {
      await expect(
        run(missing, { action: "change_frequency", path: bad }),
        JSON.stringify(bad),
      ).rejects.toThrow();
    }
    await expect(
      run(missing, { action: "change_frequency", revision: "HEAD~1" }),
    ).rejects.toThrow();
    await expect(run(missing, { action: "change_frequency", since_days: 0 })).rejects.toThrow();
    await expect(run(missing, { action: "change_frequency", max_commits: 1001 })).rejects.toThrow();
  });

  it("accepts Windows separators and rejects Windows absolute forms", async () => {
    expect(validateHistoryPath("src\\a.ts")).toBe("src/a.ts");
    expect(validateHistoryPath("src/")).toBe("src");
    for (const bad of ["C:\\x", "C:x", "c:/x", "\\\\srv\\s", "/etc", "\\x"]) {
      expect(() => validateHistoryPath(bad), bad).toThrow();
    }
    const result = await run(repo, { action: "co_changes", path: "src\\b.ts" });
    expect(result).toMatchObject({ status: "ok", path: "src/b.ts" });
    if (process.platform === "win32") expect(repo).toContain("\\");
  });

  it("stays inside a subfolder cwd", async () => {
    const result = await run(path.join(repo, "src"), { action: "change_frequency" });
    expect(result.entries).toEqual([
      { path: "a.ts", commits: 4 },
      { path: "b.ts", commits: 2 },
      { path: "sp ace/ü.ts", commits: 1 },
    ]);
  });

  it("ignores an inherited GIT_DIR pointing at another repository", async () => {
    const other = await mkdtemp(path.join(tmpdir(), "gg-git-history-other-"));
    extraDirs.push(other);
    await initRepo(other);
    await commit(other, { "elsewhere.txt": "1" }, "Elsewhere", "2026-05-01T10:00:00Z");
    vi.stubEnv("GIT_DIR", path.join(other, ".git"));
    const result = await run(repo, { action: "change_frequency" });
    expect(result.commitsRead).toBe(4);
    expect(JSON.stringify(result)).not.toContain("elsewhere");
  });
});
