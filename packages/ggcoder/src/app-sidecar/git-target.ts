import type { GoalRecord } from "../core/goals-store.js";
import { getGitBranch, getGitDirtyFileCount, isGitRepo } from "../utils/git.js";
import { getGitHubRepoSlug } from "../utils/github.js";

/**
 * The folder whose git state a window's titlebar shows (branch, uncommitted
 * files, GitHub, CI, Project Health). Normally the window's cwd. A Goal
 * window's cwd is the goal's own folder under `~/.gg/goals`, which is not a
 * repo, so it uses the first attached folder that is inside a git work tree:
 * the project the goal is actually changing.
 */
export async function resolveGitCwd(
  cwd: string,
  goal: Pick<GoalRecord, "context"> | null,
  isRepo: (dir: string) => Promise<boolean> = isGitRepo,
): Promise<string> {
  if (!goal) return cwd;
  for (const item of goal.context) {
    if (item.kind !== "folder") continue;
    if (await isRepo(item.path).catch(() => false)) return item.path;
  }
  return cwd;
}

export interface GitState {
  branch: string | null;
  isRepo: boolean;
  dirtyFileCount: number;
  gitHubSlug: string | null;
}

/** Read a folder's git state; each part falls back on its own when git fails. */
export async function readGitState(dir: string): Promise<GitState> {
  const [branch, isRepo, dirtyFileCount, gitHubSlug] = await Promise.all([
    getGitBranch(dir).catch(() => null),
    isGitRepo(dir).catch(() => false),
    getGitDirtyFileCount(dir).catch(() => 0),
    getGitHubRepoSlug(dir).catch(() => null),
  ]);
  return { branch, isRepo, dirtyFileCount, gitHubSlug };
}
