#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const repoRoot = join(appDir, "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const SAFE_LOCAL_BRANCH = "custom/local-customizations-v2";
const READ_ONLY_SAFETY_BRANCH = "custom/local-customizations-safety";
const DEFAULT_REMOTE = "upstream";
const FALLBACK_REMOTE = "origin";
const DEFAULT_BRANCH = "main";

function usage() {
  return `Usage: node gg-app/scripts/update-with-local-fixes.mjs [options]

Rebases ${SAFE_LOCAL_BRANCH} on the selected upstream target, restores local work,
and optionally checks/builds a local-patched installer.

Options:
  --remote <name>        Git remote to fetch from (default: upstream, then origin)
  --branch <name>        Branch to rebase onto (default: main)
  --allow-other-branch   Allow running outside ${SAFE_LOCAL_BRANCH}
  --no-install           Skip refreshing platform-specific dependencies
  --no-build             Skip building the local-patched installer after updates
  --check                Run TypeScript checks after restoring local fixes
  --no-check             Keep TypeScript checks skipped (default)
  --dry-run              Print the workflow without mutating the repository
  -h, --help             Show this help
`;
}

function parseArgs(args) {
  const options = {
    remote: null,
    branch: null,
    allowOtherBranch: false,
    install: true,
    build: true,
    check: false,
    dryRun: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") continue;
    if (arg === "--remote" || arg === "--branch") {
      const value = args[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      options[arg.slice(2)] = value;
    } else if (arg === "--allow-other-branch") options.allowOtherBranch = true;
    else if (arg === "--no-install") options.install = false;
    else if (arg === "--no-build") options.build = false;
    else if (arg === "--check") options.check = true;
    else if (arg === "--no-check") options.check = false;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "-h" || arg === "--help") {
      console.log(usage());
      process.exit(0);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function formatCommand(command, args) {
  return [command, ...args].join(" ");
}

function run(command, args, options = {}) {
  if (options.dryRun) {
    console.log(`[dry-run] ${formatCommand(command, args)}`);
    return { status: 0, stdout: "", stderr: "" };
  }
  console.log(`> ${formatCommand(command, args)}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...(options.env ?? {}) },
    shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command),
    stdio: options.capture ? "pipe" : "inherit",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function capture(command, args, options = {}) {
  const result = run(command, args, { ...options, capture: true });
  if (result.status !== 0 && !options.allowFailure) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`${formatCommand(command, args)} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

function requireSuccess(result, message) {
  if (result.status !== 0) throw new Error(message);
}

function currentBranch() {
  return capture("git", ["branch", "--show-current"]).stdout.trim();
}

function ensureSafeBranch(options) {
  const branch = currentBranch();
  if (branch === READ_ONLY_SAFETY_BRANCH) {
    throw new Error(`${READ_ONLY_SAFETY_BRANCH} is read-only and can never be updated.`);
  }
  if (options.allowOtherBranch) {
    console.log(`Branch safety override enabled for ${branch || "(detached HEAD)"}.`);
    return;
  }
  if (branch !== SAFE_LOCAL_BRANCH) {
    throw new Error(
      `Refusing to update branch ${branch || "(detached HEAD)"}. Switch to ${SAFE_LOCAL_BRANCH}, or pass --allow-other-branch for an intentional override.`,
    );
  }
}

function gitRemotes() {
  const result = capture("git", ["remote"], { allowFailure: true });
  return result.status === 0
    ? result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
}

function defaultUpdateTarget() {
  const remotes = gitRemotes();
  const remote = remotes.includes(DEFAULT_REMOTE)
    ? DEFAULT_REMOTE
    : remotes.includes(FALLBACK_REMOTE)
      ? FALLBACK_REMOTE
      : null;
  if (!remote) throw new Error("No git remote found. Pass --remote and --branch explicitly.");
  return { remote, branch: DEFAULT_BRANCH };
}

function resolveGitPath(path) {
  return isAbsolute(path) ? path : join(repoRoot, path);
}

function gitPathExists(name) {
  const result = capture("git", ["rev-parse", "--git-path", name], { allowFailure: true });
  return (
    result.status === 0 && result.stdout.trim() && existsSync(resolveGitPath(result.stdout.trim()))
  );
}

function rebaseInProgress() {
  return (
    gitPathExists("rebase-merge") ||
    gitPathExists("rebase-apply") ||
    capture("git", ["rev-parse", "--verify", "REBASE_HEAD"], { allowFailure: true }).status === 0
  );
}

function operationInProgress() {
  if (rebaseInProgress()) return "rebase";
  for (const [name, ref] of [
    ["merge", "MERGE_HEAD"],
    ["cherry-pick", "CHERRY_PICK_HEAD"],
    ["revert", "REVERT_HEAD"],
  ]) {
    if (capture("git", ["rev-parse", "--verify", ref], { allowFailure: true }).status === 0)
      return name;
  }
  return null;
}

function hasUnresolvedConflicts() {
  return capture("git", ["diff", "--name-only", "--diff-filter=U"]).stdout.trim().length > 0;
}

function writeBackups(statusText) {
  const backupDir = join(repoRoot, ".gg", "local-fixes", "backups");
  mkdirSync(backupDir, { recursive: true });
  const patchPath = join(backupDir, `${timestamp}.patch`);
  const statusPath = join(backupDir, `${timestamp}-status.txt`);
  writeFileSync(patchPath, capture("git", ["diff", "--binary", "HEAD"]).stdout);
  writeFileSync(statusPath, statusText);
  return { patchPath, statusPath };
}

function createBackupBranch(options) {
  const branchName = `gg-local-before-update-${timestamp.replace(/[^0-9A-Za-z-]/g, "-")}`;
  requireSuccess(
    run("git", ["branch", branchName, "HEAD"], options),
    `Failed to create safety ref ${branchName}. No update was attempted.`,
  );
  console.log(`Saved current HEAD as safety ref: ${branchName}`);
  return branchName;
}

function normalizeFileLf(relativePath, options) {
  if (options.dryRun) {
    console.log(`[dry-run] normalize ${relativePath} to LF line endings`);
    return;
  }
  const filePath = join(repoRoot, relativePath);
  const text = readFileSync(filePath, "utf8");
  const normalized = text.replace(/\r\n?/g, "\n");
  if (normalized !== text) writeFileSync(filePath, normalized);
}

function buildWorkspaceSpine(options) {
  for (const packageName of ["@kenkaiiii/gg-ai", "@kenkaiiii/gg-agent", "@kenkaiiii/gg-core"]) {
    requireSuccess(
      run(pnpm, ["--filter", packageName, "build"], options),
      `${packageName} build failed after restoring local fixes.`,
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rootResult = capture("git", ["rev-parse", "--show-toplevel"], { allowFailure: true });
  if (rootResult.status !== 0) throw new Error("This script must run inside a git worktree.");

  const defaults = defaultUpdateTarget();
  const remote = options.remote ?? defaults.remote;
  const branch = options.branch ?? defaults.branch;
  if (branch === READ_ONLY_SAFETY_BRANCH) {
    throw new Error(`${READ_ONLY_SAFETY_BRANCH} is read-only and can never be an update target.`);
  }
  const target = `${remote}/${branch}`;
  console.log("GG local-fixes rebase workflow");
  console.log(`Repository: ${rootResult.stdout.trim()}`);
  console.log(`Update target: ${target}`);
  console.log(`Protected branch: ${SAFE_LOCAL_BRANCH}`);
  console.log(`Dependency refresh: ${options.install ? "enabled" : "skipped"}`);
  console.log(`Checks: ${options.check ? "enabled" : "skipped"}`);
  console.log(`Build: ${options.build ? "enabled" : "skipped"}`);

  ensureSafeBranch(options);
  const inProgress = operationInProgress();
  if (inProgress)
    throw new Error(`A git ${inProgress} is already in progress. Finish or abort it first.`);
  if (hasUnresolvedConflicts()) throw new Error("Resolve existing conflicts before updating.");

  const statusText = capture("git", ["status", "--porcelain"]).stdout;
  const hasLocalWork = statusText.trim().length > 0;
  const backupDir = join(repoRoot, ".gg", "local-fixes", "backups");
  const backupPatchPath = join(backupDir, `${timestamp}.patch`);
  if (options.dryRun) {
    console.log(`[dry-run] write tracked diff backup to ${backupPatchPath}`);
    console.log(
      `[dry-run] write git status backup to ${join(backupDir, `${timestamp}-status.txt`)}`,
    );
  } else {
    const backups = writeBackups(statusText);
    console.log(`Saved tracked diff backup: ${backups.patchPath}`);
    console.log(`Saved status backup: ${backups.statusPath}`);
  }

  const stashMessage = `gg-app local fixes before update ${timestamp}`;
  if (hasLocalWork) {
    requireSuccess(
      run("git", ["stash", "push", "--include-untracked", "-m", stashMessage], options),
      "Failed to stash local work. No update was attempted.",
    );
  } else console.log("No local work to stash.");

  try {
    requireSuccess(
      run(
        "git",
        ["fetch", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
        options,
      ),
      `Failed to fetch ${remote}/${branch}.`,
    );
    const safetyRef = createBackupBranch(options);
    const rebase = run("git", ["rebase", target], options);
    if (rebase.status !== 0) {
      throw new Error(
        `Rebase stopped. Resolve it and continue, or abort and recover from ${safetyRef}. Backup: ${backupPatchPath}`,
      );
    }
  } catch (error) {
    if (hasLocalWork && !rebaseInProgress() && !hasUnresolvedConflicts()) {
      console.error("Update did not complete; restoring stashed local work.");
      run("git", ["stash", "pop"], options);
    } else if (hasLocalWork) {
      console.error(`Local work remains stashed as: ${stashMessage}`);
    }
    throw error;
  }

  if (hasLocalWork) {
    requireSuccess(
      run("git", ["stash", "pop"], options),
      `Local work conflicted while restoring. Resolve it manually; backup: ${backupPatchPath}`,
    );
  }
  normalizeFileLf("gg-app/src-tauri/src/lib.rs", options);

  if (options.install) {
    requireSuccess(
      run(pnpm, ["install", "--frozen-lockfile", "--ignore-scripts"], {
        ...options,
        env: { CI: "true" },
      }),
      "Dependency refresh failed after updating source.",
    );
  }
  if (options.check || options.build) buildWorkspaceSpine(options);
  if (options.check) {
    requireSuccess(run(pnpm, ["--filter", "gg-app", "check"], options), "gg-app check failed.");
    requireSuccess(
      run(pnpm, ["--filter", "@kenkaiiii/ggcoder", "check"], options),
      "ggcoder check failed.",
    );
  }
  if (options.build) {
    requireSuccess(
      run(pnpm, ["--filter", "gg-app", "build:local-patched"], options),
      "Local-patched installer build failed.",
    );
  }
  console.log("Local fixes rebase workflow completed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
