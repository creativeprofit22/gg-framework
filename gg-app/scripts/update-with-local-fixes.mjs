#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const repoRoot = join(appDir, "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

function usage() {
  return `Usage: node gg-app/scripts/update-with-local-fixes.mjs [options]

Options:
  --remote <name>   Git remote to fetch from (default: upstream remote, then origin)
  --branch <name>   Branch to fast-forward from (default: upstream branch, then main)
  --no-build        Skip building the local-patched installer after checks
  --no-check        Skip TypeScript checks after reapplying local fixes
  --dry-run         Print the planned workflow without mutating the repository
  -h, --help        Show this help
`;
}

function parseArgs(args) {
  const options = {
    remote: null,
    branch: null,
    build: true,
    check: true,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
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
    } else if (arg === "--no-build") {
      options.build = false;
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

function currentUpstream() {
  const result = capture("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
    allowFailure: true,
  });
  const upstream = result.stdout.trim();
  if (result.status !== 0 || !upstream || !upstream.includes("/")) {
    return null;
  }
  const slash = upstream.indexOf("/");
  return {
    remote: upstream.slice(0, slash),
    branch: upstream.slice(slash + 1),
  };
}

function hasUnresolvedConflicts() {
  const result = capture("git", ["diff", "--name-only", "--diff-filter=U"]);
  return result.stdout.trim().length > 0;
}

function mergeInProgress() {
  return (
    capture("git", ["rev-parse", "--verify", "MERGE_HEAD"], {
      allowFailure: true,
    }).status === 0
  );
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

function mergeUpdateTarget(target, options) {
  const fastForward = run("git", ["merge", "--ff-only", target], {
    ...options,
    capture: true,
  });
  if (fastForward.status === 0) {
    if (fastForward.stdout.trim()) console.log(fastForward.stdout.trim());
    return;
  }

  console.log(
    `Fast-forward is not possible; merging ${target} so committed local fixes stay on top of the update.`,
  );
  const backupBranch = createBackupBranch(options);
  requireSuccess(
    run("git", ["merge", "--no-edit", "--no-ff", target], options),
    `Automatic merge from ${target} failed. Resolve conflicts, then run checks/build. Your pre-update HEAD is saved at ${backupBranch}.`,
  );
}

function writeBackups(statusText) {
  const backupDir = join(repoRoot, ".gg", "local-fixes", "backups");
  mkdirSync(backupDir, { recursive: true });

  const patchPath = join(backupDir, `${timestamp}.patch`);
  const statusPath = join(backupDir, `${timestamp}-status.txt`);
  const diff = capture("git", ["diff", "--binary"]).stdout;

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

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const rootResult = capture("git", ["rev-parse", "--show-toplevel"], { allowFailure: true });
  if (rootResult.status !== 0) {
    throw new Error("This script must be run inside a git worktree.");
  }

  const upstream = currentUpstream();
  const remote = options.remote ?? upstream?.remote ?? "origin";
  const branch = options.branch ?? upstream?.branch ?? "main";
  const target = `${remote}/${branch}`;

  console.log("GG local-fixes update workflow");
  console.log(`Repository: ${rootResult.stdout.trim()}`);
  console.log(`Update target: ${target}`);
  console.log(`Checks: ${options.check ? "enabled" : "skipped"}`);
  console.log(`Build: ${options.build ? "enabled" : "skipped"}`);

  if (hasUnresolvedConflicts()) {
    throw new Error("Unresolved merge conflicts are present. Resolve them before updating.");
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
      run("git", ["fetch", remote, branch], options),
      `Failed to fetch ${remote} ${branch}. Check the remote/branch names and network connection.`,
    );
    mergeUpdateTarget(target, options);
  } catch (error) {
    if (hasLocalWork) {
      if (mergeInProgress() || hasUnresolvedConflicts()) {
        console.error(
          `Update stopped during an automatic merge. Your local work is still stashed as: ${stashMessage}`,
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
        `Local fixes conflicted while applying the stash. Resolve conflicts manually, then use the backup patch if needed: ${backupPatchPath}`,
      );
    }
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

  console.log("Local fixes update workflow completed.");
}

main().catch((error) => {
  printNativeDependencyHint(error);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
