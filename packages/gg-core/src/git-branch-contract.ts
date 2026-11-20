/** Branch list the desktop branch switcher reads from the daemon's `GET /git/branches`. */

export const GIT_BRANCH_LIST_DEFAULT_LIMIT = 50;
export const GIT_BRANCH_LIST_MAX_LIMIT = 200;
export const GIT_BRANCH_QUERY_MAX_LENGTH = 200;
/** Generous bound for validating names coming back over the wire. */
export const GIT_BRANCH_NAME_MAX_LENGTH = 1_000;

export interface GitLocalBranch {
  name: string;
  current: boolean;
  /** ISO time of the later of the last checkout and the last commit. */
  lastUsedAt: string | null;
  /** Short upstream name such as `origin/main`. */
  upstream: string | null;
}

export interface GitRemoteBranch {
  /** Name without the `origin/` prefix. */
  name: string;
  remoteRef: string;
  lastCommitAt: string | null;
}

export interface GitCurrentBranch {
  /** Null when HEAD is detached. */
  name: string | null;
  detached: boolean;
  /** Short commit id; null in a repo with no commits yet. */
  commit: string | null;
}

export interface GitDefaultBranch {
  name: string;
  source: "remote-head" | "fallback";
}

export interface GitBranchListOk {
  status: "ok";
  current: GitCurrentBranch;
  hasCommits: boolean;
  remote: "origin" | null;
  defaultBranch: GitDefaultBranch | null;
  local: GitLocalBranch[];
  remoteOnly: GitRemoteBranch[];
  /** Matching counts before the limit was applied. */
  localTotal: number;
  remoteOnlyTotal: number;
  truncated: boolean;
}

export interface GitBranchListNotARepo {
  status: "not-a-repo";
}

export type GitBranchListResponse = GitBranchListOk | GitBranchListNotARepo;

export interface GitBranchListOptions {
  query?: string;
  limit?: number;
}

/** Numbers and numeric strings (e.g. a ?limit= value) are floored into 1..max; anything else falls back to the default. */
export function clampGitBranchListLimit(value: unknown): number {
  const numeric = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isFinite(numeric)) {
    return GIT_BRANCH_LIST_DEFAULT_LIMIT;
  }
  return Math.min(GIT_BRANCH_LIST_MAX_LIMIT, Math.max(1, Math.floor(numeric)));
}

/** Trim and cap a search query; empty → undefined. */
export function normalizeGitBranchQuery(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, GIT_BRANCH_QUERY_MAX_LENGTH);
  return trimmed || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isBranchName(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= GIT_BRANCH_NAME_MAX_LENGTH
  );
}

function isNullableBranchName(value: unknown): boolean {
  return value === null || isBranchName(value);
}

function isNullableIsoTime(value: unknown): boolean {
  return value === null || (typeof value === "string" && !Number.isNaN(Date.parse(value)));
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isLocalBranch(value: unknown): value is GitLocalBranch {
  return (
    isRecord(value) &&
    isBranchName(value.name) &&
    typeof value.current === "boolean" &&
    isNullableIsoTime(value.lastUsedAt) &&
    isNullableBranchName(value.upstream)
  );
}

function isRemoteBranch(value: unknown): value is GitRemoteBranch {
  return (
    isRecord(value) &&
    isBranchName(value.name) &&
    isBranchName(value.remoteRef) &&
    isNullableIsoTime(value.lastCommitAt)
  );
}

function isCurrentBranch(value: unknown): value is GitCurrentBranch {
  if (!isRecord(value) || typeof value.detached !== "boolean") return false;
  if (!isNullableBranchName(value.name) || !isNullableBranchName(value.commit)) return false;
  return value.detached ? value.name === null : value.name !== null;
}

function isDefaultBranch(value: unknown): boolean {
  if (value === null) return true;
  return (
    isRecord(value) &&
    isBranchName(value.name) &&
    (value.source === "remote-head" || value.source === "fallback")
  );
}

export function isGitBranchListResponse(value: unknown): value is GitBranchListResponse {
  if (!isRecord(value)) return false;
  if (value.status === "not-a-repo") return true;
  if (value.status !== "ok") return false;
  const { local, remoteOnly } = value;
  return (
    isCurrentBranch(value.current) &&
    typeof value.hasCommits === "boolean" &&
    (value.remote === "origin" || value.remote === null) &&
    isDefaultBranch(value.defaultBranch) &&
    Array.isArray(local) &&
    local.length <= GIT_BRANCH_LIST_MAX_LIMIT &&
    local.every(isLocalBranch) &&
    Array.isArray(remoteOnly) &&
    remoteOnly.length <= GIT_BRANCH_LIST_MAX_LIMIT &&
    remoteOnly.every(isRemoteBranch) &&
    isCount(value.localTotal) &&
    value.localTotal >= local.length &&
    isCount(value.remoteOnlyTotal) &&
    value.remoteOnlyTotal >= remoteOnly.length &&
    typeof value.truncated === "boolean"
  );
}
