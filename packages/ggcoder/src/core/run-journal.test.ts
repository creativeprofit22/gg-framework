import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RunLifecycle, type RunJournalWriter } from "./run-lifecycle.js";
import {
  SessionManager,
  RUN_STARTED_CUSTOM_KIND,
  RUN_FINISHED_CUSTOM_KIND,
  type RunOutcome,
  type SessionEntry,
} from "./session-manager.js";

function recordingJournal(): { writer: RunJournalWriter; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    writer: {
      started: (generation) => calls.push(`start:${generation}`),
      finished: (generation, outcome) => calls.push(`finish:${generation}:${outcome}`),
    },
  };
}

function startedEntry(generation: number, afterMessageCount = 0): SessionEntry {
  return {
    type: "custom",
    kind: RUN_STARTED_CUSTOM_KIND,
    id: `s${generation}`,
    parentId: null,
    timestamp: "2026-07-29T10:00:00.000Z",
    data: {
      version: 1,
      generation,
      startedAt: "2026-07-29T10:00:00.000Z",
      afterMessageCount,
    },
  };
}

function finishedEntry(generation: number, outcome: RunOutcome): SessionEntry {
  return {
    type: "custom",
    kind: RUN_FINISHED_CUSTOM_KIND,
    id: `f${generation}`,
    parentId: null,
    timestamp: "2026-07-29T10:01:00.000Z",
    data: { version: 1, generation, outcome },
  };
}

describe("RunLifecycle journalling", () => {
  it("writes a matched pair for a clean run", () => {
    const { writer, calls } = recordingJournal();
    const lifecycle = new RunLifecycle(undefined, writer);
    const lease = lifecycle.begin(vi.fn());
    lifecycle.settle(lease.generation);
    expect(calls).toEqual([`start:${lease.generation}`, `finish:${lease.generation}:completed`]);
  });

  it("records a failed run as failed", () => {
    const { writer, calls } = recordingJournal();
    const lifecycle = new RunLifecycle(undefined, writer);
    const lease = lifecycle.begin(vi.fn());
    lifecycle.settle(lease.generation, "failed");
    expect(calls).toEqual([`start:${lease.generation}`, `finish:${lease.generation}:failed`]);
  });

  it("records a cancelled run as aborted regardless of the caller's outcome", async () => {
    const { writer, calls } = recordingJournal();
    const lifecycle = new RunLifecycle(undefined, writer);
    const lease = lifecycle.begin(vi.fn());
    void lifecycle.cancel(1000);
    await Promise.resolve();
    lifecycle.settle(lease.generation, "completed");
    expect(calls).toEqual([`start:${lease.generation}`, `finish:${lease.generation}:aborted`]);
  });

  it("does not let a stale generation close a newer run's journal", () => {
    const { writer, calls } = recordingJournal();
    const lifecycle = new RunLifecycle(undefined, writer);
    const first = lifecycle.begin(vi.fn());
    lifecycle.settle(first.generation);
    const second = lifecycle.begin(vi.fn());

    // The stale settle must be a no-op — not a finish for generation 2.
    expect(lifecycle.settle(first.generation)).toEqual({ settled: false, cancelled: false });
    expect(calls).toEqual([`start:1`, `finish:1:completed`, `start:2`]);
    lifecycle.settle(second.generation);
    expect(calls.at(-1)).toBe("finish:2:completed");
  });
});

