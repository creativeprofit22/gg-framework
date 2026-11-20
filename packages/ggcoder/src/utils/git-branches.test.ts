import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isGitBranchListResponse } from "@kenkaiiii/gg-core/git-branch-contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listGitBranches,
  orderLocalBranches,
  parseBranchRefs,
  parseReflogCheckouts,
} from "./git-branches.js";

const baseEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "GG Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "GG Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** Plain git for fixture setup; `at` pins author, committer and reflog time. */
function git(cwd: string, args: string[], options: { at?: number; input?: string } = {}): string {
  const env =
    options.at === undefined
      ? baseEnv
      : {
          ...baseEnv,
          GIT_AUTHOR_DATE: `@${options.at} +0000`,
          GIT_COMMITTER_DATE: `@${options.at} +0000`,
        };
  return execFileSync("git", ["-c", "commit.gpgSign=false", "-c", "core.hooksPath=", ...args], {
    cwd,
    env,
    input: options.input,
    encoding: "utf8",
  }).trim();
}

const T0 = 1_700_000_000;
const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();

let base: string;
let repo: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "gg-branches-")));
  repo = path.join(base, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: baseEnv });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function commit(message: string, at: number): void {
  git(repo, ["commit", "-q", "--allow-empty", "-m", message], { at });
}

async function listOk(options: Parameters<typeof listGitBranches>[1] = {}) {
  const result = await listGitBranches(repo, options);
  expect(isGitBranchListResponse(result)).toBe(true);
  if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
  return result;
}

describe("parsers", () => {
  it("parseBranchRefs keeps full names under the prefix", () => {
    const stdout = [
      "refs/heads/feature/a/b\x001700000000\x00origin/feature/a/b",
      "refs/heads/main\x00\x00",
      "refs/tags/v1\x001700000000\x00",
      "",
    ].join("\n");
    expect(parseBranchRefs(stdout, "refs/heads/")).toEqual([
      { name: "feature/a/b", commitTime: 1_700_000_000, upstream: "origin/feature/a/b" },
      { name: "main", commitTime: null, upstream: null },
    ]);
  });

  it("parseReflogCheckouts keeps each target's newest checkout", () => {
    const stdout = [
      "HEAD@{300}\x00checkout: moving from main to feat",
      "HEAD@{250}\x00commit: work",
      "HEAD@{200}\x00checkout: moving from feat to main",
      "HEAD@{100}\x00checkout: moving from main to feat",
      "garbage line",
    ].join("\r\n");
    expect([...parseReflogCheckouts(stdout)]).toEqual([
      ["feat", 300],
      ["main", 200],
    ]);
  });

  it("orderLocalBranches pins current, then recency, then name", () => {
    const refs = [
      { name: "old", commitTime: 100, upstream: null },
      { name: "b-none", commitTime: null, upstream: null },
      { name: "a-none", commitTime: null, upstream: null },
      { name: "main", commitTime: 50, upstream: null },
      { name: "checked", commitTime: 100, upstream: null },
    ];
    const ordered = orderLocalBranches(refs, new Map([["checked", 500]]), "main");
    expect(ordered.map((branch) => branch.name)).toEqual([
      "main",
      "checked",
      "old",
      "a-none",
      "b-none",
    ]);
    expect(ordered[0]!.current).toBe(true);
    expect(ordered[1]!.lastUsedAt).toBe(iso(500));
    expect(ordered[3]!.lastUsedAt).toBeNull();
  });
});

