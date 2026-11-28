import type {
  GitBranchCreateResponse,
  GitBranchSwitchResponse,
} from "@kenkaiiii/gg-core/git-branch-contract";
import { describe, expect, it, vi, type Mock } from "vitest";
import {
  GitBranchSnapshotCache,
  runGitBranchCreate,
  runGitBranchSwitch,
  type GitSwitchPeer,
} from "./app-sidecar-git-switch.js";

const switched: GitBranchSwitchResponse = {
  status: "switched",
  from: "main",
  to: "feature",
  trackedRemote: null,
  carriedChanges: false,
};

function peer(
  id: string,
  label: string,
  busy = false,
): GitSwitchPeer & { noteBranchChange: Mock<GitSwitchPeer["noteBranchChange"]> } {
  return {
    id,
    label,
    isBusy: () => busy,
    noteBranchChange: vi.fn<GitSwitchPeer["noteBranchChange"]>(),
  };
}

function setup(result: GitBranchSwitchResponse = switched) {
  return {
    switchBranch: vi.fn(async () => result),
    refresh: vi.fn(async () => {}),
    inFlight: new Set<string>(),
  };
}

describe("runGitBranchSwitch", () => {
  it("refuses while an agent on the folder is busy, naming the pane, and never runs git", async () => {
    const deps = setup();
    const peers = [peer("a", "Fix login", true), peer("b", "", true), peer("c", "Idle one")];
    const result = await runGitBranchSwitch({ cwd: "/p", branch: "feature", peers, ...deps });
    expect(result.status).toBe("busy");
    if (result.status !== "busy") throw new Error("expected busy");
    expect(result.panes).toEqual(["Fix login", "Untitled chat"]);
    expect(result.reason).toContain('"Fix login"');
    expect(deps.switchBranch).not.toHaveBeenCalled();
    expect(deps.refresh).not.toHaveBeenCalled();
    expect(peers[2]!.noteBranchChange).not.toHaveBeenCalled();
    expect(deps.inFlight.size).toBe(0);
  });

  it("refuses a second switch on the same folder while one is running", async () => {
    let release!: () => void;
    const deps = setup();
    deps.switchBranch.mockImplementationOnce(
      () => new Promise<GitBranchSwitchResponse>((resolve) => (release = () => resolve(switched))),
    );
    const first = runGitBranchSwitch({ cwd: "/p", branch: "feature", peers: [], ...deps });
    const second = await runGitBranchSwitch({ cwd: "/p/", branch: "other", peers: [], ...deps });
    expect(second).toMatchObject({
      status: "busy",
      reason: "A branch switch is already running here.",
    });
    expect(deps.switchBranch).toHaveBeenCalledTimes(1);
    release();
    expect(await first).toEqual(switched);
    expect(deps.inFlight.size).toBe(0);
  });

  it("tells every pane on the folder and refreshes after a switch", async () => {
    const deps = setup();
    const order: string[] = [];
    const peers = [peer("a", "One"), peer("b", "Two")];
    for (const p of peers) p.noteBranchChange.mockImplementation(() => order.push(`note:${p.id}`));
    deps.refresh.mockImplementation(async () => {
      order.push("refresh");
    });
    expect(await runGitBranchSwitch({ cwd: "/p", branch: "feature", peers, ...deps })).toEqual(
      switched,
    );
    for (const p of peers) expect(p.noteBranchChange).toHaveBeenCalledWith("main", "feature");
    expect(order).toEqual(["note:a", "note:b", "refresh"]);
  });

  it("still reports the switch when the refresh fails", async () => {
    const deps = setup();
    deps.refresh.mockRejectedValueOnce(new Error("slow git"));
    const onRefreshError = vi.fn();
    const result = await runGitBranchSwitch({
      cwd: "/p",
      branch: "feature",
      peers: [],
      ...deps,
      onRefreshError,
    });
    expect(result).toEqual(switched);
    expect(onRefreshError).toHaveBeenCalledOnce();
  });

  it("sends no note and no refresh when git refuses", async () => {
    const deps = setup({
      status: "conflict",
      reason: "Clash",
      files: ["a.txt"],
      filesTruncated: false,
    });
    const peers = [peer("a", "One")];
    const result = await runGitBranchSwitch({ cwd: "/p", branch: "feature", peers, ...deps });
    expect(result.status).toBe("conflict");
    expect(peers[0]!.noteBranchChange).not.toHaveBeenCalled();
    expect(deps.refresh).not.toHaveBeenCalled();
    expect(deps.inFlight.size).toBe(0);
  });

  it("releases the folder when git throws", async () => {
    const deps = setup();
    deps.switchBranch.mockRejectedValueOnce(new Error("boom"));
    await expect(
      runGitBranchSwitch({ cwd: "/p", branch: "feature", peers: [], ...deps }),
    ).rejects.toThrow("boom");
    expect(deps.inFlight.size).toBe(0);
  });
});

