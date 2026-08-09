/**
 * A long background build must report itself. These tests drive real processes
 * (the watcher works off the on-disk log, so a fake would prove nothing) and
 * assert the two invariants that keep it cheap: bounded injected bytes, and no
 * timer outliving its process.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProcessManager } from "./process-manager.js";
import {
  AgentNotificationQueue,
  NOTIFICATION_MAX_CHARS,
  type AgentNotification,
} from "./agent-notifications.js";

const managers: ProcessManager[] = [];
const tempDirs: string[] = [];

/** Mirrors WATCH_MAX_REPORTS in process-manager.ts (module-private). */
const WATCH_MAX_REPORTS_EXPECTED = 3;

/**
 * Every manager here gets its own log directory. `start()` writes AND prunes
 * inside `bgDir`, so an un-overridden instance would sweep the developer's real
 * `~/.gg/bg` history when the suite runs.
 */
async function bgDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gg-process-bg-"));
  tempDirs.push(directory);
  return directory;
}

async function manager(notifications: AgentNotificationQueue): Promise<ProcessManager> {
  const instance = new ProcessManager({ notifications, bgDir: await bgDir() });
  managers.push(instance);
  return instance;
}

async function tempDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gg-process-notify-"));
  tempDirs.push(directory);
  return directory;
}