describe("listGitBranches", { timeout: 60_000 }, () => {
  it("reports a folder outside any repo", async () => {
    const folder = path.join(base, "folder");
    await mkdir(folder);
    expect(await listGitBranches(folder)).toEqual({ status: "not-a-repo" });
    const plain = path.join(base, "plain");
    execFileSync("git", ["init", "-q", "--bare", plain], { env: baseEnv });
    // A bare repo has no work tree, so it is not a project branch list either.
    expect(await listGitBranches(plain)).toEqual({ status: "not-a-repo" });
  });

  it("lists the unborn branch of an empty repo", async () => {
    const result = await listOk();
    expect(result.current).toEqual({ name: "main", detached: false, commit: null });
    expect(result.hasCommits).toBe(false);
    expect(result.remote).toBeNull();
    expect(result.defaultBranch).toEqual({ name: "main", source: "fallback" });
    expect(result.local).toEqual([
      { name: "main", current: true, lastUsedAt: null, upstream: null },
    ]);
    expect(result.remoteOnly).toEqual([]);
  });

  it("orders by recent use, keeps slashed and tag-clashing names exact, no remote", async () => {
    commit("init", T0);
    git(repo, ["branch", "feature/a/b"], { at: T0 + 10 });
    git(repo, ["branch", "v1"], { at: T0 + 10 });
    git(repo, ["tag", "v1"], { at: T0 + 10 });
    git(repo, ["checkout", "-q", "feature/a/b"], { at: T0 + 100 });
    git(repo, ["checkout", "-q", "v1"], { at: T0 + 200 });
    git(repo, ["checkout", "-q", "main"], { at: T0 + 300 });

    const result = await listOk();
    expect(result.remote).toBeNull();
    expect(result.remoteOnly).toEqual([]);
    expect(result.current.name).toBe("main");
    expect(result.current.detached).toBe(false);
    expect(result.current.commit).toMatch(/^[0-9a-f]{4,}$/);
    expect(result.hasCommits).toBe(true);
    expect(result.defaultBranch).toEqual({ name: "main", source: "fallback" });
    expect(result.local).toEqual([
      { name: "main", current: true, lastUsedAt: iso(T0 + 300), upstream: null },
      { name: "v1", current: false, lastUsedAt: iso(T0 + 200), upstream: null },
      { name: "feature/a/b", current: false, lastUsedAt: iso(T0 + 100), upstream: null },
    ]);
  });

  it("reports detached HEAD", async () => {
    commit("one", T0);
    commit("two", T0 + 1);
    git(repo, ["checkout", "-q", "--detach", "HEAD~1"], { at: T0 + 2 });
    const result = await listOk();
    expect(result.current.detached).toBe(true);
    expect(result.current.name).toBeNull();
    expect(result.current.commit).toMatch(/^[0-9a-f]{4,}$/);
    expect(result.local.map((branch) => [branch.name, branch.current])).toEqual([["main", false]]);
  });

  it("lists remote-only branches and reads the default from origin/HEAD", async () => {
    commit("init", T0);
    const sha = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["remote", "add", "origin", path.join(base, "nowhere.git")]);
    git(repo, ["checkout", "-q", "-b", "develop"], { at: T0 + 5 });
    git(repo, ["checkout", "-q", "main"], { at: T0 + 6 });
    git(repo, ["update-ref", "refs/remotes/origin/main", sha]);
    git(repo, ["update-ref", "refs/remotes/origin/develop", sha]);
    git(repo, ["checkout", "-q", "--detach"], { at: T0 + 7 });
    commit("newer", T0 + 50);
    git(repo, ["update-ref", "refs/remotes/origin/release/2", "HEAD"]);
    git(repo, ["checkout", "-q", "main"], { at: T0 + 60 });
    git(repo, ["update-ref", "refs/remotes/origin/old", sha]);
    git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop"]);
    git(repo, ["branch", "--set-upstream-to=origin/main", "main"]);

    const result = await listOk();
    expect(result.remote).toBe("origin");
    expect(result.defaultBranch).toEqual({ name: "develop", source: "remote-head" });
    expect(result.local.find((branch) => branch.name === "main")?.upstream).toBe("origin/main");
    expect(result.remoteOnly).toEqual([
      { name: "release/2", remoteRef: "origin/release/2", lastCommitAt: iso(T0 + 50) },
      { name: "old", remoteRef: "origin/old", lastCommitAt: iso(T0) },
    ]);
    expect(result.remoteOnlyTotal).toBe(2);

    git(repo, ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
    git(repo, ["branch", "-m", "main", "trunk"], { at: T0 + 70 });
    const fallback = await listOk();
    // origin/main still exists, so the fallback finds it on the remote.
    expect(fallback.defaultBranch).toEqual({ name: "main", source: "fallback" });
    expect(fallback.remoteOnly.map((branch) => branch.name)).toContain("main");
  });

  it("caps, searches and counts a 600-branch repo", async () => {
    commit("init", T0);
    const sha = git(repo, ["rev-parse", "HEAD"]);
    const names = Array.from(
      { length: 600 },
      (_, index) => `topic/${String(index).padStart(3, "0")}`,
    );
    git(repo, ["update-ref", "--stdin"], {
      input: names.map((name) => `create refs/heads/${name} ${sha}\n`).join(""),
    });

    const capped = await listOk();
    expect(capped.local).toHaveLength(50);
    expect(capped.local[0]!.name).toBe("main");
    expect(capped.localTotal).toBe(601);
    expect(capped.truncated).toBe(true);

    const big = await listOk({ limit: 10_000 });
    expect(big.local).toHaveLength(200);
    expect(big.truncated).toBe(true);

    const search = await listOk({ query: "  TOPIC/05 ", limit: 5 });
    expect(search.local.map((branch) => branch.name)).toEqual([
      "topic/050",
      "topic/051",
      "topic/052",
      "topic/053",
      "topic/054",
    ]);
    expect(search.localTotal).toBe(10);
    expect(search.truncated).toBe(true);

    const exact = await listOk({ query: "topic/599" });
    expect(exact.local.map((branch) => branch.name)).toEqual(["topic/599"]);
    expect(exact.localTotal).toBe(1);
    expect(exact.truncated).toBe(false);
  });

  it("stops when the caller aborts", async () => {
    commit("init", T0);
    const controller = new AbortController();
    controller.abort();
    await expect(listGitBranches(repo, { signal: controller.signal })).rejects.toThrow();
  });
});
