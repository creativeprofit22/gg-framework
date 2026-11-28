import path from "node:path";
import {
  GIT_BRANCH_SWITCH_MAX_PANES,
  GIT_BRANCH_SWITCH_PANE_LABEL_MAX_LENGTH,
  type GitBranchCreateResponse,
  type GitBranchSwitchBusy,
  type GitBranchSwitchResponse,
} from "@kenkaiiii/gg-core/git-branch-contract";
import type { GitBranchSnapshot } from "./utils/git-branches.js";

/** One live pane whose working folder is the project being switched. */
export interface GitSwitchPeer {
  id: string;
  /** Conversation title shown to the user. */
  label: string;
  isBusy: () => boolean;
  noteBranchChange: (from: string | null, to: string) => void;
}

interface GitBranchGuardOptions {
  cwd: string;
  branch: string;
  /** Every live pane on `cwd`, including the one asking. */
  peers: readonly GitSwitchPeer[];
  /** Re-read git state; the shared poller fans it out to every pane on the folder. */
  refresh: () => Promise<void>;
  /** Daemon-wide folders with a branch switch or create running right now. */
  inFlight: Set<string>;
  onRefreshError?: (error: unknown) => void;
}

export interface RunGitBranchSwitchOptions extends GitBranchGuardOptions {
  switchBranch: (cwd: string, branch: string) => Promise<GitBranchSwitchResponse>;
}

export interface RunGitBranchCreateOptions extends GitBranchGuardOptions {
  createBranch: (cwd: string, branch: string) => Promise<GitBranchCreateResponse>;
}

export const GIT_SWITCH_RUN_BLOCKED_MESSAGE =
  "A branch switch is running in this project. Try again when it finishes.";

/** 409 body for a run refused because its folder is mid-switch. */
export function gitSwitchRunConflictBody(): { error: string; message: string } {
  return { error: "git_switch_running", message: GIT_SWITCH_RUN_BLOCKED_MESSAGE };
}

/** Whether a branch switch is running in `cwd` right now. */
export function gitSwitchRunningAt(inFlight: ReadonlySet<string>, cwd: string): boolean {
  return inFlight.has(path.resolve(cwd));
}

const UNTITLED = "Untitled chat";
const REASON_LABEL_LENGTH = 60;

function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function busyReason(action: string, labels: readonly string[]): string {
  const shown = labels.slice(0, 3).map((label) => `"${shorten(label, REASON_LABEL_LENGTH)}"`);
  const more = labels.length > 3 ? ` and ${labels.length - 3} more` : "";
  const subject = labels.length === 1 ? "an agent is" : "agents are";
  return (
    `Can't ${action} while ${subject} working in this project (${shown.join(", ")}${more}). ` +
    "Wait for it to finish or stop it first."
  );
}

/**
 * Run a branch change unless an agent on the folder is working or another
 * switch/create is running there; once the branch moved, tell every pane's
 * agent and refresh git state.
 */
async function guardBranchChange<T>(
  options: GitBranchGuardOptions,
  action: string,
  run: () => Promise<T>,
  moved: (result: T) => { from: string | null; to: string } | null,
): Promise<T | GitBranchSwitchBusy> {
  const key = path.resolve(options.cwd);
  if (options.inFlight.has(key)) {
    return { status: "busy", reason: "A branch switch is already running here.", panes: [] };
  }
  const busy = options.peers.filter((peer) => peer.isBusy());
  if (busy.length > 0) {
    const labels = busy
      .slice(0, GIT_BRANCH_SWITCH_MAX_PANES)
      .map((peer) =>
        shorten(peer.label.trim() || UNTITLED, GIT_BRANCH_SWITCH_PANE_LABEL_MAX_LENGTH),
      );
    return { status: "busy", reason: busyReason(action, labels), panes: labels };
  }

  options.inFlight.add(key);
  try {
    const result = await run();
    const change = moved(result);
    if (change) {
      for (const peer of options.peers) peer.noteBranchChange(change.from, change.to);
      await options.refresh().catch((error: unknown) => options.onRefreshError?.(error));
    }
    return result;
  } finally {
    options.inFlight.delete(key);
  }
}

/** Switch the folder's branch under the shared guard. */
export function runGitBranchSwitch(
  options: RunGitBranchSwitchOptions,
): Promise<GitBranchSwitchResponse> {
  return guardBranchChange(
    options,
    "switch branches",
    () => options.switchBranch(options.cwd, options.branch),
    (result) => (result.status === "switched" ? result : null),
  );
}

/** Create a branch from HEAD and switch to it, under the same guard as switching. */
export function runGitBranchCreate(
  options: RunGitBranchCreateOptions,
): Promise<GitBranchCreateResponse> {
  return guardBranchChange(
    options,
    "create a branch",
    () => options.createBranch(options.cwd, options.branch),
    (result) => (result.status === "created" ? result : null),
  );
}

const BRANCH_SNAPSHOT_TTL_MS = 30_000;

/**
 * The branch list read when the switcher opens, reused while the user types a
 * search so each keystroke doesn't re-run git. Opening always reads fresh.
 */
export class GitBranchSnapshotCache {
  private readonly entries = new Map<string, { at: number; snapshot: GitBranchSnapshot | null }>();

  constructor(
    private readonly ttlMs = BRANCH_SNAPSHOT_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  async get(
    cwd: string,
    options: { fresh: boolean },
    read: () => Promise<GitBranchSnapshot | null>,
  ): Promise<GitBranchSnapshot | null> {
    const key = path.resolve(cwd);
    const hit = this.entries.get(key);
    if (!options.fresh && hit && this.now() - hit.at < this.ttlMs) return hit.snapshot;
    const snapshot = await read();
    this.entries.set(key, { at: this.now(), snapshot });
    return snapshot;
  }

  invalidate(cwd: string): void {
    this.entries.delete(path.resolve(cwd));
  }
}
