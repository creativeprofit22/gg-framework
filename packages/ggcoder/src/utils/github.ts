import { withoutQwenRuntimeSecret } from "../tools/safe-env.js";
import { execFile } from "node:child_process";
import { runBackgroundGit, type GitReadOptions } from "./git.js";

/**
 * Parse an `owner/repo` slug from a GitHub remote URL. Handles the three
 * common remote shapes: https (`https://github.com/o/r(.git)`), scp-style ssh
 * (`git@github.com:o/r(.git)`), and explicit ssh/git URLs
 * (`ssh://git@github.com/o/r`). Returns null for non-GitHub remotes.
 */
export function parseGitHubSlug(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  const match =
    /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(
      trimmed,
    ) ?? /^[^@/\s]+@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(trimmed);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

/** The `owner/repo` slug of the cwd's `origin` remote, or null when absent/non-GitHub. */
export async function getGitHubRepoSlug(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runBackgroundGit(["remote", "get-url", "origin"], {
      cwd,
      timeoutMs: 2000,
    });
    return parseGitHubSlug(stdout);
  } catch {
    return null;
  }
}

/** `https://github.com/<slug>/tree/<branch>`, each branch path segment encoded on its own. */
export function gitHubBranchUrl(slug: string, branch: string): string {
  return `https://github.com/${slug}/tree/${branch.split("/").map(encodeURIComponent).join("/")}`;
}

/** What local remote-tracking refs say about `origin`; read without any network call. */
export interface OriginBranchRefs {
  /** Target of `refs/remotes/origin/HEAD`, or null when that ref is missing. */
  defaultBranch: string | null;
  /** Whether `refs/remotes/origin/<branch>` exists. */
  branchExists: boolean;
}

export interface GitHubBranch {
  /** The branch page on GitHub; null means "open the repo home page". */
  gitHubBranchUrl: string | null;
  /** false: not pushed to origin; null: unknown or not applicable (no repo, detached). */
  gitHubBranchOnGitHub: boolean | null;
}

const ORIGIN_PREFIX = "refs/remotes/origin/";
const UNKNOWN_BRANCH: GitHubBranch = { gitHubBranchUrl: null, gitHubBranchOnGitHub: null };

export function resolveGitHubBranch(input: {
  slug: string | null;
  branch: string | null;
  refs: OriginBranchRefs | null;
}): GitHubBranch {
  const { slug, branch, refs } = input;
  // `git rev-parse --abbrev-ref HEAD` prints "HEAD" on a detached HEAD.
  if (!slug || !branch || branch === "HEAD" || !refs) return UNKNOWN_BRANCH;
  const isDefault = refs.defaultBranch
    ? branch === refs.defaultBranch
    : branch === "main" || branch === "master";
  if (isDefault) return { gitHubBranchUrl: null, gitHubBranchOnGitHub: true };
  if (!refs.branchExists) return { gitHubBranchUrl: null, gitHubBranchOnGitHub: false };
  return { gitHubBranchUrl: gitHubBranchUrl(slug, branch), gitHubBranchOnGitHub: true };
}

/** Parse `git for-each-ref --format=%(refname)%09%(symref)` output for one branch. */
export function parseOriginBranchRefs(stdout: string, branch: string): OriginBranchRefs {
  let defaultBranch: string | null = null;
  let branchExists = false;
  for (const line of stdout.split(/\r?\n/)) {
    const [refname, symref = ""] = line.split("\t");
    // for-each-ref patterns also match as prefixes (origin/feat matches origin/feat/x).
    if (refname === `${ORIGIN_PREFIX}HEAD` && symref.startsWith(ORIGIN_PREFIX)) {
      defaultBranch = symref.slice(ORIGIN_PREFIX.length) || null;
    } else if (refname === `${ORIGIN_PREFIX}${branch}`) {
      branchExists = true;
    }
  }
  return { defaultBranch, branchExists };
}

/** Local `origin` refs for `branch`, or null when git fails. */
export async function readOriginBranchRefs(
  cwd: string,
  branch: string,
  options: GitReadOptions = {},
): Promise<OriginBranchRefs | null> {
  try {
    const { stdout } = await runBackgroundGit(
      [
        "for-each-ref",
        "--format=%(refname)%09%(symref)",
        `${ORIGIN_PREFIX}HEAD`,
        `${ORIGIN_PREFIX}${branch}`,
      ],
      { cwd, timeoutMs: options.timeoutMs },
    );
    return parseOriginBranchRefs(stdout, branch);
  } catch {
    return null;
  }
}

/** Where "Open on GitHub" should go for the current branch; never throws. */
export async function getGitHubBranch(
  cwd: string,
  slug: string | null,
  branch: string | null,
  options: GitReadOptions = {},
): Promise<GitHubBranch> {
  if (!slug || !branch || branch === "HEAD") return UNKNOWN_BRANCH;
  const refs = await readOriginBranchRefs(cwd, branch, options);
  return resolveGitHubBranch({ slug, branch, refs });
}

export interface GitHubOpenCounts {
  issues: number;
  prs: number;
}

function ghSearchTotalCount(slug: string, qualifier: string): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      [
        "api",
        `search/issues?q=repo:${slug}+${qualifier}+is:open&per_page=1`,
        "--jq",
        ".total_count",
      ],
      { env: withoutQwenRuntimeSecret(), timeout: 10000 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        const count = Number.parseInt(stdout.trim(), 10);
        if (Number.isNaN(count)) {
          reject(new Error(`unexpected gh output: ${stdout.trim()}`));
          return;
        }
        resolve(count);
      },
    );
  });
}

/**
 * Open issue + PR counts for a GitHub repo, via the `gh` CLI's own auth.
 * Returns null on ANY failure (gh missing, not authenticated, offline, rate
 * limited) — callers treat null as "unknown" and keep the UI chip hidden.
 */
export async function getGitHubOpenCounts(slug: string): Promise<GitHubOpenCounts | null> {
  try {
    const [issues, prs] = await Promise.all([
      ghSearchTotalCount(slug, "is:issue"),
      ghSearchTotalCount(slug, "is:pr"),
    ]);
    return { issues, prs };
  } catch {
    return null;
  }
}
