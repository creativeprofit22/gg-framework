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
  isResumePass,
  parseHeadCommit,
  planRefresh,
  queueAfterCheck,
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

const HOUR = 60 * 60_000;

type Row = { repo: string; commit: string; indexed_at: string };

function corpus(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    repo: `o/r${String(i).padStart(4, "0")}`,
    commit: sha(i),
    indexed_at: "2026-09-01T00:00:00Z",
  }));
}

const names = (rows: readonly Row[]): string[] => rows.map((r) => r.repo);

/** Records every CLI call; `add` fails for batches `failAdd` matches. */
function fakeCli(
  rows: readonly Row[],
  options: { failAdd?: (batch: string[]) => boolean; onAdd?: (batch: string[]) => void } = {},
): { exec: SteroidsExec; calls: string[][]; adds: () => string[][] } {
  const calls: string[][] = [];
  const exec: SteroidsExec = async (args) => {
    calls.push(args);
    if (args[0] === "repos") return { ok: true, stdout: JSON.stringify({ repositories: rows }) };
    if (args[0] === "add") {
      const batch = args.slice(2);
      options.onAdd?.(batch);
      if (options.failAdd?.(batch)) return { ok: false, stdout: "", error: "add failed" };
    }
    return { ok: true, stdout: "" };
  };
  return { exec, calls, adds: () => calls.filter((c) => c[0] === "add").map((c) => c.slice(2)) };
}

/** Upstream HEADs: repo i has moved when `moved(i)`; counts every HEAD read. */
function fakeHeads(moved: (i: number) => boolean): { fetchFn: typeof fetch; reads: () => number } {
  let reads = 0;
  const fetchFn = (async (url: string | URL | Request) => {
    reads++;
    const repo = /github\.com\/(.+)\/info\/refs/.exec(String(url))?.[1] ?? "";
    const i = Number(repo.slice(3));
    return new Response(new Uint8Array(advertisement(moved(i) ? sha(i + 100_000) : sha(i))));
  }) as typeof fetch;
  return { fetchFn, reads: () => reads };
}