describe("runGitBranchCreate", () => {
  const created: GitBranchCreateResponse = {
    status: "created",
    from: "main",
    to: "feature/new",
    carriedChanges: true,
  };

  function createDeps(result: GitBranchCreateResponse = created) {
    return {
      createBranch: vi.fn(async () => result),
      refresh: vi.fn(async () => {}),
      inFlight: new Set<string>(),
    };
  }

  it("refuses while an agent on the folder is busy and never runs git", async () => {
    const deps = createDeps();
    const peers = [peer("a", "Fix login", true), peer("b", "Idle")];
    const result = await runGitBranchCreate({ cwd: "/p", branch: "feature/new", peers, ...deps });
    expect(result).toMatchObject({ status: "busy", panes: ["Fix login"] });
    if (result.status === "busy") expect(result.reason).toMatch(/^Can't create a branch while/);
    expect(deps.createBranch).not.toHaveBeenCalled();
    expect(deps.refresh).not.toHaveBeenCalled();
    expect(peers[1]!.noteBranchChange).not.toHaveBeenCalled();
    expect(deps.inFlight.size).toBe(0);
  });

  it("tells every pane on the folder, then refreshes", async () => {
    const deps = createDeps();
    const order: string[] = [];
    const peers = [peer("a", "One"), peer("b", "Two")];
    for (const p of peers) p.noteBranchChange.mockImplementation(() => order.push(`note:${p.id}`));
    deps.refresh.mockImplementation(async () => {
      order.push("refresh");
    });
    const result = await runGitBranchCreate({ cwd: "/p", branch: "feature/new", peers, ...deps });
    expect(result).toEqual(created);
    for (const p of peers) expect(p.noteBranchChange).toHaveBeenCalledWith("main", "feature/new");
    expect(order).toEqual(["note:a", "note:b", "refresh"]);
    expect(deps.inFlight.size).toBe(0);
  });

  it("shares the in-flight lock with a running switch", async () => {
    let release: () => void = () => {};
    const switchDeps = setup();
    switchDeps.switchBranch.mockImplementationOnce(
      () =>
        new Promise<GitBranchSwitchResponse>((resolve) => {
          release = () => resolve(switched);
        }),
    );
    const deps = { ...createDeps(), inFlight: switchDeps.inFlight };
    const running = runGitBranchSwitch({ cwd: "/p", branch: "feature", peers: [], ...switchDeps });
    const result = await runGitBranchCreate({ cwd: "/p/", branch: "x", peers: [], ...deps });
    expect(result).toMatchObject({ status: "busy", panes: [] });
    expect(deps.createBranch).not.toHaveBeenCalled();
    release();
    await running;
    expect(switchDeps.inFlight.size).toBe(0);
  });

  it("sends no note and no refresh for taken or invalid names", async () => {
    const refusals: GitBranchCreateResponse[] = [
      { status: "taken", reason: "Already exists" },
      { status: "invalid", reason: "Bad name" },
    ];
    for (const refusal of refusals) {
      const deps = createDeps(refusal);
      const peers = [peer("a", "One")];
      const result = await runGitBranchCreate({ cwd: "/p", branch: "x", peers, ...deps });
      expect(result).toEqual(refusal);
      expect(peers[0]!.noteBranchChange).not.toHaveBeenCalled();
      expect(deps.refresh).not.toHaveBeenCalled();
      expect(deps.inFlight.size).toBe(0);
    }
  });
});

describe("GitBranchSnapshotCache", () => {
  const snap = (name: string) => ({
    currentName: name,
    commit: "abc",
    hasRemote: false,
    defaultBranch: null,
    local: [],
    remoteOnly: [],
  });

  it("reads fresh on open, reuses the read for searches until it expires or is invalidated", async () => {
    let now = 0;
    const cache = new GitBranchSnapshotCache(1_000, () => now);
    const read = vi.fn().mockResolvedValueOnce(snap("a")).mockResolvedValue(snap("b"));

    expect((await cache.get("/p", { fresh: true }, read))?.currentName).toBe("a");
    expect((await cache.get("/p", { fresh: false }, read))?.currentName).toBe("a");
    expect(read).toHaveBeenCalledTimes(1);

    now = 1_000;
    expect((await cache.get("/p", { fresh: false }, read))?.currentName).toBe("b");
    expect(read).toHaveBeenCalledTimes(2);

    cache.invalidate("/p");
    await cache.get("/p", { fresh: false }, read);
    expect(read).toHaveBeenCalledTimes(3);
    await cache.get("/p", { fresh: true }, read);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("caches nothing when the read fails", async () => {
    const cache = new GitBranchSnapshotCache();
    const read = vi.fn().mockRejectedValueOnce(new Error("aborted")).mockResolvedValue(snap("a"));
    await expect(cache.get("/p", { fresh: true }, read)).rejects.toThrow("aborted");
    expect((await cache.get("/p", { fresh: false }, read))?.currentName).toBe("a");
  });
});
