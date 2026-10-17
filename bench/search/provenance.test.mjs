import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  checkTarget,
  coldSessionProblem,
  parseTarget,
  pilotSessionProblem,
  smokeSessionProblem,
  TOOL_FILES,
  treeVerifySchedule,
} from "./provenance.mjs";

describe("cold sessions never read the tree before measuring", () => {
  it("cold methods read only the manifest first and hash content afterwards", () => {
    for (const method of ["reboot", "standby-purge"]) {
      assert.deepEqual(treeVerifySchedule(method, { fastVerify: false }), {
        before: "manifest-only",
        perRun: "none",
        after: "full",
      });
    }
  });

  it("warm sessions keep the full up-front hash and per-run check", () => {
    assert.deepEqual(treeVerifySchedule("none"), { before: "full", perRun: "fast", after: "none" });
    assert.deepEqual(treeVerifySchedule("none", { fastVerify: true }).before, "fast");
  });

  it("excludes a cold session that hashed the tree before measuring", () => {
    // Shape written by the harness before this fix: full hash up front, no post check.
    const meta = { coldMethod: "reboot", tree: { hash: "h", verify: "full" } };
    assert.match(coldSessionProblem(meta), /read before the cold measurement/);
  });

  it("excludes a cold session without a passing post-run hash", () => {
    const tree = { hash: "h", before: "manifest-only" };
    assert.match(coldSessionProblem({ coldMethod: "reboot", tree }), /no post-run/);
    assert.match(
      coldSessionProblem({
        coldMethod: "reboot",
        tree: { ...tree, after: { ok: false, problems: ["size changed: a"] } },
      }),
      /size changed: a/,
    );
  });

  it("accepts a clean cold session and ignores warm sessions", () => {
    const tree = { hash: "h", before: "manifest-only", after: { ok: true, problems: [] } };
    assert.equal(coldSessionProblem({ coldMethod: "reboot", tree }), undefined);
    assert.equal(coldSessionProblem({ coldMethod: "none", tree: { verify: "full" } }), undefined);
  });
});

describe("smoke/debug sessions are not headline evidence", () => {
  const cases = [
    ["onlyCells", "cold/", /--only-cells cold\//],
    ["waves", 2, /--waves 2/],
    ["soakMs", 1000, /--soak-ms 1000/],
    ["openStepMs", 500, /--open-step-ms 500/],
  ];

  for (const [key, value, pattern] of cases) {
    it(`excludes a session recorded with overrides.${key}`, () => {
      assert.match(smokeSessionProblem({ overrides: { [key]: value } }), pattern);
    });
  }

  for (const [flag, value] of [
    ["--only-cells", "cold/"],
    ["--waves", "2"],
    ["--soak-ms", "1000"],
    ["--open-step-ms", "500"],
  ]) {
    it(`falls back to argv for older sessions (${flag})`, () => {
      const argv = ["--target", "b=E:/wt@df1a353", flag, value, "--session", "s"];
      assert.match(smokeSessionProblem({ argv }), new RegExp(`${flag} ${value}`));
    });
  }

  it("accepts a clean session; --fast-verify is informational only", () => {
    assert.equal(smokeSessionProblem({ overrides: {}, argv: [] }), undefined);
    assert.equal(smokeSessionProblem({ overrides: { fastVerify: true } }), undefined);
    assert.equal(
      smokeSessionProblem({ argv: ["--target", "b=E:/wt@df1a353", "--fast-verify"] }),
      undefined,
    );
    assert.equal(smokeSessionProblem({}), undefined);
  });

  it("trusts structured overrides over argv when both exist", () => {
    assert.equal(smokeSessionProblem({ overrides: {}, argv: ["--waves", "2"] }), undefined);
  });
});

describe("pilot sessions never count as headline evidence", () => {
  it("excludes the pilot profile", () => {
    assert.match(pilotSessionProblem({ profile: "pilot" }), /pilot profile/);
  });

  it("accepts quick and full profiles", () => {
    assert.equal(pilotSessionProblem({ profile: "quick" }), undefined);
    assert.equal(pilotSessionProblem({ profile: "full" }), undefined);
    assert.equal(pilotSessionProblem({}), undefined);
  });
});

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();

/** A throwaway git repo shaped like a target worktree with built tool files. */
async function makeRepo() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gg-search-prov-"));
  const src = path.join(dir, "packages", "ggcoder", "src", "tools");
  const dist = path.join(dir, "packages", "ggcoder", "dist", "tools");
  await mkdir(src, { recursive: true });
  await mkdir(dist, { recursive: true });
  for (const name of TOOL_FILES) {
    await writeFile(path.join(src, `${name}.ts`), `export const ${name} = 1;\n`);
    await writeFile(path.join(dist, `${name}.js`), `export const ${name} = 1;\n`);
  }
  // dist is normally gitignored; keep the fixture clean the same way.
  await writeFile(path.join(dir, ".gitignore"), "dist/\n");
  git(dir, "init", "-q");
  git(
    dir,
    "-c",
    "user.email=b@e.ch",
    "-c",
    "user.name=bench",
    "-c",
    "commit.gpgsign=false",
    "add",
    ".",
  );
  git(
    dir,
    "-c",
    "user.email=b@e.ch",
    "-c",
    "user.name=bench",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "init",
  );
  const future = new Date(Date.now() + 60_000);
  for (const name of TOOL_FILES) await utimes(path.join(dist, `${name}.js`), future, future);
  return { dir, sha: git(dir, "rev-parse", "HEAD"), src, dist };
}

