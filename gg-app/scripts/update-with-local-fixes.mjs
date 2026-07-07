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

function usage() {
  return `Usage: node gg-app/scripts/update-with-local-fixes.mjs [options]

Rebases custom/local-customizations on the selected upstream target, then reapplies
local work and optionally checks/builds the patched installer.

Options:
  --remote <name>        Git remote to fetch from (default: upstream, then origin)
  --branch <name>        Branch to rebase onto (default: main)
  --allow-other-branch   Allow running outside custom/local-customizations
  --no-install           Skip refreshing platform-specific dependencies
  --no-build             Skip building the local-patched installer after updates
  --check                Run TypeScript checks after reapplying local fixes
  --no-check             Keep TypeScript checks skipped (default)
  --dry-run              Print the planned workflow without mutating the repository
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
    if (arg === "--") {
      continue;
    }
    if (arg === "--remote") {
      const value = args[i + 1];
      if (!value) throw new Error("--remote requires a value");
      options.remote = value;
      i += 1;
    } else if (arg === "--branch") {
      const value = args[i + 1];
      if (!value) throw new Error("--branch requires a value");
      options.branch = value;
      i += 1;
    } else if (arg === "--allow-other-branch") {
      options.allowOtherBranch = true;
    } else if (arg === "--no-install") {
      options.install = false;
    } else if (arg === "--no-build") {
      options.build = false;
    } else if (arg === "--check") {
      options.check = true;
    } else if (arg === "--no-check") {
      options.check = false;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "-h" || arg === "--help") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function formatCommand(command, args) {
  return [command, ...args].join(" ");
}

function shouldUseShell(command) {
  return process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
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
    shell: shouldUseShell(command),
    stdio: options.capture ? "pipe" : "inherit",
    maxBuffer: 256 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
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
  if (result.status !== 0) {
    throw new Error(message);
  }
}

function normalizeLineEndings(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function normalizeFileLf(relativePath, options) {
  if (options.dryRun) {
    console.log(`[dry-run] normalize ${relativePath} to LF line endings`);
    return;
  }

  const filePath = join(repoRoot, relativePath);
  const text = readFileSync(filePath, "utf8");
  const normalized = normalizeLineEndings(text);
  if (normalized === text) return;

  writeFileSync(filePath, normalized);
  console.log(`Normalized ${relativePath} to LF line endings.`);
}

const SAFE_LOCAL_BRANCH = "custom/local-customizations";
const DEFAULT_REMOTE = "upstream";
const FALLBACK_REMOTE = "origin";
const DEFAULT_BRANCH = "main";

function currentBranch() {
  return capture("git", ["branch", "--show-current"]).stdout.trim();
}

function ensureSafeBranch(options) {
  if (options.allowOtherBranch) {
    console.log(`Branch safety override enabled: running outside ${SAFE_LOCAL_BRANCH}.`);
    return;
  }

  const branch = currentBranch();
  if (branch !== SAFE_LOCAL_BRANCH) {
    throw new Error(
      `Refusing to update branch ${branch || "(detached HEAD)"}. Switch to ${SAFE_LOCAL_BRANCH}, or pass --allow-other-branch if you intentionally want to rebase this branch.`,
    );
  }
}

function gitRemotes() {
  const result = capture("git", ["remote"], { allowFailure: true });
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function defaultUpdateTarget() {
  const remotes = gitRemotes();
  const remote = remotes.includes(DEFAULT_REMOTE)
    ? DEFAULT_REMOTE
    : remotes.includes(FALLBACK_REMOTE)
      ? FALLBACK_REMOTE
      : null;
  if (!remote) {
    throw new Error("No git remote found. Pass --remote and --branch to choose an update target.");
  }
  return {
    remote,
    branch: DEFAULT_BRANCH,
  };
}

function hasUnresolvedConflicts() {
  const result = capture("git", ["diff", "--name-only", "--diff-filter=U"]);
  return result.stdout.trim().length > 0;
}

function resolveGitPath(gitPath) {
  return isAbsolute(gitPath) ? gitPath : join(repoRoot, gitPath);
}

function gitPathExists(name) {
  const result = capture("git", ["rev-parse", "--git-path", name], { allowFailure: true });
  if (result.status !== 0) return false;
  const path = result.stdout.trim();
  return path ? existsSync(resolveGitPath(path)) : false;
}

function rebaseInProgress() {
  return (
    gitPathExists("rebase-merge") ||
    gitPathExists("rebase-apply") ||
    capture("git", ["rev-parse", "--verify", "REBASE_HEAD"], {
      allowFailure: true,
    }).status === 0
  );
}

function operationInProgress() {
  if (rebaseInProgress()) return "rebase";
  if (
    capture("git", ["rev-parse", "--verify", "MERGE_HEAD"], { allowFailure: true }).status === 0
  ) {
    return "merge";
  }
  if (
    capture("git", ["rev-parse", "--verify", "CHERRY_PICK_HEAD"], { allowFailure: true }).status ===
    0
  ) {
    return "cherry-pick";
  }
  return null;
}

function gitStatusPorcelain() {
  return capture("git", ["status", "--porcelain"]).stdout;
}

function refNameSafeTimestamp() {
  return timestamp.replace(/[^0-9A-Za-z-]/g, "-");
}

function createBackupBranch(options) {
  const branchName = `gg-local-before-update-${refNameSafeTimestamp()}`;
  requireSuccess(
    run("git", ["branch", branchName, "HEAD"], options),
    `Failed to create backup branch ${branchName}. No update was attempted.`,
  );
  console.log(`Saved current HEAD as backup branch: ${branchName}`);
  return branchName;
}

function rebaseUpdateTarget(target, options, backupPatchPath) {
  const backupBranch = createBackupBranch(options);
  const rebase = run("git", ["rebase", target], options);
  if (rebase.status === 0) return backupBranch;

  throw new Error(
    `Rebase onto ${target} stopped for manual resolution. Resolve conflicts, run \`git add <files>\`, then \`git rebase --continue\`. If the script reported stashed local work, run \`git stash pop\` after the rebase completes. To recover instead, run \`git rebase --abort\`, switch back to the printed backup branch (${backupBranch}), or apply the backup patch at ${backupPatchPath}.`,
  );
}

