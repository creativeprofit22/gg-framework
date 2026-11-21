import {
  clampGitBranchListLimit,
  GIT_BRANCH_NAME_MAX_LENGTH,
  GIT_BRANCH_SWITCH_MAX_FILES,
  GIT_BRANCH_SWITCH_MAX_PATH_LENGTH,
  normalizeGitBranchQuery,
  type GitBranchListResponse,
  type GitBranchSwitchConflict,
  type GitBranchSwitchResponse,
  type GitDefaultBranch,
  type GitLocalBranch,
  type GitRemoteBranch,
} from "@kenkaiiii/gg-core/git-branch-contract";
import { BackgroundGitError, getGitDirtyFileCount, runBackgroundGit, runUserGit } from "./git.js";

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

// ── Branch switch ───────────────────────────────────────────────────────────

const SWITCH_TIMEOUT_MS = 60_000;
/** Words git uses in "cannot switch branch while <word>". */
const IN_PROGRESS_LABELS: Record<string, string> = {
  merging: "merge",
  rebasing: "rebase",
  "cherry-picking": "cherry-pick",
  reverting: "revert",
  bisecting: "bisect",
};

/** The requested name is not a valid branch name; the daemon answers 400. */
export class InvalidGitBranchNameError extends Error {
  constructor() {
    super("That isn't a valid branch name.");
    this.name = "InvalidGitBranchNameError";
  }
}

/** Undo git's C-style quoting of a path (`"caf\303\251.txt"`). */
export function unquoteGitPath(raw: string): string {
  if (!(raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"'))) return raw;
  const bytes: number[] = [];
  const body = raw.slice(1, -1);
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, b: 8, f: 12, v: 11, a: 7 };
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!;
    if (char !== "\\" || i + 1 >= body.length) {
      bytes.push(...Buffer.from(char, "utf8"));
      continue;
    }
    const next = body[i + 1]!;
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 3;
    } else {
      bytes.push(simple[next] ?? next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Paths git lists under "…would be overwritten by checkout:" or "…would be
 * removed by checkout:" blocks (tab-indented). Empty when stderr has none.
 */
export function parseCheckoutClashFiles(stderr: string): string[] {
  const files: string[] = [];
  let inBlock = false;
  for (const line of stderr.split(/\r?\n/)) {
    if (/would be (?:overwritten|removed) by checkout:\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && line.startsWith("\t")) {
      const file = unquoteGitPath(line.slice(1).trimEnd());
      if (file && !files.includes(file)) files.push(file);
      continue;
    }
    inBlock = false;
  }
  return files;
}

function conflictResponse(reason: string, files: readonly string[]): GitBranchSwitchConflict {
  const usable = files.filter(
    (file) => file.length > 0 && file.length <= GIT_BRANCH_SWITCH_MAX_PATH_LENGTH,
  );
  return {
    status: "conflict",
    reason,
    files: usable.slice(0, GIT_BRANCH_SWITCH_MAX_FILES),
    filesTruncated: usable.length > GIT_BRANCH_SWITCH_MAX_FILES,
  };
}

function quoteForReason(branch: string): string {
  return branch.length > 200 ? `"${branch.slice(0, 200)}…"` : `"${branch}"`;
}

/**
 * Switch `cwd` to `branch` with plain `git switch` (never forced). A branch
 * that only exists on origin gets a local branch tracking it. When git refuses
 * because uncommitted changes clash, nothing changes and the clashing paths
 * come back. Throws {@link InvalidGitBranchNameError} for a bad name and a
 * plain Error (with git's output, for the log only) for anything unexpected.
 */
export async function switchGitBranch(
  cwd: string,
  branch: string,
): Promise<GitBranchSwitchResponse> {
  const read = async (args: readonly string[]): Promise<string> =>
    (await runBackgroundGit(args, { cwd, timeoutMs: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER }))
      .stdout;
  const readOrNull = (args: readonly string[]): Promise<string | null> =>
    read(args).catch((error: unknown) => {
      if (isGitExit(error)) return null;
      throw error;
    });

  if (
    typeof branch !== "string" ||
    branch.length === 0 ||
    branch.length > GIT_BRANCH_NAME_MAX_LENGTH ||
    branch.startsWith("-") ||
    branch === "HEAD"
  ) {
    throw new InvalidGitBranchNameError();
  }
  // `--branch` also expands `@{-1}`-style shorthands, so the echo must match exactly.
  const checked = await readOrNull(["check-ref-format", "--branch", branch]);
  if (checked?.trim() !== branch) throw new InvalidGitBranchNameError();

  const inside = await readOrNull(["rev-parse", "--is-inside-work-tree"]);
  if (inside?.trim() !== "true") return { status: "not-a-repo" };

  const current =
    (await readOrNull(["symbolic-ref", "--quiet", "--short", "HEAD"]))?.trim() || null;
  if (current === branch) return { status: "unchanged", branch };

  const [localRef, remoteRef] = await Promise.all([
    readOrNull(["rev-parse", "--verify", "--quiet", `${LOCAL_PREFIX}${branch}`]),
    readOrNull(["rev-parse", "--verify", "--quiet", `${REMOTE_PREFIX}${branch}`]),
  ]);
  let args: string[];
  let trackedRemote: string | null = null;
  if (localRef !== null) {
    args = ["switch", "--no-guess", branch];
  } else if (remoteRef !== null) {
    args = ["switch", "--no-guess", "--track", "-c", branch, `${REMOTE_PREFIX}${branch}`];
    trackedRemote = `${REMOTE}/${branch}`;
  } else {
    return {
      status: "not-found",
      reason: `There's no branch called ${quoteForReason(branch)} in this project or on ${REMOTE}.`,
    };
  }

  const dirtyBefore = await getGitDirtyFileCount(cwd, { timeoutMs: GIT_TIMEOUT_MS }).catch(() => 0);

  try {
    await runUserGit(args, { cwd, timeoutMs: SWITCH_TIMEOUT_MS });
  } catch (error) {
    if (!isGitExit(error)) throw error;
    const stderr = (error as BackgroundGitError).stderr;
    const clashing = parseCheckoutClashFiles(stderr);
    const stay = current ? ` or stay on ${quoteForReason(current)}` : "";
    if (clashing.length > 0) {
      return conflictResponse(
        `Your uncommitted changes would be overwritten by switching to ${quoteForReason(branch)}, so nothing was changed. Commit them first${stay}.`,
        clashing,
      );
    }
    const inProgress = /cannot switch branch while (\S+)/i.exec(stderr)?.[1]?.toLowerCase();
    if (inProgress || /resolve your current index first/i.test(stderr)) {
      const unmerged = await readOrNull(["diff", "--name-only", "--diff-filter=U"]);
      const what = inProgress
        ? `A ${IN_PROGRESS_LABELS[inProgress] ?? "git operation"} is still in progress`
        : "This project has unfinished merge conflicts";
      return conflictResponse(
        `${what}, so nothing was changed. Finish or cancel it first${stay}.`,
        (unmerged ?? "").split(/\r?\n/).filter(Boolean),
      );
    }
    throw new Error(`git switch failed: ${stderr.trim() || (error as Error).message}`, {
      cause: error,
    });
  }

  return {
    status: "switched",
    from: current,
    to: branch,
    trackedRemote,
    carriedChanges: dirtyBefore > 0,
  };
}
