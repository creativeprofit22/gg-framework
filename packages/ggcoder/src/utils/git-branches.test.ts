import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  isGitBranchCreateResponse,
  isGitBranchListResponse,
  isGitBranchSwitchResponse,
} from "@kenkaiiii/gg-core/git-branch-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundGitError } from "./git.js";
import type * as GitModule from "./git.js";

const failReflog = vi.hoisted(() => ({ on: false }));
vi.mock("./git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof GitModule>();
  return {
    ...actual,
    runBackgroundGit: (
      args: readonly string[],
      options: Parameters<typeof actual.runBackgroundGit>[1],
    ) =>
      failReflog.on && args[0] === "reflog"
        ? Promise.reject(
            new actual.BackgroundGitError("Command failed: git reflog", {
              code: null,
              killed: true,
              stdout: "",
              stderr: "",
            }),
          )
        : actual.runBackgroundGit(args, options),
  };
});
import {
  checkGitBranchName,
  createGitBranch,
  InvalidGitBranchNameError,
  listGitBranches,
  orderLocalBranches,
  parseBranchRefs,
  parseCheckoutClashFiles,
  parseReflogCheckouts,
  switchGitBranch,
  unquoteGitPath,
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
  failReflog.on = false;
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

describe("switch parsers", () => {
  it("parseCheckoutClashFiles reads tracked, untracked and removed blocks", () => {
    const stderr = [
      "error: Your local changes to the following files would be overwritten by checkout:",
      "\ta.txt",
      "\tdir/b.txt",
      "Please commit your changes or stash them before you switch branches.",
      "error: The following untracked working tree files would be overwritten by checkout:",
      "\t" + String.raw`"caf\303\251.txt"`,
      "error: The following untracked working tree files would be removed by checkout:",
      "\told.txt",
      "Aborting",
    ].join("\n");
    expect(parseCheckoutClashFiles(stderr)).toEqual(["a.txt", "dir/b.txt", "café.txt", "old.txt"]);
    expect(parseCheckoutClashFiles("fatal: something else\n")).toEqual([]);
  });

  it("unquoteGitPath decodes C-style quoting and leaves plain paths alone", () => {
    expect(unquoteGitPath("plain.txt")).toBe("plain.txt");
    expect(unquoteGitPath(String.raw`"tab\there \"q\" \\"`)).toBe('tab\there "q" \\');
  });
});

describe("switchGitBranch", { timeout: 60_000 }, () => {
  async function put(file: string, content: string, cwd = repo): Promise<void> {
    await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
    await writeFile(path.join(cwd, file), content);
  }
  const read = (file: string): Promise<string> => readFile(path.join(repo, file), "utf8");
  const head = (): string => git(repo, ["symbolic-ref", "--short", "HEAD"]);
  const porcelain = (): string => git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]);

  async function commitAll(message: string, at: number): Promise<void> {
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", message], { at });
  }

  /** main: a.txt=base, shared.txt; feature: a.txt=feature, adds only-feature.txt. */
  async function twoBranches(): Promise<void> {
    await put("a.txt", "base\n");
    await put("shared.txt", "shared\n");
    await commitAll("init", T0);
    git(repo, ["checkout", "-q", "-b", "feature"], { at: T0 + 1 });
    await put("a.txt", "feature\n");
    await put("only-feature.txt", "new\n");
    await commitAll("feature work", T0 + 2);
    git(repo, ["checkout", "-q", "main"], { at: T0 + 3 });
  }

  async function switchTo(branch: string) {
    const result = await switchGitBranch(repo, branch);
    expect(isGitBranchSwitchResponse(result)).toBe(true);
    return result;
  }

  it("switches cleanly to a local branch", async () => {
    await twoBranches();
    expect(await switchTo("feature")).toEqual({
      status: "switched",
      from: "main",
      to: "feature",
      trackedRemote: null,
      carriedChanges: false,
    });
    expect(head()).toBe("feature");
    expect((await read("a.txt")).trim()).toBe("feature");
  });

  it("carries uncommitted changes that don't clash", async () => {
    await twoBranches();
    await put("shared.txt", "edited\n");
    await put("scratch.txt", "untracked\n");
    const result = await switchTo("feature");
    expect(result).toMatchObject({ status: "switched", carriedChanges: true });
    expect(head()).toBe("feature");
    expect((await read("shared.txt")).trim()).toBe("edited");
    expect((await read("scratch.txt")).trim()).toBe("untracked");
  });

  it("refuses a clash with nothing changed and lists the files", async () => {
    await twoBranches();
    await put("a.txt", "local edit\n");
    const statusBefore = porcelain();
    const contentBefore = await read("a.txt");
    const result = await switchTo("feature");
    expect(result).toMatchObject({ status: "conflict", files: ["a.txt"], filesTruncated: false });
    if (result.status === "conflict") expect(result.reason).toContain('stay on "main"');
    expect(head()).toBe("main");
    expect(porcelain()).toBe(statusBefore);
    expect(await read("a.txt")).toBe(contentBefore);
  });

  it("refuses when an untracked file would be overwritten", async () => {
    await twoBranches();
    await put("only-feature.txt", "mine\n");
    const result = await switchTo("feature");
    expect(result).toMatchObject({ status: "conflict", files: ["only-feature.txt"] });
    expect(head()).toBe("main");
    expect((await read("only-feature.txt")).trim()).toBe("mine");
  });

  it("lists unresolved merge conflicts", async () => {
    await twoBranches();
    git(repo, ["checkout", "-q", "-b", "other"], { at: T0 + 4 });
    await put("a.txt", "other\n");
    await commitAll("other", T0 + 5);
    expect(() => git(repo, ["merge", "-q", "feature"], { at: T0 + 6 })).toThrow();
    const midMerge = await switchTo("main");
    expect(midMerge).toMatchObject({ status: "conflict", files: ["a.txt"] });
    if (midMerge.status === "conflict") expect(midMerge.reason).toContain("merge is still");
    expect(head()).toBe("other");
    // Conflicts left in the index without a merge in progress.
    git(repo, ["merge", "--quit"]);
    const unresolved = await switchTo("main");
    expect(unresolved).toMatchObject({ status: "conflict", files: ["a.txt"] });
    if (unresolved.status === "conflict") {
      expect(unresolved.reason).toContain("unfinished merge conflicts");
    }
    expect(head()).toBe("other");
  });

  async function withOrigin(): Promise<void> {
    await twoBranches();
    const origin = path.join(base, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", origin], { env: baseEnv });
    git(repo, ["remote", "add", "origin", origin]);
    git(repo, ["checkout", "-q", "-b", "remote-only"], { at: T0 + 10 });
    await put("a.txt", "remote\n");
    await commitAll("remote work", T0 + 11);
    git(repo, ["checkout", "-q", "main"], { at: T0 + 12 });
    git(repo, ["push", "-q", "origin", "main", "remote-only"]);
    git(repo, ["branch", "-q", "-D", "remote-only"]);
    git(repo, ["fetch", "-q", "origin"]);
  }

  it("creates a local branch tracking a GitHub-only branch", async () => {
    await withOrigin();
    expect(await switchTo("remote-only")).toEqual({
      status: "switched",
      from: "main",
      to: "remote-only",
      trackedRemote: "origin/remote-only",
      carriedChanges: false,
    });
    expect(head()).toBe("remote-only");
    expect(git(repo, ["rev-parse", "--abbrev-ref", "remote-only@{upstream}"])).toBe(
      "origin/remote-only",
    );
    expect((await read("a.txt")).trim()).toBe("remote");
  });

  it("creates no local branch when a GitHub-only switch clashes", async () => {
    await withOrigin();
    await put("a.txt", "local edit\n");
    expect(await switchTo("remote-only")).toMatchObject({ status: "conflict", files: ["a.txt"] });
    expect(head()).toBe("main");
    expect(() =>
      git(repo, ["rev-parse", "--verify", "--quiet", "refs/heads/remote-only"]),
    ).toThrow();
  });

  it("reports unknown branches, already-current branches and non-repos", async () => {
    await twoBranches();
    expect(await switchTo("nope")).toMatchObject({ status: "not-found" });
    expect(await switchTo("main")).toEqual({ status: "unchanged", branch: "main" });
    const outside = path.join(base, "plain");
    await mkdir(outside);
    expect(await switchGitBranch(outside, "main")).toEqual({ status: "not-a-repo" });
  });

  it("rejects invalid names without touching the repo", async () => {
    await twoBranches();
    for (const name of ["-x", "--force", "bad..name", "@{-1}", "HEAD", "a b", ""]) {
      await expect(switchGitBranch(repo, name)).rejects.toBeInstanceOf(InvalidGitBranchNameError);
    }
    expect(head()).toBe("main");
  });
});

