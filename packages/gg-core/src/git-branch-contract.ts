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

// ── Branch switch (`POST /git/switch`) ──────────────────────────────────────

/** Most clashing paths a conflict response lists. */
export const GIT_BRANCH_SWITCH_MAX_FILES = 200;
export const GIT_BRANCH_SWITCH_MAX_PATH_LENGTH = 4_096;
export const GIT_BRANCH_SWITCH_REASON_MAX_LENGTH = 2_000;
export const GIT_BRANCH_SWITCH_MAX_PANES = 100;
export const GIT_BRANCH_SWITCH_PANE_LABEL_MAX_LENGTH = 500;

export interface GitBranchSwitchRequest {
  /** Local branch name, or the name of a branch that exists only on `origin`. */
  branch: string;
}

export interface GitBranchSwitchSwitched {
  status: "switched";
  /** Null when HEAD was detached. */
  from: string | null;
  to: string;
  /** `origin/<branch>` when a local branch was just created to track it. */
  trackedRemote: string | null;
  /** Uncommitted changes existed and came along. */
  carriedChanges: boolean;
}

export interface GitBranchSwitchUnchanged {
  status: "unchanged";
  branch: string;
}

/**
 * Git refused the switch and nothing changed: uncommitted changes would be overwritten, or an unfinished merge/rebase/cherry-pick or unmerged conflicts block it. `files` lists the clashing paths, or the unmerged paths in the second case.
 */
export interface GitBranchSwitchConflict {
  status: "conflict";
  reason: string;
  files: string[];
  filesTruncated: boolean;
}

/** An agent session (or another switch) is running on this folder. */
export interface GitBranchSwitchBusy {
  status: "busy";
  reason: string;
  /** Titles of the busy panes. */
  panes: string[];
}

export interface GitBranchSwitchNotFound {
  status: "not-found";
  reason: string;
}

export interface GitBranchSwitchNotARepo {
  status: "not-a-repo";
}

export type GitBranchSwitchResponse =
  | GitBranchSwitchSwitched
  | GitBranchSwitchUnchanged
  | GitBranchSwitchConflict
  | GitBranchSwitchBusy
  | GitBranchSwitchNotFound
  | GitBranchSwitchNotARepo;

function isReason(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= GIT_BRANCH_SWITCH_REASON_MAX_LENGTH
  );
}

function isBoundedStringList(value: unknown, maxItems: number, maxLength: number): boolean {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => typeof item === "string" && item.length > 0 && item.length <= maxLength)
  );
}

export function isGitBranchSwitchResponse(value: unknown): value is GitBranchSwitchResponse {
  if (!isRecord(value)) return false;
  switch (value.status) {
    case "switched":
      return (
        isNullableBranchName(value.from) &&
        isBranchName(value.to) &&
        isNullableBranchName(value.trackedRemote) &&
        typeof value.carriedChanges === "boolean"
      );
    case "unchanged":
      return isBranchName(value.branch);
    case "conflict":
      return (
        isReason(value.reason) &&
        isBoundedStringList(
          value.files,
          GIT_BRANCH_SWITCH_MAX_FILES,
          GIT_BRANCH_SWITCH_MAX_PATH_LENGTH,
        ) &&
        typeof value.filesTruncated === "boolean"
      );
    case "busy":
      return (
        isReason(value.reason) &&
        isBoundedStringList(
          value.panes,
          GIT_BRANCH_SWITCH_MAX_PANES,
          GIT_BRANCH_SWITCH_PANE_LABEL_MAX_LENGTH,
        )
      );
    case "not-found":
      return isReason(value.reason);
    case "not-a-repo":
      return true;
    default:
      return false;
  }
}

// ── Branch create (`POST /git/branches/create`) ─────────────────────────────

export interface GitBranchCreateRequest {
  /** New local branch name, created from the current HEAD. */
  branch: string;
  /** Only check the name; nothing is created and no lock is taken. */
  checkOnly?: boolean;
}

export interface GitBranchCreateCreated {
  status: "created";
  /** Null when HEAD was detached. */
  from: string | null;
  to: string;
  /** Uncommitted changes existed and came along. */
  carriedChanges: boolean;
}

/** Check-only answer: the name is valid and free. */
export interface GitBranchCreateAvailable {
  status: "available";
  branch: string;
}

/** Git's naming rules reject the name. */
export interface GitBranchCreateInvalid {
  status: "invalid";
  reason: string;
}

/** A local branch already uses the name, or clashes with it as a folder/file. */
export interface GitBranchCreateTaken {
  status: "taken";
  reason: string;
}

export type GitBranchCreateResponse =
  | GitBranchCreateCreated
  | GitBranchCreateAvailable
  | GitBranchCreateInvalid
  | GitBranchCreateTaken
  | GitBranchSwitchBusy
  | GitBranchSwitchConflict
  | GitBranchSwitchNotARepo;

export function isGitBranchCreateResponse(value: unknown): value is GitBranchCreateResponse {
  if (!isRecord(value)) return false;
  switch (value.status) {
    case "created":
      return (
        isNullableBranchName(value.from) &&
        isBranchName(value.to) &&
        typeof value.carriedChanges === "boolean"
      );
    case "available":
      return isBranchName(value.branch);
    case "invalid":
    case "taken":
      return isReason(value.reason);
    case "busy":
    case "conflict":
    case "not-a-repo":
      return isGitBranchSwitchResponse(value);
    default:
      return false;
  }
}