function writeBackups(statusText) {
  const backupDir = join(repoRoot, ".gg", "local-fixes", "backups");
  mkdirSync(backupDir, { recursive: true });

  const patchPath = join(backupDir, `${timestamp}.patch`);
  const statusPath = join(backupDir, `${timestamp}-status.txt`);
  const diff = capture("git", ["diff", "--binary", "HEAD"]).stdout;

  writeFileSync(patchPath, diff);
  writeFileSync(statusPath, statusText);

  return { patchPath, statusPath };
}

function printNativeDependencyHint(error) {
  const text = String(error instanceof Error ? error.message : error);
  if (text.includes("Cannot find module") || text.includes("native") || text.includes("optional")) {
    console.error(
      "\nIf this is a WSL/Windows native optional-dependency mismatch, run `pnpm install --frozen-lockfile` and let pnpm recreate platform-specific modules if it asks.",
    );
  }
}

function buildWorkspaceSpine(options) {
  const packages = ["@kenkaiiii/gg-ai", "@kenkaiiii/gg-agent", "@kenkaiiii/gg-core"];
  for (const packageName of packages) {
    requireSuccess(
      run(pnpm, ["--filter", packageName, "build"], options),
      `${packageName} build failed after reapplying local fixes.`,
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const rootResult = capture("git", ["rev-parse", "--show-toplevel"], { allowFailure: true });
  if (rootResult.status !== 0) {
    throw new Error("This script must be run inside a git worktree.");
  }

  const defaults = defaultUpdateTarget();
  const remote = options.remote ?? defaults.remote;
  const branch = options.branch ?? defaults.branch;
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
  if (inProgress) {
    throw new Error(
      `A git ${inProgress} is already in progress. Finish or abort it before updating.`,
    );
  }
  if (hasUnresolvedConflicts()) {
    throw new Error("Unresolved conflicts are present. Resolve them before updating.");
  }

  const statusText = gitStatusPorcelain();
  const hasLocalWork = statusText.trim().length > 0;
  const backupPatchPath = join(repoRoot, ".gg", "local-fixes", "backups", `${timestamp}.patch`);

  if (options.dryRun) {
    console.log(`[dry-run] write tracked diff backup to ${backupPatchPath}`);
    console.log(
      `[dry-run] write git status backup to ${join(
        repoRoot,
        ".gg",
        "local-fixes",
        "backups",
        `${timestamp}-status.txt`,
      )}`,
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
  } else {
    console.log("No local work to stash.");
  }

  try {
    requireSuccess(
      run(
        "git",
        ["fetch", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
        options,
      ),
      `Failed to fetch ${remote} ${branch}. Check the remote/branch names and network connection.`,
    );
    rebaseUpdateTarget(target, options, backupPatchPath);
  } catch (error) {
    if (hasLocalWork) {
      if (rebaseInProgress() || hasUnresolvedConflicts()) {
        console.error(
          `Update stopped during a rebase. Your local work is still stashed as: ${stashMessage}`,
        );
        console.error(`Your tracked diff backup is available at: ${backupPatchPath}`);
      } else {
        console.error("Update did not complete; restoring your stashed local work.");
        const restoreResult = run("git", ["stash", "pop"], options);
        if (restoreResult.status !== 0) {
          console.error(
            `Automatic stash restore failed. Your backup patch is available at: ${backupPatchPath}`,
          );
        }
      }
    }
    throw error;
  }

  if (hasLocalWork) {
    const popResult = run("git", ["stash", "pop"], options);
    if (popResult.status !== 0) {
      throw new Error(
        `Local work conflicted while applying the stash. Resolve conflicts manually; git should keep the stash for recovery, and the backup patch is available if needed: ${backupPatchPath}`,
      );
    }
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

  if (options.check || options.build) {
    buildWorkspaceSpine(options);
  }

  if (options.check) {
    requireSuccess(
      run(pnpm, ["--filter", "gg-app", "check"], options),
      "gg-app check failed after reapplying local fixes.",
    );
    requireSuccess(
      run(pnpm, ["--filter", "@kenkaiiii/ggcoder", "check"], options),
      "@kenkaiiii/ggcoder check failed after reapplying local fixes.",
    );
  }

  if (options.build) {
    requireSuccess(
      run(pnpm, ["--filter", "gg-app", "build:local-patched"], options),
      "Local-patched installer build failed. If this is a WSL/Windows native optional-dependency mismatch, run `pnpm install --frozen-lockfile` and let pnpm recreate platform-specific modules if it asks.",
    );
  }

  console.log("Local fixes rebase workflow completed.");
}

main().catch((error) => {
  printNativeDependencyHint(error);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