describe("run journal reconstruction", () => {
  const manager = new SessionManager(path.join(os.tmpdir(), "gg-run-journal-unused"));

  it("pairs each start with its own generation's finish", () => {
    const entries = [
      startedEntry(1, 0),
      finishedEntry(1, "completed"),
      startedEntry(2, 4),
      finishedEntry(2, "aborted"),
    ];
    expect(manager.getRunJournal(entries)).toEqual([
      {
        generation: 1,
        startedAt: "2026-07-29T10:00:00.000Z",
        afterMessageCount: 0,
        outcome: "completed",
      },
      {
        generation: 2,
        startedAt: "2026-07-29T10:00:00.000Z",
        afterMessageCount: 4,
        outcome: "aborted",
      },
    ]);
    expect(manager.getUnfinishedRuns(entries)).toEqual([]);
  });

  it("detects a truncated log as unfinished exactly once", () => {
    // The crash shape: the last run opened and the file just stops.
    const entries = [startedEntry(1), finishedEntry(1, "completed"), startedEntry(2, 6)];
    const unfinished = manager.getUnfinishedRuns(entries);
    expect(unfinished).toHaveLength(1);
    expect(unfinished[0]).toMatchObject({ generation: 2, afterMessageCount: 6 });
  });

  it("counts a duplicated start line once, not twice", () => {
    // A replayed/re-persisted log must not manufacture phantom crashed runs.
    const entries = [startedEntry(3), startedEntry(3), startedEntry(3)];
    expect(manager.getUnfinishedRuns(entries)).toHaveLength(1);
  });

  it("detects a crash in a RESUMED session, where generations restart at 1", () => {
    // Generations are not unique across a session file: RunLifecycle counts from
    // zero per instance and a resumed session builds a fresh one, so the first
    // run after every app restart is generation 1 again.
    //
    // Treating the reused number as a duplicate made a crash-after-restart
    // invisible — exactly the case this journal exists to catch.
    const entries = [
      startedEntry(1, 0),
      finishedEntry(1, "completed"),
      // App restarts, same session resumed, generation 1 again — then dies.
      startedEntry(1, 4),
    ];

    expect(manager.getRunJournal(entries)).toHaveLength(2);
    const unfinished = manager.getUnfinishedRuns(entries);
    expect(unfinished).toHaveLength(1);
    // The SECOND run is the crashed one; the first stays completed.
    expect(unfinished[0]).toMatchObject({ generation: 1, afterMessageCount: 4 });
  });

  it("closes only the open run when a generation is reused", () => {
    // gen 1 opens, a replayed start line repeats it, then one finish arrives.
    // The finish must close the single open run and leave nothing dangling.
    const entries = [startedEntry(1, 0), startedEntry(1, 6), finishedEntry(1, "completed")];

    expect(manager.getRunJournal(entries)).toHaveLength(1);
    expect(manager.getUnfinishedRuns(entries)).toEqual([]);
  });

  it("ignores a finish whose start was lost and malformed payloads", () => {
    const orphan = finishedEntry(9, "completed");
    const malformed: SessionEntry = {
      type: "custom",
      kind: RUN_STARTED_CUSTOM_KIND,
      id: "bad",
      parentId: null,
      timestamp: "2026-07-29T10:00:00.000Z",
      data: { version: 2, generation: "not-a-number" },
    };
    expect(manager.getRunJournal([orphan, malformed])).toEqual([]);
  });
});

describe("run journal on disk", () => {
  it("round-trips through a real session file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-run-journal-"));
    try {
      const manager = new SessionManager(dir);
      const session = await manager.create(process.cwd(), "anthropic", "claude-test");

      await manager.appendRunStarted(session.path, {
        version: 1,
        generation: 1,
        startedAt: "2026-07-29T10:00:00.000Z",
        afterMessageCount: 2,
      });
      await manager.appendRunFinished(session.path, {
        version: 1,
        generation: 1,
        outcome: "completed",
      });
      // Second run never closes — the process died.
      await manager.appendRunStarted(session.path, {
        version: 1,
        generation: 2,
        startedAt: "2026-07-29T10:05:00.000Z",
        afterMessageCount: 5,
      });

      const loaded = await manager.load(session.path);
      expect(manager.getRunJournal(loaded.entries).map((r) => r.outcome)).toEqual([
        "completed",
        undefined,
      ]);
      const unfinished = manager.getUnfinishedRuns(loaded.entries);
      expect(unfinished).toHaveLength(1);
      expect(unfinished[0]!.generation).toBe(2);

      // Journal entries are off-DAG, so they never enter the model's context.
      expect(manager.getMessages(loaded.entries, loaded.header.leafId)).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