function writeState(statePath: string, state: object): void {
  fs.writeFileSync(statePath, JSON.stringify(state));
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

  it("leaves exactly the moved repos a capped pass did not reach pending, in refresh order", async () => {
    const rows = corpus(MAX_UPDATES_PER_PASS + 16);
    const cli = fakeCli(rows);
    // Every repo moved except r0005, which must never enter the queue.
    const heads = fakeHeads((i) => i !== 5);
    const statePath = tempState();
    const outcome = await runSteroidsRefresh({
      bin: "steroids",
      statePath,
      signal: new AbortController().signal,
      now: () => 1_000,
      fetchFn: heads.fetchFn,
      exec: cli.exec,
    });

    const moved = names(rows).filter((repo) => repo !== "o/r0005");
    expect(outcome).toMatchObject({ status: "partial", mode: "full", deferred: 15, pending: 15 });
    const state = await readRefreshState(statePath);
    expect(state.pending).toEqual(moved.slice(MAX_UPDATES_PER_PASS));
    expect(state.lastCheckedAt).toBe(1_000);
    expect(cli.adds().flat()).toEqual(moved.slice(0, MAX_UPDATES_PER_PASS));
  });

  it("works the pending queue first on the hourly retry, without re-reading HEADs, until it empties", async () => {
    const rows = corpus(MAX_UPDATES_PER_PASS + 16);
    const cli = fakeCli(rows);
    const heads = fakeHeads(() => true);
    const statePath = tempState();
    const signal = new AbortController().signal;
    const first = await runSteroidsRefresh({
      bin: "steroids",
      statePath,
      signal,
      now: () => 1_000,
      fetchFn: heads.fetchFn,
      exec: cli.exec,
    });
    expect(first.status).toBe("partial");
    const readsAfterFirst = heads.reads();
    expect(readsAfterFirst).toBe(rows.length);
    const queued = (await readRefreshState(statePath)).pending ?? [];
    expect(queued).toEqual(names(rows).slice(MAX_UPDATES_PER_PASS));

    const addsBefore = cli.adds().length;
    const retry = await runSteroidsRefresh({
      bin: "steroids",
      statePath,
      signal,
      now: () => 1_000 + HOUR,
      fetchFn: heads.fetchFn,
      exec: cli.exec,
    });

    expect(heads.reads()).toBe(readsAfterFirst);
    expect(retry).toMatchObject({ status: "completed", mode: "resume", updated: 16, pending: 0 });
    expect(cli.adds().slice(addsBefore).flat()).toEqual(queued);
    expect(cli.calls.at(-1)).toEqual(["compact"]);
    const state = await readRefreshState(statePath);
    expect(state.pending).toBeUndefined();
    expect(isResumePass(state, 1_000 + HOUR + 1)).toBe(false);
    expect(isRefreshDue(state, 1_000 + 2 * HOUR)).toBe(false);
  });

  it("keeps carried entries ahead of newly moved repos on the daily check, once each", async () => {
    const rows = corpus(12);
    const statePath = tempState();
    writeState(statePath, {
      lastCheckedAt: 0,
      lastCompletedAt: 0,
      lastFinishedAt: 0,
      // r0004 is current again, gone/away left the corpus, r0009 is listed twice.
      pending: ["o/r0009", "o/r0004", "gone/away", "o/r0003", "o/r0009"],
    });
    const cli = fakeCli(rows);
    const heads = fakeHeads((i) => [1, 3, 7, 9].includes(i));
    const outcome = await runSteroidsRefresh({
      bin: "steroids",
      statePath,
      signal: new AbortController().signal,
      now: () => REFRESH_INTERVAL_MS + 1,
      fetchFn: heads.fetchFn,
      exec: cli.exec,
    });

    expect(outcome.mode).toBe("full");
    expect(heads.reads()).toBe(rows.length);
    expect(cli.adds()).toEqual([["o/r0009", "o/r0003", "o/r0001", "o/r0007"]]);
    expect((await readRefreshState(statePath)).pending).toBeUndefined();
  });

  it("keeps a failed batch queued in place and lets the daily pass retry it", async () => {
    const rows = corpus(30);
    const statePath = tempState();
    const queued = names(rows).slice(0, 25);
    writeState(statePath, { lastCheckedAt: 1_000, lastFinishedAt: 1_000, pending: queued });
    const cli = fakeCli(rows, { failAdd: (batch) => batch.includes("o/r0012") });
    const heads = fakeHeads(() => true);
    const outcome = await runSteroidsRefresh({
      bin: "steroids",
      statePath,
      signal: new AbortController().signal,
      now: () => 1_000 + HOUR,
      fetchFn: heads.fetchFn,
      exec: cli.exec,
    });

    expect(outcome).toMatchObject({ mode: "resume", failedBatches: 1, updated: 15, pending: 10 });
    // Nothing was deferred, so the broken batch waits a day instead of retrying hourly.
    expect(outcome.status).toBe("completed");
    const state = await readRefreshState(statePath);
    expect(state.pending).toEqual(queued.slice(10, 20));
    expect(isRefreshDue(state, 1_000 + 2 * HOUR)).toBe(false);
    expect(isResumePass(state, 1_000 + REFRESH_INTERVAL_MS)).toBe(false);
  });

  it("keeps every unrefreshed entry when the pass is cancelled mid-batch", async () => {
    const rows = corpus(30);
    const statePath = tempState();
    const queued = names(rows).slice(0, 30);
    writeState(statePath, { lastCheckedAt: 1_000, lastFinishedAt: 1_000, pending: queued });
    const controller = new AbortController();
    // Cancel while the second batch runs; its `add` reports failure like a killed child.
    let addCount = 0;
    const cli = fakeCli(rows, {
      onAdd: () => {
        addCount++;
        if (addCount === 2) controller.abort();
      },
      failAdd: () => controller.signal.aborted,
    });
    const outcome = await runSteroidsRefresh({
      bin: "steroids",
      statePath,
      signal: controller.signal,
      now: () => 1_000 + HOUR,
      fetchFn: fakeHeads(() => true).fetchFn,
      exec: cli.exec,
    });

    expect(outcome).toMatchObject({ status: "aborted", updated: 10, pending: 20 });
    expect(cli.calls.some((c) => c[0] === "compact")).toBe(false);
    const state = await readRefreshState(statePath);
    expect(state.pending).toEqual(queued.slice(10));
    expect(isRefreshDue(state, 1_000 + HOUR + 1)).toBe(true);
  });

  it("keeps the queue untouched when listing fails or every HEAD is unreachable", async () => {
    const statePath = tempState();
    const queued = ["o/r0001", "o/r0002"];
    writeState(statePath, { lastCheckedAt: 0, lastFinishedAt: 0, pending: queued });
    const failing: SteroidsExec = async () => ({ ok: false, stdout: "", error: "locked" });
    const listed = await runSteroidsRefresh({
      bin: "steroids",
      statePath,
      signal: new AbortController().signal,
      now: () => REFRESH_INTERVAL_MS + 1,
      exec: failing,
    });
    expect(listed).toMatchObject({ status: "failed", pending: 2 });
    expect((await readRefreshState(statePath)).pending).toEqual(queued);

    const offline = await runSteroidsRefresh({
      bin: "steroids",
      statePath,
      signal: new AbortController().signal,
      now: () => REFRESH_INTERVAL_MS + 2,
      fetchFn: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
      exec: fakeCli(corpus(4)).exec,
    });
    expect(offline).toMatchObject({ status: "offline", mode: "full", pending: 2 });
    expect((await readRefreshState(statePath)).pending).toEqual(queued);
  });

  it("loads a state file written before the pending queue existed and runs a full pass", async () => {
    const statePath = tempState();
    const legacy = {
      lastStartedAt: 10,
      lastFinishedAt: 20,
      lastCompletedAt: 20,
      verified: { "o/r0000": { commit: sha(0), at: 20 } },
    };
    writeState(statePath, legacy);
    const loaded = await readRefreshState(statePath);
    expect(loaded).toEqual(legacy);
    expect(isResumePass(loaded, 21)).toBe(false);

    const rows = corpus(3);
    const heads = fakeHeads((i) => i === 2);
    const cli = fakeCli(rows);
    const outcome = await runSteroidsRefresh({
      bin: "steroids",
      statePath,
      signal: new AbortController().signal,
      now: () => REFRESH_INTERVAL_MS + 30,
      fetchFn: heads.fetchFn,
      exec: cli.exec,
    });
    expect(outcome).toMatchObject({ status: "completed", mode: "full", updated: 1, pending: 0 });
    expect(heads.reads()).toBe(3);
    expect(cli.adds()).toEqual([["o/r0002"]]);
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

describe("queueAfterCheck", () => {
  it("keeps unreachable pending repos and appends new ones without duplicates", () => {
    const rows = corpus(4);
    const heads = new Map<string, string | null>([
      ["o/r0000", sha(0)],
      ["o/r0001", null],
      ["o/r0002", sha(9)],
      ["o/r0003", sha(8)],
    ]);
    expect(
      queueAfterCheck(["o/r0002", "o/r0001", "o/r0000"], rows, heads, ["o/r0002", "o/r0003"]),
    ).toEqual(["o/r0002", "o/r0001", "o/r0003"]);
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
      mode: "full",
      repos: 3,
      unchanged: 1,
      changed: 2,
      updated: 2,
      failedBatches: 0,
      deferred: 0,
      unreachable: 0,
      pending: 0,
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

  it("resumes a capped pass from the pending queue on the next hourly tick", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 21) });
    const rows = corpus(MAX_UPDATES_PER_PASS + 5);
    const cli = fakeCli(rows);
    const heads = fakeHeads(() => true);
    const outcomes: RefreshOutcome[] = [];
    const handle = startSteroidsRefresh({
      log: () => {},
      statePath: tempState(),
      findBin: () => "steroids",
      runPass: (opts) => runSteroidsRefresh({ ...opts, fetchFn: heads.fetchFn, exec: cli.exec }),
      onPass: (o) => outcomes.push(o),
    });
    try {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await vi.waitFor(() => expect(outcomes).toHaveLength(1));
      expect(outcomes[0]).toMatchObject({ status: "partial", mode: "full", pending: 5 });
      const reads = heads.reads();

      await vi.advanceTimersByTimeAsync(HOUR);
      await vi.waitFor(() => expect(outcomes).toHaveLength(2));
      expect(outcomes[1]).toMatchObject({ status: "completed", mode: "resume", updated: 5 });
      expect(heads.reads()).toBe(reads);
      expect(cli.adds().at(-1)).toEqual(names(rows).slice(MAX_UPDATES_PER_PASS));

      // Completed: the next hourly tick does nothing.
      await vi.advanceTimersByTimeAsync(HOUR);
      expect(outcomes).toHaveLength(2);
    } finally {
      handle.dispose();
    }
  });
});
