import {
  clampGitBranchListLimit,
  normalizeGitBranchQuery,
  type GitBranchListResponse,
  type GitDefaultBranch,
  type GitLocalBranch,
  type GitRemoteBranch,
} from "@kenkaiiii/gg-core/git-branch-contract";
import { BackgroundGitError, runBackgroundGit } from "./git.js";

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
const REFLOG_ENTRY_LIMIT = 2_000;
const REMOTE = "origin";
const LOCAL_PREFIX = "refs/heads/";
const REMOTE_PREFIX = `refs/remotes/${REMOTE}/`;
const FALLBACK_DEFAULTS = ["main", "master"] as const;
const REF_FORMAT = "--format=%(refname)%00%(committerdate:unix)%00%(upstream:short)";

export interface ListGitBranchesOptions {
  query?: string;
  limit?: number;
  signal?: AbortSignal;
}

export interface ParsedBranchRef {
  /** Name with the prefix removed, e.g. `feature/a/b`. */
  name: string;
  /** Unix seconds of the tip commit, when git reported one. */
  commitTime: number | null;
  upstream: string | null;
}

/** Parse `for-each-ref` lines of `refname NUL committer-unix NUL upstream`, keeping refs under `prefix`. */
export function parseBranchRefs(stdout: string, prefix: string): ParsedBranchRef[] {
  const refs: ParsedBranchRef[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const [refname = "", time = "", upstream = ""] = line.split("\0");
    if (!refname.startsWith(prefix)) continue;
    const name = refname.slice(prefix.length);
    if (!name) continue;
    const seconds = Number(time);
    refs.push({
      name,
      commitTime: time && Number.isFinite(seconds) && seconds > 0 ? seconds : null,
      upstream: upstream || null,
    });
  }
  return refs;
}

/**
 * Last checkout time (unix seconds) per branch from reflog lines of
 * `HEAD@{unix} NUL subject`, newest first. Only `checkout: moving from A to B`
 * entries count, and the first (newest) one for each B wins.
 */
export function parseReflogCheckouts(stdout: string): Map<string, number> {
  const checkouts = new Map<string, number>();
  for (const line of stdout.split(/\r?\n/)) {
    const [selector = "", subject = ""] = line.split("\0");
    const time = /@\{(\d+)\}$/.exec(selector);
    const move = /^checkout: moving from \S+ to (\S+)$/.exec(subject);
    if (!time || !move) continue;
    const target = move[1]!;
    if (!checkouts.has(target)) checkouts.set(target, Number(time[1]));
  }
  return checkouts;
}

interface RankedLocalBranch extends GitLocalBranch {
  lastUsed: number | null;
}

/** Current branch first, then most recently used, then by name. */
export function orderLocalBranches(
  refs: readonly ParsedBranchRef[],
  checkouts: ReadonlyMap<string, number>,
  currentName: string | null,
): GitLocalBranch[] {
  const ranked: RankedLocalBranch[] = refs.map((ref) => {
    const checkout = checkouts.get(ref.name) ?? null;
    const lastUsed =
      checkout === null ? ref.commitTime : Math.max(checkout, ref.commitTime ?? checkout);
    return {
      name: ref.name,
      current: ref.name === currentName,
      lastUsedAt: lastUsed === null ? null : new Date(lastUsed * 1000).toISOString(),
      upstream: ref.upstream,
      lastUsed,
    };
  });
  ranked.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    if (a.lastUsed !== b.lastUsed) {
      if (a.lastUsed === null) return 1;
      if (b.lastUsed === null) return -1;
      return b.lastUsed - a.lastUsed;
    }
    return compareNames(a.name, b.name);
  });
  return ranked.map(({ lastUsed: _lastUsed, ...branch }) => branch);
}

function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function matches(name: string, query: string | undefined): boolean {
  return query === undefined || name.toLowerCase().includes(query.toLowerCase());
}

/** True when git ran and exited non-zero (as opposed to a timeout, abort or spawn failure). */
function isGitExit(error: unknown): boolean {
  return error instanceof BackgroundGitError && typeof error.code === "number" && !error.killed;
}

