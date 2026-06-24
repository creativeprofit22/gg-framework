#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  --branch <name>   Branch to update from (default: upstream branch, then main)
  --no-install      Skip refreshing platform-specific dependencies
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
    install: true,
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
    } else if (arg === "--no-install") {
      options.install = false;
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

function writeFileLf(filePath, text) {
  writeFileSync(filePath, normalizeLineEndings(text));
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

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value) {
  return JSON.stringify(value);
}

function orderedUniqueKeys(...objects) {
  const keys = [];
  const seen = new Set();
  for (const object of objects) {
    if (!isPlainObject(object)) continue;
    for (const key of Object.keys(object)) {
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

function mergeJsonValue(base, ours, theirs) {
  if (isPlainObject(ours) && isPlainObject(theirs)) {
    const merged = {};
    for (const key of orderedUniqueKeys(base, theirs, ours)) {
      const baseValue = isPlainObject(base) ? base[key] : undefined;
      const ourValue = ours[key];
      const theirValue = theirs[key];
      const oursChanged = stableJson(ourValue) !== stableJson(baseValue);
      const theirsChanged = stableJson(theirValue) !== stableJson(baseValue);

      if (oursChanged && theirsChanged) {
        merged[key] =
          stableJson(ourValue) === stableJson(theirValue)
            ? theirValue
            : mergeJsonValue(baseValue, ourValue, theirValue);
      } else if (theirsChanged) {
        merged[key] = theirValue;
      } else if (oursChanged) {
        merged[key] = ourValue;
      } else if (theirValue !== undefined) {
        merged[key] = theirValue;
      } else if (ourValue !== undefined) {
        merged[key] = ourValue;
      }
    }
    return merged;
  }

  if (theirs !== undefined) return theirs;
  return ours;
}

function stagedJson(stage, filePath, options) {
  const result = capture("git", ["show", `:${stage}:${filePath}`], {
    ...options,
    allowFailure: true,
  });
  if (result.status !== 0) return null;
  return JSON.parse(result.stdout);
}

function unresolvedConflictFiles(options) {
  const result = capture("git", ["diff", "--name-only", "--diff-filter=U"], {
    ...options,
    allowFailure: true,
  });
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function localUpdateGitCommitArgs(args) {
  return [
    "-c",
    "user.name=GG Local Update",
    "-c",
    "user.email=local-update@ggcoder.local",
    ...args,
  ];
}

// Known safe merge: upstream added root scripts/deps while the local-patched
// branch added the app:update:local-fixes helper. Keep both maps.
function tryResolveRootPackageJsonConflict(options) {
  const conflicts = unresolvedConflictFiles(options);
  if (conflicts.length !== 1 || conflicts[0] !== "package.json") {
    return false;
  }

  const base = stagedJson(1, "package.json", options);
  const ours = stagedJson(2, "package.json", options);
  const theirs = stagedJson(3, "package.json", options);
  if (!base || !ours || !theirs) {
    return false;
  }

  console.log(
    "Auto-resolving package.json by keeping upstream package changes and local update scripts.",
  );
  const merged = mergeJsonValue(base, ours, theirs);
  writeFileLf(join(repoRoot, "package.json"), `${JSON.stringify(merged, null, 2)}\n`);
  requireSuccess(run("git", ["add", "package.json"], options), "Failed to stage package.json.");
  requireSuccess(
    run("git", localUpdateGitCommitArgs(["commit", "--no-edit"]), options),
    "Failed to finish the auto-resolved update merge.",
  );
  return true;
}

function resolvedAgentProjectsBody() {
  return `    let sidecar_projects = match (port_for(&webview), session_for(&webview)) {
        (Some(port), Some(gg_sid)) => match client
            .get(format!("{}/projects", sidecar_base(port)))
            .header("x-gg-session", &gg_sid)
            .send()
            .await
            .and_then(|res| res.error_for_status())
        {
            Ok(res) => res
                .json::<serde_json::Value>()
                .await
                .ok()
                .and_then(|body| body.get("projects").and_then(|v| v.as_array()).cloned())
                .unwrap_or_default(),
            Err(_) => Vec::new(),
        },
        _ => Vec::new(),
    };
    Ok(serde_json::json!({ "projects": merge_project_lists(sidecar_projects) }))`;
}

// Known safe stash-pop conflict: upstream added daemon session routing while a
// local fix made project listing tolerant of a slow/crashed sidecar.
function tryResolveAgentProjectsConflict(options) {
  const conflicts = unresolvedConflictFiles(options);
  if (conflicts.length !== 1 || conflicts[0] !== "gg-app/src-tauri/src/lib.rs") {
    return false;
  }

  const filePath = join(repoRoot, "gg-app/src-tauri/src/lib.rs");
  const text = readFileSync(filePath, "utf8");
  const functionStart = text.indexOf("async fn agent_projects(");
  if (functionStart < 0) return false;

  const markerStart = text.indexOf("<<<<<<< Updated upstream", functionStart);
  const separator = text.indexOf("=======", markerStart);
  const markerEnd = text.indexOf(">>>>>>> Stashed changes", separator);
  if (markerStart < 0 || separator < 0 || markerEnd < 0) return false;

  const conflictText = text.slice(markerStart, markerEnd);
  if (!conflictText.includes("x-gg-session") || !conflictText.includes("sidecar_projects")) {
    return false;
  }

  const afterMarkerLine = text.indexOf("\n", markerEnd);
  if (afterMarkerLine < 0) return false;

  const resolved = `${text.slice(0, markerStart)}${resolvedAgentProjectsBody()}${text.slice(
    afterMarkerLine,
  )}`;
  writeFileLf(filePath, resolved);
  requireSuccess(
    run("git", ["add", "gg-app/src-tauri/src/lib.rs"], options),
    "Failed to mark the gg-app Rust project-list conflict as resolved.",
  );
  requireSuccess(
    run("git", ["restore", "--staged", "gg-app/src-tauri/src/lib.rs"], options),
    "Failed to leave the resolved gg-app Rust project-list change unstaged.",
  );
  console.log(
    "Auto-resolved gg-app/src-tauri/src/lib.rs by keeping upstream session routing and local project-list fallback.",
  );
  return true;
}

function stashRefForMessage(stashMessage, options) {
  const result = capture("git", ["stash", "list", "--format=%gd%x00%s"], {
    ...options,
    allowFailure: true,
  });
  if (result.status !== 0) return null;

  for (const line of result.stdout.split("\n")) {
    const [ref, subject] = line.split("\0");
    if (ref && subject?.endsWith(`: ${stashMessage}`)) {
      return ref;
    }
  }
  return null;
}

function dropAutoResolvedStash(stashMessage, options) {
  const stashRef = stashRefForMessage(stashMessage, options);
  if (!stashRef) {
    throw new Error(
      "Auto-resolved stash was applied, but its matching stash entry was not found.",
    );
  }

  requireSuccess(
    run("git", ["stash", "drop", stashRef], options),
    "Auto-resolved stash was applied, but could not drop its matching stash entry.",
  );
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
  const merge = run(
    "git",
    localUpdateGitCommitArgs(["merge", "--no-edit", "--no-ff", target]),
    options,
  );
  if (merge.status === 0) return;

  if (tryResolveRootPackageJsonConflict(options)) return;

  throw new Error(
    `Automatic merge from ${target} failed. Resolve conflicts, then run checks/build. Your pre-update HEAD is saved at ${backupBranch}.`,
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
  console.log(`Dependency refresh: ${options.install ? "enabled" : "skipped"}`);
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
      if (!tryResolveAgentProjectsConflict(options)) {
        throw new Error(
          `Local fixes conflicted while applying the stash. Resolve conflicts manually, then use the backup patch if needed: ${backupPatchPath}`,
        );
      }
      dropAutoResolvedStash(stashMessage, options);
    }
  }

  normalizeFileLf("gg-app/src-tauri/src/lib.rs", options);

  if (options.install) {
    requireSuccess(
      run(pnpm, ["install", "--frozen-lockfile"], {
        ...options,
        env: { CI: "true" },
      }),
      "Dependency refresh failed after updating source.",
    );
  }

  if (options.check || options.build) {
    requireSuccess(
      run(pnpm, ["--filter", "@kenkaiiii/gg-core", "build"], options),
      "@kenkaiiii/gg-core build failed after reapplying local fixes.",
    );
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