/** Poll the queue until a notification matching `predicate` is drained. */
async function waitForNotification(
  queue: AgentNotificationQueue,
  predicate: (entry: AgentNotification) => boolean,
  timeoutMs = 20_000,
): Promise<AgentNotification> {
  const deadline = Date.now() + timeoutMs;
  const seen: AgentNotification[] = [];
  while (Date.now() < deadline) {
    for (const entry of queue.drain()) {
      seen.push(entry);
      if (predicate(entry)) return entry;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out. Saw: ${JSON.stringify(seen)}`);
}

afterEach(async () => {
  for (const instance of managers.splice(0)) instance.shutdownAll();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) =>
        fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
      ),
  );
});

describe("ProcessManager progress notifications", () => {
  it("pushes a terminal exit checkpoint without any task_output call", async () => {
    const queue = new AgentNotificationQueue();
    const instance = await manager(queue);
    const cwd = await tempDir();

    const started = await instance.start("echo hello-from-build; exit 3", cwd);
    const exit = await waitForNotification(queue, (entry) => entry.terminal);

    expect(exit.kind).toBe("process");
    expect(exit.id).toBe(started.id);
    expect(exit.text).toContain("exited with code 3");
    expect(exit.text).toContain("hello-from-build");
    expect(exit.text).toContain("task_output");
    expect(exit.text.length).toBeLessThanOrEqual(NOTIFICATION_MAX_CHARS);
  }, 30_000);

  it("surfaces progress on a long-running process before it exits", async () => {
    const queue = new AgentNotificationQueue();
    const instance = await manager(queue);
    const cwd = await tempDir();

    // Logs steadily for ~12s: long enough for at least one 5s checkpoint tick.
    const started = await instance.start(
      `for i in $(seq 1 12); do echo "step-$i"; sleep 1; done`,
      cwd,
    );
    const progress = await waitForNotification(queue, (entry) => !entry.terminal);

    expect(progress.id).toBe(started.id);
    expect(progress.text).toContain("still running");
    expect(progress.text).toContain("step-");
    expect(progress.text.length).toBeLessThanOrEqual(NOTIFICATION_MAX_CHARS);
    // Proven without a single task_output call.
    await instance.stop(started.id);
  }, 40_000);

  it("bounds the digest of a process that floods its log", async () => {
    const queue = new AgentNotificationQueue();
    const instance = await manager(queue);
    const cwd = await tempDir();

    await instance.start(`for i in $(seq 1 2000); do echo "line-$i padding padding"; done`, cwd);
    const exit = await waitForNotification(queue, (entry) => entry.terminal);

    expect(exit.text.length).toBeLessThanOrEqual(NOTIFICATION_MAX_CHARS);
    // Digest is the TAIL, so the newest lines survive.
    expect(exit.text).toContain("line-2000");
  }, 30_000);

  it("leaves no watcher timer alive after a process exits", async () => {
    const queue = new AgentNotificationQueue();
    const instance = await manager(queue);
    const cwd = await tempDir();

    const started = await instance.start("true", cwd);
    expect(instance.activeWatchers()).toContain(started.id);

    await waitForNotification(queue, (entry) => entry.terminal);
    expect(instance.activeWatchers()).toEqual([]);
  }, 30_000);

  it("disposes the watcher when a running process is stopped", async () => {
    const queue = new AgentNotificationQueue();
    const instance = await manager(queue);
    const cwd = await tempDir();

    const started = await instance.start("sleep 30", cwd);
    expect(instance.activeWatchers()).toContain(started.id);

    await instance.stop(started.id);
    await waitForNotification(queue, (entry) => entry.terminal);
    expect(instance.activeWatchers()).toEqual([]);
  }, 30_000);

  it("backs off repeated progress checkpoints on a long-lived chatty process", async () => {
    const queue = new AgentNotificationQueue();
    const instance = await manager(queue);
    const cwd = await tempDir();

    // A dev server: logs continuously and never exits on its own. At a flat 5s
    // this produced a fresh checkpoint for essentially every loop step — the
    // measured ~2k tokens per minute of overlap that prompted the backoff.
    const started = await instance.start(
      `for i in $(seq 1 400); do echo "[electron] compiled ok $i"; sleep 0.2; done`,
      cwd,
    );

    // Drain on the cadence a fast tool batch would, for 30s.
    let progressCount = 0;
    const until = Date.now() + 30_000;
    while (Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      progressCount += queue.drain().filter((entry) => !entry.terminal).length;
    }
    await instance.stop(started.id);

    // Ticks land at 5s, 15s, 35s… so 30s admits at most the first two, plus a
    // boundary tick. Flat 5s would have produced ~6.
    expect(progressCount).toBeGreaterThanOrEqual(1);
    expect(progressCount).toBeLessThanOrEqual(3);
  }, 60_000);

  it("still reports a short build promptly, before any backoff matters", async () => {
    const queue = new AgentNotificationQueue();
    const instance = await manager(queue);
    const cwd = await tempDir();

    const started = await instance.start(
      `for i in $(seq 1 12); do echo "step-$i"; sleep 1; done`,
      cwd,
    );
    // The FIRST checkpoint must still arrive on the original 5s tick — backoff
    // must not cost a short build its near-real-time reporting.
    const first = await waitForNotification(queue, (entry) => !entry.terminal, 9_000);
    expect(first.text).toContain("still running");
    await instance.stop(started.id);
  }, 40_000);

  it("stays responsive after an idle stretch instead of drifting to the cap", async () => {
    const queue = new AgentNotificationQueue();
    const instance = await manager(queue);
    const cwd = await tempDir();

    // A dev server that boots, idles, then fails a recompile and KEEPS RUNNING
    // (so the progress watcher, not the exit checkpoint, has to carry the news).
    //
    // Driven from a script file on purpose: every notification embeds
    // `proc.command`, so a marker written inline would also appear in the boot
    // checkpoint's text and match there — which silently made an earlier
    // version of this test assert nothing.
    const IDLE_MS = 40_000;
    const script = path.join(cwd, "server.sh");
    await fs.writeFile(
      script,
      `#!/bin/sh\necho booted\nsleep ${IDLE_MS / 1000}\necho LATE_RECOMPILE_FAILURE\nsleep 120\n`,
      { mode: 0o755 },
    );

    const spawnedAt = Date.now();
    const started = await instance.start("sh server.sh", cwd);

    // Consume the boot checkpoint (this one legitimately backs off to 10s).
    const boot = await waitForNotification(queue, (entry) => !entry.terminal);
    expect(boot.text).not.toContain("LATE_RECOMPILE_FAILURE");

    await waitForNotification(
      queue,
      (entry) => entry.text.includes("LATE_RECOMPILE_FAILURE"),
      60_000,
    );
    // The failure line is written IDLE_MS after spawn; everything past that is
    // watcher latency.
    const latencyMs = Date.now() - (spawnedAt + IDLE_MS);

    // Backing off on SILENT ticks would have grown the interval through the
    // idle window (5→10→20→40…), making this land ~35s late. Damping only
    // actual reports keeps the interval at 10s, so it lands within one tick.
    expect(latencyMs).toBeLessThan(15_000);
    await instance.stop(started.id);
  }, 120_000);

  it("stops pushing progress entirely once the report budget is spent", async () => {
    const queue = new AgentNotificationQueue();
    const instance = await manager(queue);
    const cwd = await tempDir();

    // A dev server: logs continuously, never exits. Without a budget this kept
    // producing checkpoints for the life of the process — the unbounded tail
    // Anthropic removed from Claude Code (task_progress /
    // background_task_status are now LEGACY_ATTACHMENT_TYPES, dropped before
    // the model sees them).
    const started = await instance.start(
      `for i in $(seq 1 600); do echo "[electron] compiled ok $i"; sleep 0.2; done`,
      cwd,
    );

    // Reports land at ~5s/15s/35s; the 4th would be at ~75s. Rather than idle
    // until then, assert the structural end state: the watcher RETIRES, so no
    // further tick can exist to fire. That is stronger than any wait.
    let progressCount = 0;
    const until = Date.now() + 50_000;
    while (Date.now() < until && instance.activeWatchers().length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      progressCount += queue.drain().filter((entry) => !entry.terminal).length;
    }
    progressCount += queue.drain().filter((entry) => !entry.terminal).length;

    expect(progressCount).toBe(WATCH_MAX_REPORTS_EXPECTED);
    // Process is still very much alive — this is retirement, not exit.
    expect((await instance.readOutput(started.id)).isRunning).toBe(true);
    expect(instance.activeWatchers()).toEqual([]);
    await instance.stop(started.id);
  }, 120_000);

  it("still reports the exit after the progress budget is spent", async () => {
    const queue = new AgentNotificationQueue();
    const instance = await manager(queue);
    const cwd = await tempDir();

    // Chatty enough to burn the budget, then exits non-zero. "It finished, and
    // how" is the one fact the agent cannot get without polling — retiring the
    // progress watcher must never cost it.
    const started = await instance.start(
      `for i in $(seq 1 200); do echo "line-$i"; sleep 0.2; done; echo BUILD_FAILED; exit 7`,
      cwd,
    );

    const exit = await waitForNotification(queue, (entry) => entry.terminal, 90_000);
    expect(exit.id).toBe(started.id);
    expect(exit.text).toContain("exited with code 7");
    expect(exit.text).toContain("BUILD_FAILED");
  }, 120_000);

  it("stays silent when no notification queue is wired", async () => {
    const instance = new ProcessManager({ bgDir: await bgDir() });
    managers.push(instance);
    const cwd = await tempDir();

    const started = await instance.start("echo quiet", cwd);
    expect(instance.activeWatchers()).toEqual([]);
    // The pull path still works exactly as before.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const read = await instance.readOutput(started.id);
    expect(read.output).toContain("quiet");
  }, 30_000);
});
