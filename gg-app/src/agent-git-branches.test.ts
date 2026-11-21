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

import {
  checkGitBranchName,
  createGitBranch,
  getGitBranches,
  switchGitBranch,
  type GitBranchListResponse,
} from "./agent";

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
    if (
      command === "agent_git_branches" ||
      command === "agent_git_switch_branch" ||
      command === "agent_git_create_branch"
    ) {
      return payload;
    }
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

describe("switchGitBranch", () => {
  const SWITCHED = {
    status: "switched",
    from: "main",
    to: "feature/x",
    trackedRemote: null,
    carriedChanges: true,
  };

  it("waits for the pane, then sends the pane and branch", async () => {
    const calls = respond(SWITCHED);
    expect(await switchGitBranch({ branch: "feature/x", paneId: "pane-2" })).toEqual(SWITCHED);
    const names = calls.map((call) => call.command);
    const status = names.indexOf("agent_pane_status");
    const switched = names.indexOf("agent_git_switch_branch");
    expect(status).toBeGreaterThanOrEqual(0);
    expect(switched).toBeGreaterThan(status);
    expect(calls[switched]!.args).toEqual({ paneId: "pane-2", branch: "feature/x" });
  });

  it("returns refusals as statuses", async () => {
    const busy = { status: "busy", reason: "An agent is working", panes: ["Fix login"] };
    respond(busy);
    expect(await switchGitBranch({ branch: "main" })).toEqual(busy);
  });

  it("does not switch before the pane is ready", async () => {
    vi.useFakeTimers();
    try {
      const calls = respond(SWITCHED, false);
      void switchGitBranch({ branch: "main" }).catch(() => {});
      await vi.advanceTimersByTimeAsync(1_500);
      expect(calls.some((call) => call.command === "agent_git_switch_branch")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    null,
    { status: "ok" },
    { ...SWITCHED, to: "" },
    { status: "conflict", reason: "Clash", files: "a.txt", filesTruncated: false },
  ])("rejects an off-shape response %#", async (payload) => {
    respond(payload);
    await expect(switchGitBranch({ branch: "main" })).rejects.toThrow(
      "Invalid branch switch response",
    );
  });
});

describe("createGitBranch and checkGitBranchName", () => {
  const CREATED = { status: "created", from: "main", to: "feature/new", carriedChanges: false };

  it("waits for the pane, then creates with checkOnly off", async () => {
    const calls = respond(CREATED);
    expect(await createGitBranch({ branch: "feature/new", paneId: "pane-2" })).toEqual(CREATED);
    const names = calls.map((call) => call.command);
    const status = names.indexOf("agent_pane_status");
    const created = names.indexOf("agent_git_create_branch");
    expect(status).toBeGreaterThanOrEqual(0);
    expect(created).toBeGreaterThan(status);
    expect(calls[created]!.args).toEqual({
      paneId: "pane-2",
      branch: "feature/new",
      checkOnly: false,
    });
  });

  it("checks names with checkOnly on and returns plain-reason statuses", async () => {
    const taken = { status: "taken", reason: 'A branch called "main" already exists.' };
    const calls = respond(taken);
    expect(await checkGitBranchName({ branch: "main" })).toEqual(taken);
    const call = calls.find((entry) => entry.command === "agent_git_create_branch");
    expect(call?.args).toEqual({ paneId: "primary", branch: "main", checkOnly: true });
  });

  it("does not create before the pane is ready", async () => {
    vi.useFakeTimers();
    try {
      const calls = respond(CREATED, false);
      void createGitBranch({ branch: "x" }).catch(() => {});
      await vi.advanceTimersByTimeAsync(1_500);
      expect(calls.some((call) => call.command === "agent_git_create_branch")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    null,
    { status: "switched", from: "main", to: "x", trackedRemote: null, carriedChanges: false },
    { ...CREATED, to: "" },
    { status: "invalid", reason: "" },
  ])("rejects an off-shape response %#", async (payload) => {
    respond(payload);
    await expect(createGitBranch({ branch: "x" })).rejects.toThrow(
      "Invalid branch create response",
    );
    await expect(checkGitBranchName({ branch: "x" })).rejects.toThrow(
      "Invalid branch create response",
    );
  });
});
