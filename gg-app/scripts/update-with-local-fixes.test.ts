import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  GG_APP_TARGETED_VITEST_PATHS,
  normalPushArgs,
  targetedVitestArgs,
  verifyLocalForkIdentity,
} from "./update-with-local-fixes.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const script = join(here, "update-with-local-fixes.mjs");
const temporaryDirectories: string[] = [];

function tempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function configureRepository(repo: string): void {
  git(repo, "config", "user.email", "local-update-test@example.com");
  git(repo, "config", "user.name", "Local Update Test");
}

function writeIdentityFixture(repo: string): void {
  write(join(repo, ".gitignore"), ".gg/\ngg-app/src-tauri/target/\n");
  write(join(repo, "package.json"), '{"private":true}\n');
  write(join(repo, "gg-app/package.json"), '{"version":"1.2.3"}\n');
  write(join(repo, "gg-app/index.html"), "<title>Supah Coder</title>\n");
  write(
    join(repo, "gg-app/vite.config.ts"),
    'const customBuildLabel = "Supah Coder Local Fork";\n',
  );
  write(join(repo, "gg-app/src/brand.ts"), 'export const PRODUCT_DISPLAY_NAME = "Supah Coder";\n');
  write(
    join(repo, "gg-app/src/update-policy.ts"),
    'const startLocalPatchedUpdate = () => {}; function route() { startLocalPatchedUpdate(); return "local-patched"; }\n',
  );
  write(
    join(repo, "gg-app/src-tauri/Cargo.toml"),
    '[package]\nname = "gg-app"\nversion = "1.2.3"\n',
  );
  write(
    join(repo, "gg-app/src-tauri/Cargo.lock"),
    '[[package]]\nname = "gg-app"\nversion = "1.2.3"\n',
  );
  write(
    join(repo, "gg-app/src-tauri/tauri.conf.json"),
    `${JSON.stringify(
      {
        productName: "GG Coder",
        version: "1.2.3",
        identifier: "com.ggcoder.app",
        bundle: {
          createUpdaterArtifacts: true,
          windows: { nsis: { installerHooks: "windows/nsis-hooks.nsh" } },
        },
        plugins: {
          updater: {
            pubkey: "test-public-key",
            endpoints: [
              "https://github.com/KenKaiii/gg-framework/releases/latest/download/latest.json",
            ],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  write(
    join(repo, "gg-app/src-tauri/tauri.local.conf.json"),
    `${JSON.stringify(
      {
        productName: "GG Coder Local Fork",
        identifier: "com.ggcoder.local-fork",
        mainBinaryName: "gg-coder-local-fork",
        bundle: {
          createUpdaterArtifacts: false,
          windows: { nsis: { installMode: "currentUser" } },
        },
        plugins: { updater: { endpoints: [] } },
      },
      null,
      2,
    )}\n`,
  );
}

// Real package commands, Vitest and Cargo exercise a tiny workspace, not the real checkout.
function writeCheckedWorkspace(repo: string): void {
  write(join(repo, ".gitignore"), ".gg/\nnode_modules/\ngg-app/src-tauri/target/\n");
  write(join(repo, "pnpm-workspace.yaml"), "packages:\n  - gg-app\n  - packages/*\n");
  write(
    join(repo, "assert-merge.cjs"),
    [
      'const assert = require("node:assert/strict");',
      'const { readFileSync, appendFileSync } = require("node:fs");',
      'const { join } = require("node:path");',
      'const text = readFileSync(join(__dirname, "shared.txt"), "utf8");',
      "assert.match(text, /local one/);",
      "assert.match(text, /upstream eleven/);",
      'appendFileSync(join(__dirname, ".gg/checks-run.log"), "passed\\n");',
    ].join("\n"),
  );
  for (const name of ["gg-ai", "gg-agent", "gg-core", "ggcoder", "gg-app"]) {
    const dir = name === "gg-app" ? name : `packages/${name}`;
    const command = `node ${name === "gg-app" ? ".." : "../.."}/assert-merge.cjs`;
    write(
      join(repo, dir, "package.json"),
      JSON.stringify({
        name: name === "gg-app" ? name : `@kenkaiiii/${name}`,
        version: "1.2.3",
        scripts: Object.fromEntries(
          ["build", "check", "lint", "format:check"].map((key) => [key, command]),
        ),
      }),
    );
  }
  write(
    join(repo, "gg-app/vitest.config.mjs"),
    "export default { test: { globals: true, fileParallelism: false } };\n",
  );
  for (const path of GG_APP_TARGETED_VITEST_PATHS) {
    write(
      join(repo, "gg-app", path),
      [
        'import { readFileSync } from "node:fs";',
        'it("checks the integrated source", () => {',
        '  const text = readFileSync("../shared.txt", "utf8");',
        '  expect(text).toContain("local one");',
        '  expect(text).toContain("upstream eleven");',
        "});",
      ].join("\n"),
    );
  }
  write(
    join(repo, "gg-app/src-tauri/src/lib.rs"),
    '#[test]\nfn integrated_source() { let text = include_str!("../../../shared.txt"); assert!(text.contains("local one") && text.contains("upstream eleven")); }\n',
  );
  write(
    join(repo, "gg-app/src-tauri/Cargo.lock"),
    'version = 4\n[[package]]\nname = "gg-app"\nversion = "1.2.3"\n',
  );
}

function checkedEnvironment(fixture: Fixture): NodeJS.ProcessEnv {
  const bin = join(fixture.root, "bin");
  mkdirSync(bin, { recursive: true });
  const vitest = join(repoRoot, "gg-app/node_modules/vitest/vitest.mjs");
  if (process.platform === "win32") {
    write(
      join(bin, "vitest.cmd"),
      `@echo off\r\n"${process.execPath}" "${vitest}" %*\r\nexit /b %errorlevel%\r\n`,
    );
  } else {
    const launcher = join(bin, "vitest");
    write(launcher, `#!/bin/sh\nexec "${process.execPath}" "${vitest}" "$@"\n`);
    chmodSync(launcher, 0o755);
  }
  return { PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}` };
}

interface Fixture {
  root: string;
  repo: string;
  upstream: string;
  origin: string;
  initialDirtyStatus: string;
}

function createUpdateFixture(
  conflict = false,
  meaningfulOverlap = false,
  checked = false,
): Fixture {
  const root = tempDir("gg-local-update-");
  const upstream = join(root, "upstream.git");
  const origin = join(root, "origin.git");
  const repo = join(root, "work");
  mkdirSync(repo);
  git(root, "init", "--bare", upstream);
  git(root, "init", "--bare", origin);
  git(repo, "init", "--initial-branch", "main");
  configureRepository(repo);
  writeIdentityFixture(repo);
  if (checked) writeCheckedWorkspace(repo);
  write(
    join(repo, "shared.txt"),
    meaningfulOverlap
      ? "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\n"
      : "base\n",
  );
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  git(repo, "remote", "add", "upstream", upstream);
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "upstream", "main");
  git(repo, "push", "origin", "main");

  git(repo, "switch", "-c", "custom/local-customizations");
  const localPath = conflict || meaningfulOverlap ? "shared.txt" : "local-one.txt";
  const localContents = conflict
    ? "local\n"
    : meaningfulOverlap
      ? "local one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\n"
      : "one\n";
  write(join(repo, localPath), localContents);
  git(repo, "add", ".");
  git(repo, "commit", "-m", "local one");
  git(repo, "push", "-u", "origin", "custom/local-customizations");
  write(join(repo, "local-two.txt"), "two\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "local two unpushed");

  git(repo, "switch", "main");
  const upstreamPath = conflict || meaningfulOverlap ? "shared.txt" : "upstream.txt";
  const upstreamContents = conflict
    ? "upstream\n"
    : meaningfulOverlap
      ? "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\nupstream eleven\n"
      : "advance\n";
  write(join(repo, upstreamPath), upstreamContents);
  git(repo, "add", ".");
  git(repo, "commit", "-m", "upstream advance");
  git(repo, "push", "upstream", "main");
  git(repo, "switch", "custom/local-customizations");

  write(join(repo, "local-two.txt"), "two\ndirty tracked\n");
  write(join(repo, "dirty-untracked.txt"), "dirty untracked\n");
  const initialDirtyStatus = git(repo, "status", "--porcelain=v1", "--untracked-files=all");
  return { root, repo, upstream, origin, initialDirtyStatus };
}

function createLocalOnlyFixture(): Fixture {
  const root = tempDir("gg-local-only-update-");
  const upstream = join(root, "upstream.git");
  const origin = join(root, "origin.git");
  const repo = join(root, "work");
  mkdirSync(repo);
  git(root, "init", "--bare", upstream);
  git(root, "init", "--bare", origin);
  git(repo, "init", "--initial-branch", "main");
  configureRepository(repo);
  writeIdentityFixture(repo);
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  git(repo, "remote", "add", "upstream", upstream);
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "upstream", "main");
  git(repo, "push", "origin", "main");
  git(repo, "switch", "-c", "custom/local-only");

  return { root, repo, upstream, origin, initialDirtyStatus: "" };
}

function runUpdater(repo: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GG_LOCAL_UPDATE_REPO_ROOT: repo, ...env },
  });
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { force: true, recursive: true });
  }
});

describe("local-fixes updater", () => {
  it("generates a direct Vitest command limited to the requested files", () => {
    const requestedFiles = ["src/first.test.ts", "src/second.test.ts"];

    const args = targetedVitestArgs("gg-app", requestedFiles);

    expect(args).toEqual(["--filter", "gg-app", "exec", "vitest", "run", ...requestedFiles]);
    expect(args).not.toContain("test");
    expect(args).not.toContain("--");
    expect(args.slice(5)).toEqual(requestedFiles);
    expect(() => targetedVitestArgs("gg-app", [])).toThrow("without explicit test files");
  });

  it("pins protected gg-app verification to the targeted regression files", () => {
    expect(GG_APP_TARGETED_VITEST_PATHS).toEqual([
      "scripts/update-with-local-fixes.test.ts",
      "scripts/decisions-classifier.test.ts",
      "scripts/build-local-hotfix.test.ts",
      "scripts/build-local-hotfix.identity.test.mjs",
      "scripts/smoke-built-local-fork.test.mjs",
      "scripts/vite-config.test.ts",
      "src/brand-static.test.ts",
      "src/HomeScreen.test.tsx",
      "src/local-update-confirmation.test.ts",
      "src/update-policy.test.ts",
      "src/update.test.tsx",
    ]);
    expect(targetedVitestArgs("gg-app", GG_APP_TARGETED_VITEST_PATHS)).toEqual([
      "--filter",
      "gg-app",
      "exec",
      "vitest",
      "run",
      ...GG_APP_TARGETED_VITEST_PATHS,
    ]);
  });

  it("dry-runs without changing a named-branch checkout", () => {
    const fixture = createLocalOnlyFixture();
    const before = {
      head: git(fixture.repo, "rev-parse", "HEAD"),
      refs: git(fixture.repo, "for-each-ref", "--format=%(refname) %(objectname)"),
      status: git(fixture.repo, "status", "--porcelain=v1", "--untracked-files=all"),
    };
    const result = runUpdater(fixture.repo, [
      "--dry-run",
      "--no-install",
      "--no-build",
      "--check",
      "--allow-other-branch",
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Push: disabled");
    expect(result.stdout).toContain("git merge --no-ff --no-commit <resolved-source-commit>");
    expect(result.stdout).not.toContain("git rebase");
    expect({
      head: git(fixture.repo, "rev-parse", "HEAD"),
      refs: git(fixture.repo, "for-each-ref", "--format=%(refname) %(objectname)"),
      status: git(fixture.repo, "status", "--porcelain=v1", "--untracked-files=all"),
    }).toEqual(before);
  }, 15_000);

  // This integration path performs multiple synchronous Git operations under parallel suite load.
  it("allows a local-only override branch when origin has no matching ref", () => {
    const fixture = createLocalOnlyFixture();
    const result = runUpdater(fixture.repo, [
      "--allow-other-branch",
      "--no-install",
      "--no-build",
      "--no-check",
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("continuing without push eligibility");
    expect(result.stdout).not.toMatch(/^> git push/m);
  }, 15_000);

  it("does not print nonexistent recovery artifacts when the source fetch fails", () => {
    const fixture = createUpdateFixture();
    git(fixture.repo, "remote", "set-url", "upstream", join(fixture.root, "missing.git"));
    const result = runUpdater(fixture.repo, ["--no-install", "--no-build", "--no-check"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Failed to fetch upstream/main");
    expect(result.stderr).not.toContain("Backup branch:");
    expect(result.stderr).not.toContain("Manifest:");
  }, 30_000);

  it("pins a reviewed commit despite a newer remote tip and stays up-to-date on retry", () => {
    const fixture = createUpdateFixture(false, true);
    const pin = git(fixture.repo, "rev-parse", "main");
    const startingHead = git(fixture.repo, "rev-parse", "HEAD");
    const advance = join(fixture.root, "advance");
    git(fixture.root, "clone", "--branch", "main", fixture.upstream, advance);
    configureRepository(advance);
    write(join(advance, "unreviewed.txt"), "not approved\n");
    git(advance, "add", ".");
    git(advance, "commit", "-m", "unreviewed advance");
    git(advance, "push", "origin", "main");
    const newer = git(advance, "rev-parse", "HEAD");
    const args = ["--source-commit", pin, "--no-install", "--no-build", "--no-check"];
    const result = runUpdater(fixture.repo, args);
    expect(result.status, result.stderr).toBe(0);
    const mergedHead = git(fixture.repo, "rev-parse", "HEAD");
    expect(
      git(fixture.repo, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").slice(1),
    ).toEqual([startingHead, pin]);
    expect(git(fixture.repo, "rev-parse", "upstream/main")).toBe(newer);
    expect(existsSync(join(fixture.repo, "unreviewed.txt"))).toBe(false);
    const retry = runUpdater(fixture.repo, args);
    expect(retry.status, retry.stderr).toBe(0);
    expect(git(fixture.repo, "rev-parse", "HEAD")).toBe(mergedHead);
    expect(retry.stdout).toContain("Already up to date");
    const backupRoot = join(fixture.repo, ".gg", "local-fixes", "backups");
    expect(readdirSync(backupRoot)).toHaveLength(2);
    for (const dir of readdirSync(backupRoot)) {
      const manifest = JSON.parse(readFileSync(join(backupRoot, dir, "manifest.json"), "utf8"));
      expect(existsSync(join(backupRoot, dir, "decisions.json"))).toBe(false);
      expect(manifest).toMatchObject({
        sourceOid: pin,
        decisionMerge: mergedHead,
        verified: false,
        checks: "skipped",
        phase: "source-updated-unverified",
      });
      expect(manifest.mergeBase).toBe(git(fixture.repo, "merge-base", manifest.startingHead, pin));
      expect(manifest.installer).toBeNull();
    }
    expect(git(fixture.repo, "status", "--porcelain=v1", "--untracked-files=all")).toBe(
      fixture.initialDirtyStatus,
    );
    expect(readFileSync(join(fixture.repo, "local-two.txt"), "utf8")).toBe("two\ndirty tracked\n");
    expect(readFileSync(join(fixture.repo, "dirty-untracked.txt"), "utf8")).toBe(
      "dirty untracked\n",
    );
    expect(git(fixture.repo, "stash", "list")).toBe("");
    expect(result.stdout).not.toContain("build:local-patched");
    expect(result.stdout).not.toMatch(/^> git push/m);
  }, 30_000);

  it.each(["short", "missing", "blob", "unrelated"])(
    "rejects a %s pin before disturbing dirty work",
    (kind) => {
      const fixture = createUpdateFixture();
      const head = git(fixture.repo, "rev-parse", "HEAD");
      const pin =
        kind === "short"
          ? "abc123"
          : kind === "missing"
            ? "f".repeat(40)
            : kind === "blob"
              ? git(fixture.repo, "rev-parse", "HEAD:local-two.txt")
              : head;
      const beforeBranches = git(
        fixture.repo,
        "for-each-ref",
        "refs/heads",
        "--format=%(refname) %(objectname)",
      );
      const result = runUpdater(fixture.repo, [
        "--source-commit",
        pin,
        "--no-install",
        "--no-build",
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        kind === "short"
          ? "full 40-character hex commit ID"
          : kind === "unrelated"
            ? "must be an ancestor"
            : "existing commit",
      );
      expect(git(fixture.repo, "rev-parse", "HEAD")).toBe(head);
      expect(
        git(fixture.repo, "for-each-ref", "refs/heads", "--format=%(refname) %(objectname)"),
      ).toBe(beforeBranches);
      expect(git(fixture.repo, "status", "--porcelain=v1", "--untracked-files=all")).toBe(
        fixture.initialDirtyStatus,
      );
      expect(readFileSync(join(fixture.repo, "local-two.txt"), "utf8")).toBe(
        "two\ndirty tracked\n",
      );
      expect(readFileSync(join(fixture.repo, "dirty-untracked.txt"), "utf8")).toBe(
        "dirty untracked\n",
      );
      expect(git(fixture.repo, "stash", "list")).toBe("");
      expect(existsSync(join(fixture.repo, ".gg"))).toBe(false);
      expect(result.stdout).not.toMatch(/^> git (?:stash |merge |branch (?!--show-current))/m);
    },
    30_000,
  );

  it("dry-runs a pin without fetching or changing refs or dirty bytes", () => {
    const fixture = createUpdateFixture();
    const refs = git(fixture.repo, "show-ref");
    const result = runUpdater(fixture.repo, [
      "--source-commit",
      git(fixture.repo, "rev-parse", "main"),
      "--dry-run",
      "--no-install",
      "--no-build",
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(git(fixture.repo, "show-ref")).toBe(refs);
    expect(git(fixture.repo, "status", "--porcelain=v1", "--untracked-files=all")).toBe(
      fixture.initialDirtyStatus,
    );
    expect(existsSync(join(fixture.repo, ".gg"))).toBe(false);
  }, 30_000);

  it("restores dirty work and omits decisions when merged paths do not overlap", () => {
    const fixture = createUpdateFixture();
    const localHead = git(fixture.repo, "rev-parse", "HEAD");
    const sourceHead = git(fixture.repo, "rev-parse", "upstream/main");
    const localCommits = git(
      fixture.repo,
      "log",
      "--reverse",
      "--no-merges",
      "--format=%H%x09%s",
      "upstream/main..HEAD",
    ).split(/\r?\n/);
    const result = runUpdater(fixture.repo, ["--no-install", "--no-build", "--no-check"]);

    expect(result.status, result.stderr).toBe(0);
    const integratedLocalCommits = git(
      fixture.repo,
      "log",
      "--reverse",
      "--no-merges",
      "--format=%H%x09%s",
      "upstream/main..HEAD",
    ).split(/\r?\n/);
    expect(integratedLocalCommits).toEqual(localCommits);
    expect(integratedLocalCommits.map((line) => line.split("\t").slice(1).join("\t"))).toEqual([
      "local one",
      "local two unpushed",
    ]);
    expect(
      git(fixture.repo, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").slice(1),
    ).toEqual([localHead, sourceHead]);
    expect(git(fixture.repo, "show", "-s", "--format=%s", "HEAD")).toBe(
      "Merge upstream/main into custom/local-customizations",
    );
    expect(git(fixture.repo, "status", "--porcelain=v1", "--untracked-files=all")).toBe(
      fixture.initialDirtyStatus,
    );
    expect(readFileSync(join(fixture.repo, "local-two.txt"), "utf8")).toBe("two\ndirty tracked\n");
    expect(readFileSync(join(fixture.repo, "dirty-untracked.txt"), "utf8")).toBe(
      "dirty untracked\n",
    );
    expect(git(fixture.repo, "stash", "list")).toBe("");
    const backupBranches = git(fixture.repo, "branch", "--format=%(refname:short)")
      .split(/\r?\n/)
      .filter((name) => name.startsWith("gg-local-before-update-"));
    expect(backupBranches).toHaveLength(1);
    const backupRoot = join(fixture.repo, ".gg", "local-fixes", "backups");
    const syncDir = join(backupRoot, readdirSync(backupRoot)[0]);
    const manifest = JSON.parse(readFileSync(join(syncDir, "manifest.json"), "utf8"));
    expect(manifest.verified).toBe(false);
    expect(manifest.checks).toBe("skipped");
    expect(manifest.phase).toBe("source-updated-unverified");
    expect(manifest.dirtyWorkApplied).toBe(true);
    expect(manifest.localCommits.map((commit: { subject: string }) => commit.subject)).toEqual([
      "local one",
      "local two unpushed",
    ]);
    expect(manifest).not.toHaveProperty("mergeCreated");
    expect(manifest).not.toHaveProperty("decisionsPath");
    expect(existsSync(join(syncDir, "decisions.json"))).toBe(false);
  }, 30_000);

  it.each([false, true])(
    "keeps skipped-check source updates unverified (summary opt-in: %s)",
    (summary) => {
      const fixture = createUpdateFixture(false, true);
      const result = runUpdater(fixture.repo, [
        "--no-install",
        "--no-build",
        "--no-check",
        ...(summary ? ["--decision-summary-context"] : []),
      ]);
      expect(result.status, result.stderr).toBe(0);
      const backupRoot = join(fixture.repo, ".gg/local-fixes/backups");
      const syncDir = join(backupRoot, readdirSync(backupRoot)[0]);
      const manifest = JSON.parse(readFileSync(join(syncDir, "manifest.json"), "utf8"));
      expect(manifest).toMatchObject({
        verified: false,
        checks: "skipped",
        phase: "source-updated-unverified",
        dirtyWorkApplied: true,
      });
      expect(existsSync(join(syncDir, "decisions.json"))).toBe(false);
      expect(existsSync(join(syncDir, "decision-summary-context.json"))).toBe(false);
      expect(result.stdout).toContain("checks skipped, outcome unverified");
      expect(result.stdout).not.toContain("Verified local merge complete");
      expect(result.stdout).not.toMatch(/^> git push/m);
      expect(git(fixture.repo, "status", "--porcelain=v1", "--untracked-files=all")).toBe(
        fixture.initialDirtyStatus,
      );
      expect(readFileSync(join(fixture.repo, "local-two.txt"), "utf8")).toBe(
        "two\ndirty tracked\n",
      );
      expect(readFileSync(join(fixture.repo, "dirty-untracked.txt"), "utf8")).toBe(
        "dirty untracked\n",
      );
      expect(git(fixture.repo, "stash", "list")).toBe("");
      expect(git(fixture.repo, "rev-parse", manifest.backupBranch)).toBe(manifest.startingHead);
    },
    30_000,
  );

  it("stores meaningful decisions only after real workspace checks pass", () => {
    const fixture = createUpdateFixture(false, true, true);
    const result = runUpdater(
      fixture.repo,
      ["--no-install", "--no-build", "--check"],
      checkedEnvironment(fixture),
    );

    expect(result.status, result.stderr).toBe(0);
    const backupRoot = join(fixture.repo, ".gg", "local-fixes", "backups");
    const syncDir = join(backupRoot, readdirSync(backupRoot)[0]);
    const manifest = JSON.parse(readFileSync(join(syncDir, "manifest.json"), "utf8"));
    const decisions = JSON.parse(readFileSync(join(syncDir, "decisions.json"), "utf8"));
    expect(manifest).toMatchObject({ verified: true, phase: "verified", checks: "passed" });
    expect(decisions.verification.checks).toBe("passed");
    expect(
      readFileSync(join(fixture.repo, ".gg/checks-run.log"), "utf8").trim().split("\n"),
    ).toHaveLength(7);
    expect(result.stdout).toContain("11 passed");
    expect(result.stdout).toContain("test integrated_source ... ok");
    expect(manifest).not.toHaveProperty("mergeCreated");
    expect(manifest).not.toHaveProperty("decisionsPath");
    expect(decisions.decisions).toEqual([
      expect.objectContaining({ area: "shared", outcome: "combined" }),
    ]);
    expect(decisions.verification.workflowVerified).toBe(true);
    expect(decisions).toMatchObject({
      schemaVersion: 3,
      summary: {
        text: "Your protected update is ready. It blended your work with upstream in one area, keeping changes from both sides.",
        source: "fallback",
        generatedAt: manifest.timestamp,
      },
    });
    expect(existsSync(join(syncDir, "decision-summary-context.json"))).toBe(false);
    expect(JSON.stringify(decisions)).not.toContain("rationale");
  }, 30_000);

  it("writes correlated summary context only after an opted-in verified overlap", () => {
    const fixture = createUpdateFixture(false, true, true);
    const result = runUpdater(
      fixture.repo,
      ["--no-install", "--no-build", "--check", "--decision-summary-context"],
      checkedEnvironment(fixture),
    );

    expect(result.status, result.stderr).toBe(0);
    const backupRoot = join(fixture.repo, ".gg", "local-fixes", "backups");
    const syncDir = join(backupRoot, readdirSync(backupRoot)[0]);
    const manifest = JSON.parse(readFileSync(join(syncDir, "manifest.json"), "utf8"));
    const decisions = JSON.parse(readFileSync(join(syncDir, "decisions.json"), "utf8"));
    const context = JSON.parse(
      readFileSync(join(syncDir, "decision-summary-context.json"), "utf8"),
    );
    expect(context.recordedAt).toBe(manifest.timestamp);
    expect(context.evidence).toEqual(decisions.evidence);
    expect(context.decisions).toHaveLength(decisions.decisions.length);
  }, 30_000);

  it.skipIf(process.platform !== "win32")(
    "keeps dirty bytes stashed through packaging and restores them afterward",
    () => {
      const fixture = createUpdateFixture();
      const bin = join(fixture.root, "bin");
      const buildStatusPath = join(fixture.root, "build-status.txt");
      mkdirSync(bin);
      write(
        join(bin, "fake-pnpm.cjs"),
        [
          'const { execFileSync } = require("node:child_process");',
          'const { mkdirSync, writeFileSync } = require("node:fs");',
          'const { join } = require("node:path");',
          'writeFileSync(process.env.GG_TEST_BUILD_STATUS, execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"]));',
          'const output = join(process.cwd(), "gg-app", "src-tauri", "target", "release", "bundle", "nsis");',
          "mkdirSync(output, { recursive: true });",
          'writeFileSync(join(output, "GG Coder Local Fork_1.2.3_x64-setup.exe"), "installer");',
        ].join("\n"),
      );
      write(
        join(bin, "pnpm.cmd"),
        `@echo off\r\n"${process.execPath}" "%~dp0fake-pnpm.cjs" %*\r\nexit /b %errorlevel%\r\n`,
      );

      const result = runUpdater(fixture.repo, ["--no-install", "--no-check"], {
        GG_TEST_BUILD_STATUS: buildStatusPath,
        PATH: `${bin};${process.env.PATH ?? ""}`,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(buildStatusPath, "utf8")).toBe("");
      expect(git(fixture.repo, "status", "--porcelain=v1", "--untracked-files=all")).toBe(
        fixture.initialDirtyStatus,
      );
      expect(readFileSync(join(fixture.repo, "local-two.txt"), "utf8")).toBe(
        "two\ndirty tracked\n",
      );
      expect(readFileSync(join(fixture.repo, "dirty-untracked.txt"), "utf8")).toBe(
        "dirty untracked\n",
      );
      expect(git(fixture.repo, "stash", "list")).toBe("");
    },
    30_000,
  );

  it("stops on conflicts with the backup branch and dirty-work stash intact", () => {
    const fixture = createUpdateFixture(true);
    const result = runUpdater(fixture.repo, ["--no-install", "--no-build", "--no-check"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Merge stopped for manual semantic conflict review");
    expect(result.stderr).toContain("Backup branch:");
    expect(git(fixture.repo, "status", "--porcelain=v1")).toContain("UU shared.txt");
    expect(git(fixture.repo, "stash", "list")).toContain("gg local update");
    expect(
      git(fixture.repo, "branch", "--format=%(refname:short)")
        .split(/\r?\n/)
        .some((name) => name.startsWith("gg-local-before-update-")),
    ).toBe(true);
  }, 30_000);

  it("stops after a failed check without writing meaningful decisions", () => {
    const fixture = createUpdateFixture(false, true, true);
    const checkPath = join(fixture.repo, "assert-merge.cjs");
    write(checkPath, `${readFileSync(checkPath, "utf8")}\nassert.fail("fixture check failure");\n`);
    git(fixture.repo, "add", "assert-merge.cjs");
    git(fixture.repo, "commit", "-m", "introduce failing fixture assertion");
    const result = runUpdater(
      fixture.repo,
      [
        "--source-commit",
        git(fixture.repo, "rev-parse", "main"),
        "--no-install",
        "--no-build",
        "--decision-summary-context",
      ],
      checkedEnvironment(fixture),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("build failed");
    expect(result.stderr).toContain("Backup branch:");
    expect(result.stdout).not.toContain("build:local-patched");
    expect(result.stdout).not.toMatch(/^> git push/m);
    expect(git(fixture.repo, "stash", "list")).toContain("gg local update");
    const backupRoot = join(fixture.repo, ".gg", "local-fixes", "backups");
    const syncDir = join(backupRoot, readdirSync(backupRoot)[0]);
    const manifest = JSON.parse(readFileSync(join(syncDir, "manifest.json"), "utf8"));
    expect(manifest.phase).toBe("source-verified");
    expect(manifest.verified).toBe(false);
    expect(manifest.checks).toBe("failed");
    expect(existsSync(join(syncDir, "decision-summary-context.json"))).toBe(false);
    expect(manifest).not.toHaveProperty("mergeCreated");
    expect(manifest).not.toHaveProperty("decisionsPath");
    expect(existsSync(join(syncDir, "decisions.json"))).toBe(false);
    expect(manifest.dirtyWorkApplied).toBe(true);
    expect(git(fixture.repo, "status", "--porcelain=v1", "--untracked-files=all")).toBe(
      fixture.initialDirtyStatus,
    );
    expect(readFileSync(join(fixture.repo, "local-two.txt"), "utf8")).toBe("two\ndirty tracked\n");
    expect(readFileSync(join(fixture.repo, "dirty-untracked.txt"), "utf8")).toBe(
      "dirty untracked\n",
    );
  }, 30_000);

  it("records merge decisions when verification succeeds after remediation", () => {
    const fixture = createUpdateFixture(false, true, true);
    const bin = join(fixture.root, "failing-bin");
    mkdirSync(bin);
    if (process.platform === "win32") {
      write(join(bin, "pnpm.cmd"), "@echo off\r\nexit /b 7\r\n");
    } else {
      const fakePnpm = join(bin, "pnpm");
      write(fakePnpm, "#!/bin/sh\nexit 7\n");
      chmodSync(fakePnpm, 0o755);
    }
    const failed = runUpdater(fixture.repo, ["--no-install", "--no-build"], {
      PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
    });
    expect(failed.status).toBe(1);
    const decisionMerge = git(fixture.repo, "rev-parse", "HEAD");
    write(join(fixture.repo, "remediation.txt"), "verified remediation\n");
    git(fixture.repo, "add", "remediation.txt");
    git(fixture.repo, "commit", "-m", "remediate verification");
    git(fixture.repo, "push", "origin", "custom/local-customizations");

    const retry = runUpdater(
      fixture.repo,
      ["--no-install", "--no-build", "--check"],
      checkedEnvironment(fixture),
    );

    expect(retry.status, retry.stderr).toBe(0);
    const backupRoot = join(fixture.repo, ".gg", "local-fixes", "backups");
    const syncDir = join(backupRoot, readdirSync(backupRoot).sort().at(-1)!);
    const manifest = JSON.parse(readFileSync(join(syncDir, "manifest.json"), "utf8"));
    const decisions = JSON.parse(readFileSync(join(syncDir, "decisions.json"), "utf8"));
    expect(manifest).toMatchObject({
      verified: true,
      decisionMerge,
    });
    expect(decisions.evidence.merge).toBe(decisionMerge);
    expect(decisions.verification.workflowVerified).toBe(true);
  }, 30_000);

  it.each(["--no-build", "--no-check"])("rejects push with %s", (disabled) => {
    const fixture = createLocalOnlyFixture();
    const result = runUpdater(fixture.repo, [
      "--source-commit",
      "a".repeat(40),
      "--dry-run",
      "--push",
      disabled,
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--push requires checks and installer build");
  });

  it("uses a normal push that rejects a concurrent remote update", () => {
    const root = tempDir("gg-local-push-");
    const origin = join(root, "origin.git");
    const local = join(root, "local");
    const other = join(root, "other");
    git(root, "init", "--bare", origin);
    mkdirSync(local);
    git(local, "init", "--initial-branch", "custom/local-customizations");
    configureRepository(local);
    write(join(local, "file.txt"), "base\n");
    git(local, "add", ".");
    git(local, "commit", "-m", "base");
    git(local, "remote", "add", "origin", origin);
    git(local, "push", "-u", "origin", "custom/local-customizations");

    git(root, "clone", "--branch", "custom/local-customizations", origin, other);
    configureRepository(other);
    write(join(other, "other.txt"), "concurrent\n");
    git(other, "add", ".");
    git(other, "commit", "-m", "concurrent update");
    git(other, "push", "origin", "custom/local-customizations");

    write(join(local, "local.txt"), "verified local\n");
    git(local, "add", ".");
    git(local, "commit", "-m", "verified local update");
    const rejected = spawnSync("git", normalPushArgs("custom/local-customizations"), {
      cwd: local,
      encoding: "utf8",
    });
    expect(rejected.status).not.toBe(0);
    expect(git(other, "rev-parse", "HEAD")).toBe(
      git(root, `--git-dir=${origin}`, "rev-parse", "refs/heads/custom/local-customizations"),
    );
  });
});

describe("local fork identity", () => {
  it("pins branding, native identity, updater feed, and version lockstep", () => {
    const { version } = JSON.parse(readFileSync(join(repoRoot, "gg-app/package.json"), "utf8")) as {
      version: string;
    };
    expect(verifyLocalForkIdentity(repoRoot)).toEqual({
      version,
      productName: "GG Coder Local Fork",
      identifier: "com.ggcoder.local-fork",
      mainBinaryName: "gg-coder-local-fork",
      executableName: "gg-coder-local-fork.exe",
      installMode: "currentUser",
    });
  });

  it("requires the local config to explicitly disable updater feeds and use current-user install", () => {
    const root = tempDir("gg-local-identity-");
    writeIdentityFixture(root);
    const configPath = join(root, "gg-app/src-tauri/tauri.local.conf.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      bundle: { windows: { nsis: { installMode?: string } } };
      plugins: { updater: { endpoints?: string[] } };
    };

    delete config.plugins.updater.endpoints;
    write(configPath, `${JSON.stringify(config, null, 2)}\n`);
    expect(() => verifyLocalForkIdentity(root)).toThrow("local updater endpoint");

    config.plugins.updater.endpoints = [];
    delete config.bundle.windows.nsis.installMode;
    write(configPath, `${JSON.stringify(config, null, 2)}\n`);
    expect(() => verifyLocalForkIdentity(root)).toThrow("local install mode");
  });
});
