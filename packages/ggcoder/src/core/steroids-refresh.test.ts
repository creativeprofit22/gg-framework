import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BATCH_SIZE,
  MAX_UPDATES_PER_PASS,
  REFRESH_INTERVAL_MS,
  defaultRefreshStatePath,
  isRefreshDue,
  parseHeadCommit,
  planRefresh,
  readRefreshState,
  runSteroidsRefresh,
  startSteroidsRefresh,
  type RefreshOutcome,
  type SteroidsExec,
} from "./steroids-refresh.js";

const sha = (n: number): string => n.toString(16).padStart(40, "0");

function pkt(payload: string): string {
  return (payload.length + 4).toString(16).padStart(4, "0") + payload;
}

function advertisement(head: string): Buffer {
  return Buffer.from(
    pkt("# service=git-upload-pack\n") +
      "0000" +
      pkt(`${head} HEAD\0multi_ack symref=HEAD:refs/heads/main\n`) +
      pkt(`${head} refs/heads/main\n`) +
      "0000",
    "latin1",
  );
}

function tempState(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "steroids-refresh-"));
  return path.join(dir, "state.json");
}

describe("defaultRefreshStatePath", () => {
  it("is shared across app identities, not tied to GG_AGENT_DIR", () => {
    const previous = process.env.GG_AGENT_DIR;
    const identityDir = fs.mkdtempSync(path.join(os.tmpdir(), "steroids-identity-"));
    try {
      delete process.env.GG_AGENT_DIR;
      const shared = defaultRefreshStatePath();
      process.env.GG_AGENT_DIR = identityDir;
      expect(defaultRefreshStatePath()).toBe(shared);
      expect(shared).toBe(path.join(os.homedir(), ".gg", "steroids-refresh.json"));
    } finally {
      if (previous === undefined) delete process.env.GG_AGENT_DIR;
      else process.env.GG_AGENT_DIR = previous;
      fs.rmSync(identityDir, { recursive: true, force: true });
    }
  });
});

describe("parseHeadCommit", () => {
  it("reads HEAD after the service banner and flush packet", () => {
    expect(parseHeadCommit(advertisement(sha(7)))).toBe(sha(7));
  });

  it("returns null for truncated or foreign bodies", () => {
    expect(parseHeadCommit(advertisement(sha(7)).subarray(0, 40))).toBeNull();
    expect(parseHeadCommit(Buffer.from("<html>rate limited</html>"))).toBeNull();
  });
});

describe("planRefresh", () => {
  it("orders by oldest index then name and keeps only still-valid prior checks", () => {
    const rows = [
      { repo: "b/new", commit: sha(1), indexed_at: "2026-10-10T00:00:00Z" },
      { repo: "z/old", commit: sha(2), indexed_at: "2026-09-01T00:00:00Z" },
      { repo: "a/old", commit: sha(3), indexed_at: "2026-09-01T00:00:00Z" },
      { repo: "c/same", commit: sha(4), indexed_at: "2026-09-05T00:00:00Z" },
      { repo: "d/down", commit: sha(5), indexed_at: "2026-09-05T00:00:00Z" },
      { repo: "e/down", commit: sha(6), indexed_at: "2026-09-05T00:00:00Z" },
    ];
    const heads = new Map<string, string | null>([
      ["b/new", sha(10)],
      ["z/old", sha(20)],
      ["a/old", sha(30)],
      ["c/same", sha(4)],
      ["d/down", null],
      ["e/down", null],
    ]);
    const previous = { "d/down": { commit: sha(5), at: 1 }, "e/down": { commit: sha(99), at: 1 } };
    const plan = planRefresh(rows, heads, previous, 500);
    expect(plan.changed).toEqual(["a/old", "z/old", "b/new"]);
    expect(plan.verified).toEqual({
      "c/same": { commit: sha(4), at: 500 },
      "d/down": previous["d/down"],
    });
    expect(plan.unchanged).toBe(1);
    expect(plan.unreachable).toBe(2);
  });
});