describe("createGitBranch", { timeout: 60_000 }, () => {
  const head = (): string => git(repo, ["symbolic-ref", "--short", "HEAD"]);
  const localBranches = (): string[] =>
    git(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])
      .split(/\r?\n/)
      .filter(Boolean)
      .sort();

  async function create(name: string) {
    const result = await createGitBranch(repo, name);
    expect(isGitBranchCreateResponse(result)).toBe(true);
    return result;
  }

  async function check(name: string) {
    const result = await checkGitBranchName(repo, name);
    expect(isGitBranchCreateResponse(result)).toBe(true);
    return result;
  }

  it("creates from the current commit and switches to it", async () => {
    commit("init", T0);
    const tip = git(repo, ["rev-parse", "HEAD"]);
    expect(await create("feature/new")).toEqual({
      status: "created",
      from: "main",
      to: "feature/new",
      carriedChanges: false,
    });
    expect(head()).toBe("feature/new");
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(tip);
    expect(localBranches()).toEqual(["feature/new", "main"]);
  });

  it("carries uncommitted changes", async () => {
    await writeFile(path.join(repo, "a.txt"), "base\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "init"], { at: T0 });
    await writeFile(path.join(repo, "a.txt"), "edited\n");
    await writeFile(path.join(repo, "scratch.txt"), "untracked\n");
    expect(await create("wip")).toMatchObject({ status: "created", carriedChanges: true });
    expect(head()).toBe("wip");
    expect((await readFile(path.join(repo, "a.txt"), "utf8")).trim()).toBe("edited");
    expect((await readFile(path.join(repo, "scratch.txt"), "utf8")).trim()).toBe("untracked");
  });

  it("never overwrites an existing local branch, including the current one", async () => {
    commit("init", T0);
    git(repo, ["branch", "taken"]);
    commit("later", T0 + 1);
    const takenTip = git(repo, ["rev-parse", "taken"]);
    for (const name of ["taken", "main"]) {
      const result = await create(name);
      expect(result.status).toBe("taken");
      if (result.status === "taken") expect(result.reason).toContain(`"${name}" already exists`);
    }
    expect(await check("Taken")).toMatchObject({ status: "taken" });
    expect(head()).toBe("main");
    expect(git(repo, ["rev-parse", "taken"])).toBe(takenTip);
  });

  it("treats the unborn current branch of an empty repo as taken", async () => {
    expect(await check("main")).toMatchObject({ status: "taken" });
    expect(await check("other")).toEqual({ status: "available", branch: "other" });
  });

  it("refuses folder/file clashes with an existing branch", async () => {
    commit("init", T0);
    git(repo, ["branch", "feature/x"]);
    git(repo, ["branch", "solo"]);
    for (const [name, clash] of [
      ["feature", "feature/x"],
      ["solo/sub", "solo"],
    ] as const) {
      const result = await create(name);
      expect(result.status).toBe("taken");
      if (result.status === "taken") expect(result.reason).toContain(`"${clash}"`);
    }
    expect(await check("feature/y")).toEqual({ status: "available", branch: "feature/y" });
    expect(head()).toBe("main");
    expect(localBranches()).toEqual(["feature/x", "main", "solo"]);
  });

  it("rejects invalid names with a plain reason and creates nothing", async () => {
    commit("init", T0);
    for (const name of ["a b", "bad..name", "-x", "--force", "HEAD", "@{-1}", "ends.lock", ""]) {
      const result = await create(name);
      expect(result.status).toBe("invalid");
      if (result.status === "invalid") expect(result.reason.length).toBeGreaterThan(0);
    }
    expect(head()).toBe("main");
    expect(localBranches()).toEqual(["main"]);
  });

  it("check-only creates nothing", async () => {
    commit("init", T0);
    expect(await check("fresh")).toEqual({ status: "available", branch: "fresh" });
    expect(await check("a b")).toMatchObject({ status: "invalid" });
    expect(head()).toBe("main");
    expect(localBranches()).toEqual(["main"]);
  });

  it("allows a name that exists only on origin and doesn't track it", async () => {
    commit("init", T0);
    const sha = git(repo, ["rev-parse", "HEAD"]);
    git(repo, ["remote", "add", "origin", path.join(base, "nowhere.git")]);
    git(repo, ["update-ref", "refs/remotes/origin/shared", sha]);
    expect(await check("shared")).toEqual({ status: "available", branch: "shared" });
    expect(await create("shared")).toMatchObject({ status: "created", to: "shared" });
    expect(() => git(repo, ["rev-parse", "--abbrev-ref", "shared@{upstream}"])).toThrow();
  });

  it("refuses mid-merge with nothing changed", async () => {
    await writeFile(path.join(repo, "a.txt"), "base\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "init"], { at: T0 });
    git(repo, ["checkout", "-q", "-b", "side"], { at: T0 + 1 });
    await writeFile(path.join(repo, "a.txt"), "side\n");
    git(repo, ["commit", "-q", "-am", "side"], { at: T0 + 2 });
    git(repo, ["checkout", "-q", "main"], { at: T0 + 3 });
    await writeFile(path.join(repo, "a.txt"), "main\n");
    git(repo, ["commit", "-q", "-am", "main"], { at: T0 + 4 });
    expect(() => git(repo, ["merge", "-q", "side"], { at: T0 + 5 })).toThrow();
    const result = await create("escape");
    expect(result).toMatchObject({ status: "conflict", files: ["a.txt"] });
    expect(head()).toBe("main");
    expect(localBranches()).toEqual(["main", "side"]);
  });

  it("reports a folder outside any repo", async () => {
    const outside = path.join(base, "plain");
    await mkdir(outside);
    expect(await createGitBranch(outside, "x")).toEqual({ status: "not-a-repo" });
  });
});

// Regression: a timed-out reflog read (only used for recent-use order) failed the whole list.
describe("listGitBranches when the reflog read fails", { timeout: 60_000 }, () => {
  it("still lists branches and reports the failure", async () => {
    commit("init", T0);
    git(repo, ["branch", "feature"], { at: T0 + 10 });
    failReflog.on = true;
    const errors: unknown[] = [];
    const result = await listOk({ onReflogError: (error) => errors.push(error) });
    expect(result.local.map((branch) => branch.name)).toEqual(["main", "feature"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(BackgroundGitError);
  });
});