export async function listGitBranches(
  cwd: string,
  options: ListGitBranchesOptions = {},
): Promise<GitBranchListResponse> {
  const { signal } = options;
  const limit = clampGitBranchListLimit(options.limit);
  const query = normalizeGitBranchQuery(options.query);
  const git = async (args: readonly string[]): Promise<string> =>
    (
      await runBackgroundGit(args, {
        cwd,
        timeoutMs: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        signal,
      })
    ).stdout;
  // Exit codes mean "no answer" for these reads; timeouts and aborts still throw.
  const gitOrNull = (args: readonly string[]): Promise<string | null> =>
    git(args).catch((error: unknown) => {
      if (isGitExit(error)) return null;
      throw error;
    });

  const inside = await gitOrNull(["rev-parse", "--is-inside-work-tree"]);
  if (inside?.trim() !== "true") return { status: "not-a-repo" };

  const [headName, headCommit, remotes, localOut, reflogOut, remoteOut, remoteHead] =
    await Promise.all([
      // symbolic-ref answers even before the first commit; exit 1 means detached.
      gitOrNull(["symbolic-ref", "--quiet", "--short", "HEAD"]),
      gitOrNull(["rev-parse", "--verify", "--quiet", "--short", "HEAD"]),
      git(["remote"]),
      git(["for-each-ref", REF_FORMAT, "refs/heads"]),
      gitOrNull([
        "reflog",
        "show",
        "--date=unix",
        "--format=%gd%x00%gs",
        "-n",
        String(REFLOG_ENTRY_LIMIT),
        "HEAD",
      ]),
      git(["for-each-ref", REF_FORMAT, `refs/remotes/${REMOTE}`]),
      gitOrNull(["symbolic-ref", "--quiet", "--short", `refs/remotes/${REMOTE}/HEAD`]),
    ]);

  const currentName = headName?.trim() || null;
  const commit = headCommit?.trim() || null;
  const hasRemote = remotes.split(/\r?\n/).some((line) => line.trim() === REMOTE);

  const localRefs = parseBranchRefs(localOut, LOCAL_PREFIX);
  // An unborn branch (empty repo or orphan checkout) has no ref yet but is still current.
  if (currentName && !localRefs.some((ref) => ref.name === currentName)) {
    localRefs.push({ name: currentName, commitTime: null, upstream: null });
  }
  const localNames = new Set(localRefs.map((ref) => ref.name));
  const ordered = orderLocalBranches(localRefs, parseReflogCheckouts(reflogOut ?? ""), currentName);

  const remoteRefs = hasRemote
    ? parseBranchRefs(remoteOut, REMOTE_PREFIX).filter((ref) => ref.name !== "HEAD")
    : [];
  const remoteOnlyAll: GitRemoteBranch[] = remoteRefs
    .filter((ref) => !localNames.has(ref.name))
    .sort((a, b) => (b.commitTime ?? 0) - (a.commitTime ?? 0) || compareNames(a.name, b.name))
    .map((ref) => ({
      name: ref.name,
      remoteRef: `${REMOTE}/${ref.name}`,
      lastCommitAt: ref.commitTime === null ? null : new Date(ref.commitTime * 1000).toISOString(),
    }));

  let defaultBranch: GitDefaultBranch | null = null;
  const headTarget = hasRemote ? remoteHead?.trim() : undefined;
  if (headTarget?.startsWith(`${REMOTE}/`) && headTarget.length > REMOTE.length + 1) {
    defaultBranch = { name: headTarget.slice(REMOTE.length + 1), source: "remote-head" };
  } else {
    const remoteNames = new Set(remoteRefs.map((ref) => ref.name));
    const fallback = FALLBACK_DEFAULTS.find(
      (name) => localNames.has(name) || remoteNames.has(name),
    );
    if (fallback) defaultBranch = { name: fallback, source: "fallback" };
  }

  const localMatches = ordered.filter((branch) => matches(branch.name, query));
  const remoteMatches = remoteOnlyAll.filter((branch) => matches(branch.name, query));
  const local = localMatches.slice(0, limit);
  const remoteOnly = remoteMatches.slice(0, limit);

  return {
    status: "ok",
    current: { name: currentName, detached: currentName === null, commit },
    hasCommits: commit !== null,
    remote: hasRemote ? REMOTE : null,
    defaultBranch,
    local,
    remoteOnly,
    localTotal: localMatches.length,
    remoteOnlyTotal: remoteMatches.length,
    truncated: local.length < localMatches.length || remoteOnly.length < remoteMatches.length,
  };
}