describe("isRefreshDue", () => {
  it("runs first, waits a day after completion, resumes partial passes, and skips in-flight ones", () => {
    const now = 10 * REFRESH_INTERVAL_MS;
    expect(isRefreshDue({}, now)).toBe(true);
    expect(
      isRefreshDue(
        { lastStartedAt: now - 5, lastFinishedAt: now - 1, lastCompletedAt: now - 1 },
        now,
      ),
    ).toBe(false);
    expect(isRefreshDue({ lastStartedAt: 0, lastFinishedAt: 1, lastCompletedAt: 1 }, now)).toBe(
      true,
    );
    expect(
      isRefreshDue(
        { lastStartedAt: now - 9, lastFinishedAt: now - 5, lastCompletedAt: now - 20 },
        now,
      ),
    ).toBe(true);
    expect(
      isRefreshDue(
        { lastStartedAt: now - 5, lastFinishedAt: now - 9, lastCompletedAt: now - 9 },
        now,
      ),
    ).toBe(false);
  });
});

describe("runSteroidsRefresh", () => {
  it("re-adds only moved repos, in capped batches, then compacts and records the pass", async () => {
    const total = MAX_UPDATES_PER_PASS + 15;
    const rows = Array.from({ length: total + 1 }, (_, i) => ({
      repo: `o/r${String(i).padStart(4, "0")}`,
      commit: sha(i),
      indexed_at: "2026-09-01T00:00:00Z",
    }));
    const calls: string[][] = [];
    const exec: SteroidsExec = async (args) => {
      calls.push(args);
      return {
        ok: true,
        stdout: args[0] === "repos" ? JSON.stringify({ repositories: rows }) : "",
      };
    };
    // Every repo moved except the last, which is still on its indexed commit.
    const fetchFn = (async (url: string | URL | Request) => {
      const repo = /github\.com\/(.+)\/info\/refs/.exec(String(url))?.[1] ?? "";
      const i = Number(repo.slice(3));
      return new Response(new Uint8Array(advertisement(i === total ? sha(i) : sha(i + 100_000))));
    }) as typeof fetch;
    const statePath = tempState();
    const outcome = await runSteroidsRefresh({
      bin: "steroids",
      statePath,
      signal: new AbortController().signal,
      now: () => 1_000,
      fetchFn,
      exec,
    });

    expect(outcome).toMatchObject({
      status: "partial",
      repos: total + 1,
      unchanged: 1,
      changed: total,
      updated: MAX_UPDATES_PER_PASS,
      deferred: 15,
    });
    const adds = calls.filter((c) => c[0] === "add");
    expect(adds).toHaveLength(MAX_UPDATES_PER_PASS / BATCH_SIZE);
    expect(adds[0]).toEqual(["add", "--", ...rows.slice(0, BATCH_SIZE).map((r) => r.repo)]);
    expect(adds.every((c) => c.length === BATCH_SIZE + 2)).toBe(true);
    expect(calls.at(-1)).toEqual(["compact"]);
    const state = await readRefreshState(statePath);
    expect(state.verified).toEqual({
      [rows[total]?.repo ?? ""]: { commit: sha(total), at: 1_000 },
    });
    expect(state.lastCompletedAt).toBeUndefined();
    expect(isRefreshDue(state, 1_001)).toBe(true);
  });

  it("treats a pass where no HEAD could be read as offline and downloads nothing", async () => {
    const calls: string[][] = [];
    const exec: SteroidsExec = async (args) => {
      calls.push(args);
      return {
        ok: true,
        stdout: JSON.stringify({ repositories: [{ repo: "a/b", commit: sha(1) }] }),
      };
    };
    const fetchFn = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const outcome = await runSteroidsRefresh({
      bin: "steroids",
      statePath: tempState(),
      signal: new AbortController().signal,
      fetchFn,
      exec,
    });
    expect(outcome.status).toBe("offline");
    expect(calls).toEqual([["repos", "--json"]]);
  });
});

describe("startSteroidsRefresh", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("hands each finished pass's outcome to onPass", async () => {
    vi.useFakeTimers();
    const outcome: RefreshOutcome = {
      status: "completed",
      repos: 3,
      unchanged: 1,
      changed: 2,
      updated: 2,
      failedBatches: 0,
      deferred: 0,
      unreachable: 0,
    };
    const runPass = vi.fn(async () => outcome);
    const onPass = vi.fn<(o: RefreshOutcome) => void>();
    const handle = startSteroidsRefresh({
      log: () => {},
      statePath: tempState(),
      findBin: () => "steroids",
      runPass,
      onPass,
    });
    try {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await vi.waitFor(() => expect(onPass).toHaveBeenCalledTimes(1));
      expect(onPass).toHaveBeenCalledWith(outcome);
      expect(runPass).toHaveBeenCalledTimes(1);
    } finally {
      handle.dispose();
    }
  });
});
