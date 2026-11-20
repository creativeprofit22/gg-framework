// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  // Pane readiness listens on the current window before polling pane status.
  getCurrentWebviewWindow: () => ({
    label: "main",
    setTitle: vi.fn(),
    listen: vi.fn(async () => () => {}),
  }),
}));

import { getGitBranches, type GitBranchListResponse } from "./agent";

afterEach(() => clearMocks());

const OK: GitBranchListResponse = {
  status: "ok",
  current: { name: "main", detached: false, commit: "abc1234" },
  hasCommits: true,
  remote: "origin",
  defaultBranch: { name: "main", source: "remote-head" },
  local: [
    {
      name: "main",
      current: true,
      lastUsedAt: "2026-11-20T10:00:00.000Z",
      upstream: "origin/main",
    },
  ],
  remoteOnly: [{ name: "release", remoteRef: "origin/release", lastCommitAt: null }],
  localTotal: 1,
  remoteOnlyTotal: 1,
  truncated: false,
};

function respond(payload: unknown, paneReady = true) {
  const calls: Array<{ command: string; args: unknown }> = [];
  mockIPC((command, args) => {
    calls.push({ command, args });
    if (command === "agent_pane_status") {
      return { ready: paneReady, error: null, generation: 1, sessionId: "session-1" };
    }
    if (command === "agent_git_branches") return payload;
    return null;
  });
  return calls;
}

describe("getGitBranches", () => {
  it("waits for the pane, then forwards the search and limit", async () => {
    const calls = respond(OK);
    expect(await getGitBranches({ query: "feat", limit: 20, paneId: "pane-2" })).toEqual(OK);
    const names = calls.map((call) => call.command);
    const status = names.indexOf("agent_pane_status");
    const branches = names.indexOf("agent_git_branches");
    expect(status).toBeGreaterThanOrEqual(0);
    expect(branches).toBeGreaterThan(status);
    expect(calls[status]!.args).toMatchObject({ paneId: "pane-2" });
    expect(calls[branches]!.args).toMatchObject({ paneId: "pane-2", query: "feat", limit: 20 });
  });

  it("defaults to the primary pane and accepts not-a-repo", async () => {
    const calls = respond({ status: "not-a-repo" });
    expect(await getGitBranches()).toEqual({ status: "not-a-repo" });
    const call = calls.find((entry) => entry.command === "agent_git_branches");
    expect(call?.args).toMatchObject({ paneId: "primary" });
  });

  it("clamps the limit to a whole number the Rust u32 accepts", async () => {
    const calls = respond(OK);
    await getGitBranches({ limit: 7.9 });
    await getGitBranches({ limit: -3 });
    await getGitBranches({});
    const limits = calls
      .filter((call) => call.command === "agent_git_branches")
      .map((call) => (call.args as { limit?: number }).limit);
    expect(limits).toEqual([7, 1, undefined]);
  });

  it("does not ask for branches before the pane is ready", async () => {
    vi.useFakeTimers();
    try {
      const calls = respond(OK, false);
      void getGitBranches().catch(() => {});
      await vi.advanceTimersByTimeAsync(1_500);
      expect(calls.some((call) => call.command === "agent_pane_status")).toBe(true);
      expect(calls.some((call) => call.command === "agent_git_branches")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    null,
    { status: "error" },
    { ...OK, local: "main" },
    { ...OK, localTotal: -1 },
    { ...OK, current: { name: "main", detached: true, commit: null } },
  ])("rejects an off-shape response %#", async (payload) => {
    respond(payload);
    await expect(getGitBranches()).rejects.toThrow("Invalid branch list response");
  });
});
