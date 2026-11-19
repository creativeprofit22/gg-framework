import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  getGitHubBranch,
  gitHubBranchUrl,
  parseGitHubSlug,
  parseOriginBranchRefs,
  readOriginBranchRefs,
  resolveGitHubBranch,
} from "./github.js";

describe("parseGitHubSlug", () => {
  it("parses https remotes", () => {
    expect(parseGitHubSlug("https://github.com/kenkaiiii/gg-coder")).toBe("kenkaiiii/gg-coder");
    expect(parseGitHubSlug("https://github.com/kenkaiiii/gg-coder.git")).toBe("kenkaiiii/gg-coder");
    expect(parseGitHubSlug("https://user@github.com/o/r.git")).toBe("o/r");
    expect(parseGitHubSlug("http://github.com/o/r/")).toBe("o/r");
  });

  it("parses ssh remotes", () => {
    expect(parseGitHubSlug("git@github.com:kenkaiiii/gg-coder.git")).toBe("kenkaiiii/gg-coder");
    expect(parseGitHubSlug("git@github.com:o/r")).toBe("o/r");
    expect(parseGitHubSlug("ssh://git@github.com/o/r.git")).toBe("o/r");
  });

  it("rejects non-GitHub remotes and junk", () => {
    expect(parseGitHubSlug("https://gitlab.com/o/r.git")).toBeNull();
    expect(parseGitHubSlug("git@bitbucket.org:o/r.git")).toBeNull();
    expect(parseGitHubSlug("https://github.com/onlyowner")).toBeNull();
    expect(parseGitHubSlug("")).toBeNull();
    expect(parseGitHubSlug("not a url")).toBeNull();
  });
});

describe("gitHubBranchUrl", () => {
  it("keeps slashes and encodes each segment", () => {
    expect(gitHubBranchUrl("o/r", "feature/login")).toBe(
      "https://github.com/o/r/tree/feature/login",
    );
    expect(gitHubBranchUrl("o/r", "fix/#12 100% done")).toBe(
      "https://github.com/o/r/tree/fix/%2312%20100%25%20done",
    );
    expect(gitHubBranchUrl("o/r", "café/ü?x")).toBe(
      "https://github.com/o/r/tree/caf%C3%A9/%C3%BC%3Fx",
    );
  });
});

describe("resolveGitHubBranch", () => {
  const home = { gitHubBranchUrl: null, gitHubBranchOnGitHub: true };
  const unknown = { gitHubBranchUrl: null, gitHubBranchOnGitHub: null };
  const refs = (defaultBranch: string | null, branchExists: boolean) => ({
    defaultBranch,
    branchExists,
  });

  it("opens the branch page for a pushed non-default branch", () => {
    expect(
      resolveGitHubBranch({ slug: "o/r", branch: "feat/x", refs: refs("main", true) }),
    ).toEqual({
      gitHubBranchUrl: "https://github.com/o/r/tree/feat/x",
      gitHubBranchOnGitHub: true,
    });
  });

  it("says a branch missing from origin isn't on GitHub", () => {
    expect(resolveGitHubBranch({ slug: "o/r", branch: "wip", refs: refs("main", false) })).toEqual({
      gitHubBranchUrl: null,
      gitHubBranchOnGitHub: false,
    });
  });

  it("uses origin/HEAD for the default branch", () => {
    expect(
      resolveGitHubBranch({ slug: "o/r", branch: "develop", refs: refs("develop", true) }),
    ).toEqual(home);
    // With origin/HEAD set, main is just another branch.
    expect(
      resolveGitHubBranch({ slug: "o/r", branch: "main", refs: refs("develop", true) }),
    ).toMatchObject({ gitHubBranchUrl: "https://github.com/o/r/tree/main" });
  });

  it("falls back to main/master when origin/HEAD is missing", () => {
    expect(resolveGitHubBranch({ slug: "o/r", branch: "main", refs: refs(null, true) })).toEqual(
      home,
    );
    expect(resolveGitHubBranch({ slug: "o/r", branch: "master", refs: refs(null, false) })).toEqual(
      home,
    );
  });

  it("is unknown for a detached HEAD, no GitHub repo, no branch or failed git", () => {
    expect(resolveGitHubBranch({ slug: "o/r", branch: "HEAD", refs: refs("main", true) })).toEqual(
      unknown,
    );
    expect(resolveGitHubBranch({ slug: null, branch: "feat", refs: refs("main", true) })).toEqual(
      unknown,
    );
    expect(resolveGitHubBranch({ slug: "o/r", branch: null, refs: refs("main", true) })).toEqual(
      unknown,
    );
    expect(resolveGitHubBranch({ slug: "o/r", branch: "feat", refs: null })).toEqual(unknown);
  });
});

describe("parseOriginBranchRefs", () => {
  it("reads origin/HEAD's target and an exact branch match", () => {
    const out = "refs/remotes/origin/HEAD\trefs/remotes/origin/main\nrefs/remotes/origin/feat\t\n";
    expect(parseOriginBranchRefs(out, "feat")).toEqual({
      defaultBranch: "main",
      branchExists: true,
    });
  });

  it("ignores refs that only match as a prefix", () => {
    const out = "refs/remotes/origin/feat/sub\t\r\n";
    expect(parseOriginBranchRefs(out, "feat")).toEqual({
      defaultBranch: null,
      branchExists: false,
    });
  });
});

describe("readOriginBranchRefs", () => {
  const dirs: string[] = [];
  const git = promisify(execFile);
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("reads local remote-tracking refs, and returns null when git fails", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "gg-github-refs-"));
    dirs.push(cwd);
    await git("git", ["init", "-q", "-b", "trunk"], { cwd });
    await git(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"],
      { cwd },
    );
    for (const name of ["trunk", "feat/sub"]) {
      await git("git", ["update-ref", `refs/remotes/origin/${name}`, "HEAD"], { cwd });
    }
    await git("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"], {
      cwd,
    });

    expect(await readOriginBranchRefs(cwd, "feat/sub")).toEqual({
      defaultBranch: "trunk",
      branchExists: true,
    });
    expect(await readOriginBranchRefs(cwd, "feat")).toEqual({
      defaultBranch: "trunk",
      branchExists: false,
    });
    expect(await getGitHubBranch(cwd, "o/r", "feat/sub")).toEqual({
      gitHubBranchUrl: "https://github.com/o/r/tree/feat/sub",
      gitHubBranchOnGitHub: true,
    });
    expect(await readOriginBranchRefs(path.join(cwd, "missing"), "feat")).toBeNull();
  });
});
