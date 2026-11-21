import path from "node:path";
import {
  GIT_BRANCH_SWITCH_MAX_PANES,
  GIT_BRANCH_SWITCH_PANE_LABEL_MAX_LENGTH,
  type GitBranchSwitchResponse,
} from "@kenkaiiii/gg-core/git-branch-contract";

/** One live pane whose working folder is the project being switched. */
export interface GitSwitchPeer {
  id: string;
  /** Conversation title shown to the user. */
  label: string;
  isBusy: () => boolean;
  noteBranchChange: (from: string | null, to: string) => void;
}

export interface RunGitBranchSwitchOptions {
  cwd: string;
  branch: string;
  /** Every live pane on `cwd`, including the one asking. */
  peers: readonly GitSwitchPeer[];
  switchBranch: (cwd: string, branch: string) => Promise<GitBranchSwitchResponse>;
  /** Re-read git state; the shared poller fans it out to every pane on the folder. */
  refresh: () => Promise<void>;
  /** Daemon-wide folders with a switch running right now. */
  inFlight: Set<string>;
  onRefreshError?: (error: unknown) => void;
}

const UNTITLED = "Untitled chat";
const REASON_LABEL_LENGTH = 60;

function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function busyReason(labels: readonly string[]): string {
  const shown = labels.slice(0, 3).map((label) => `"${shorten(label, REASON_LABEL_LENGTH)}"`);
  const more = labels.length > 3 ? ` and ${labels.length - 3} more` : "";
  const subject = labels.length === 1 ? "an agent is" : "agents are";
  return (
    `Can't switch branches while ${subject} working in this project (${shown.join(", ")}${more}). ` +
    "Wait for it to finish or stop it first."
  );
}

/**
 * Switch the folder's branch unless an agent there is working or another
 * switch is running; afterwards tell every pane's agent and refresh git state.
 */
export async function runGitBranchSwitch(
  options: RunGitBranchSwitchOptions,
): Promise<GitBranchSwitchResponse> {
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
    return { status: "busy", reason: busyReason(labels), panes: labels };
  }

  options.inFlight.add(key);
  try {
    const result = await options.switchBranch(options.cwd, options.branch);
    if (result.status === "switched") {
      for (const peer of options.peers) peer.noteBranchChange(result.from, result.to);
      await options.refresh().catch((error: unknown) => options.onRefreshError?.(error));
    }
    return result;
  } finally {
    options.inFlight.delete(key);
  }
}