describe("parseTarget", () => {
  it("parses label=path@sha", () => {
    const t = parseTarget("baseline=E:/wt/base@DF1A353");
    assert.equal(t.label, "baseline");
    assert.equal(t.expectedCommit, "df1a353");
    assert.equal(t.worktree, path.resolve("E:/wt/base"));
  });
  it("rejects missing sha or label", () => {
    assert.throws(() => parseTarget("E:/wt/base"));
    assert.throws(() => parseTarget("baseline=E:/wt/base"));
    assert.throws(() => parseTarget("bad label=x@abcdef1"));
  });
});

describe("checkTarget refusals", () => {
  let repo;
  before(async () => {
    repo = await makeRepo();
  });
  after(async () => {
    await rm(repo.dir, { recursive: true, force: true });
  });

  it("accepts a clean worktree at the expected commit with fresh dist", async () => {
    const r = await checkTarget(
      { label: "base", worktree: repo.dir, expectedCommit: repo.sha.slice(0, 7) },
      { treeCheck: { ok: true, treeHash: "h" } },
    );
    assert.deepEqual(r.reasons, []);
    assert.equal(r.ok, true);
    assert.equal(r.facts.commit, repo.sha);
    assert.equal(r.facts.dirty, false);
    assert.ok(r.facts.toolHashes.grep.dist.length === 64);
  });

  it("refuses a commit that does not match the label", async () => {
    const r = await checkTarget({ label: "base", worktree: repo.dir, expectedCommit: "0000000" });
    assert.equal(r.ok, false);
    assert.match(r.reasons.join("\n"), /commit mismatch/);
  });

  it("refuses a path that is not a git worktree", async () => {
    const r = await checkTarget({
      label: "base",
      worktree: path.join(repo.dir, "nope"),
      expectedCommit: repo.sha,
    });
    assert.equal(r.ok, false);
    assert.match(r.reasons.join("\n"), /not a git worktree/);
  });

  it("refuses a search-tree mismatch", async () => {
    const r = await checkTarget(
      { label: "base", worktree: repo.dir, expectedCommit: repo.sha },
      { treeCheck: { ok: false, treeHash: "h", problems: ["size changed: a"] } },
    );
    assert.equal(r.ok, false);
    assert.match(r.reasons.join("\n"), /search tree mismatch/);
  });

  it("refuses stale and missing build output", async () => {
    const past = new Date(Date.now() - 3_600_000);
    const grepJs = path.join(repo.dist, "grep.js");
    await utimes(grepJs, past, past);
    try {
      const r = await checkTarget({ label: "base", worktree: repo.dir, expectedCommit: repo.sha });
      assert.equal(r.ok, false);
      assert.match(r.reasons.join("\n"), /stale build output/);
    } finally {
      const future = new Date(Date.now() + 60_000);
      await utimes(grepJs, future, future);
    }
    await rm(path.join(repo.dist, "find.js"));
    try {
      const r = await checkTarget({ label: "base", worktree: repo.dir, expectedCommit: repo.sha });
      assert.equal(r.ok, false);
      assert.match(r.reasons.join("\n"), /missing build output/);
    } finally {
      await writeFile(path.join(repo.dist, "find.js"), "export const find = 1;\n");
      const future = new Date(Date.now() + 60_000);
      await utimes(path.join(repo.dist, "find.js"), future, future);
    }
  });

  it("refuses a dirty worktree", async () => {
    const file = path.join(repo.src, "grep.ts");
    await writeFile(file, "export const grep = 2;\n");
    try {
      const r = await checkTarget({ label: "base", worktree: repo.dir, expectedCommit: repo.sha });
      assert.equal(r.ok, false);
      assert.equal(r.facts.dirty, true);
      assert.match(r.reasons.join("\n"), /dirty/);
    } finally {
      git(repo.dir, "checkout", "--", ".");
    }
  });
});
