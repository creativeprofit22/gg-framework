import type { GoalRecord } from "../core/goals-store.js";
import {
  getGitBranch,
  getGitDirtyFileCount,
  isGitRepo,
  type GitReadOptions,
} from "../utils/git.js";
import {
  getGitHubBranch,
  getGitHubRepoSlug,
  readGitHubRepoSlug,
  type GitHubBranch,
} from "../utils/github.js";

/**
 * The folder whose git state a window's titlebar shows (branch, uncommitted
 * files, GitHub, CI, Project Health). Normally the window's cwd. A Goal
 * window's cwd is the goal's own folder under `~/.gg/goals`, which is not a
 * repo, so it uses the first attached folder that is inside a git work tree:
 * the project the goal is actually changing.
 *
 * `settled` is false when a folder's check failed or timed out before the
 * choice was made, so the caller should resolve again with more time.
 */
export async function resolveGitCwd(
  cwd: string,
  goal: Pick<GoalRecord, "context"> | null,
  isRepo: (dir: string) => Promise<boolean> = isGitRepo,
): Promise<{ dir: string; settled: boolean }> {
  if (!goal) return { dir: cwd, settled: true };
  let settled = true;
  for (const item of goal.context) {
    if (item.kind !== "folder") continue;
    const repo = await isRepo(item.path).catch(() => null);
    if (repo === null) settled = false;
    if (repo) return { dir: item.path, settled };
  }
  return { dir: cwd, settled };
}

export interface GitState {
  branch: string | null;
  isRepo: boolean;
  dirtyFileCount: number;
  gitHubSlug: string | null;
  /** The current branch's GitHub page and whether origin has it (local refs only). */
  gitHubBranch: GitHubBranch;
  /**
   * False when git didn't answer whether this is a repo, or how many files
   * changed in one (a timeout on a busy machine): isRepo and dirtyFileCount
   * are then placeholders, and the caller should read again with more time.
   */
  settled: boolean;
}

/** Read a folder's git state; each part falls back on its own when git fails. */
export async function readGitState(dir: string, options: GitReadOptions = {}): Promise<GitState> {
  const [branch, isRepo, dirtyFileCount, gitHubSlug] = await Promise.all([
    getGitBranch(dir, options).catch(() => null),
    isGitRepo(dir, options).catch(() => null),
    getGitDirtyFileCount(dir, options).catch(() => null),
    getGitHubRepoSlug(dir).catch(() => null),
  ]);
  const gitHubBranch = await getGitHubBranch(dir, gitHubSlug, branch, options);
  return {
    branch,
    isRepo: isRepo ?? false,
    dirtyFileCount: dirtyFileCount ?? 0,
    gitHubSlug,
    gitHubBranch,
    // Outside a repo the count fails by design; only a repo needs one.
    settled: isRepo === false || (isRepo === true && dirtyFileCount !== null),
  };
}

/** What the titlebar's branch key shows: re-read on focus, Git panel open and after runs. */
export interface GitHead {
  branch: string | null;
  /** null: git didn't answer (timeout, failed spawn); keep the last-known value. */
  isRepo: boolean | null;
  /** origin's GitHub slug. null: none on GitHub; undefined: git didn't answer, keep the last one. */
  gitHubSlug: string | null | undefined;
  gitHubBranch: GitHubBranch;
}

/** Local refs only. null when git answered nothing at all, so nothing is published. */
export async function readGitHead(dir: string): Promise<GitHead | null> {
  const [branch, isRepo, gitHubSlug] = await Promise.all([
    getGitBranch(dir).catch(() => null),
    isGitRepo(dir).catch(() => null),
    readGitHubRepoSlug(dir).catch(() => undefined),
  ]);
  if (branch === null && isRepo === null) return null;
  const gitHubBranch = await getGitHubBranch(dir, gitHubSlug ?? null, branch);
  return { branch, isRepo, gitHubSlug, gitHubBranch };
}
