/**
 * Model-declared wake rules (match / silence) push a steering-path
 * notification the moment they hold — no task_output polling. Real processes,
 * because the watcher works off the on-disk log.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProcessManager } from "./process-manager.js";
import { AgentNotificationQueue, type AgentNotification } from "./agent-notifications.js";

const managers: ProcessManager[] = [];
const tempDirs: string[] = [];

async function bgDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gg-process-wake-"));
  tempDirs.push(directory);
  return directory;
}

async function manager(queue: AgentNotificationQueue): Promise<ProcessManager> {
  const instance = new ProcessManager({ notifications: queue, bgDir: await bgDir() });
  managers.push(instance);
  return instance;
}

async function waitForNotification(
  queue: AgentNotificationQueue,
  predicate: (entry: AgentNotification) => boolean,
  timeoutMs = 30_000,
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
    tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("ProcessManager wake rules", () => {
  // 45s, not the suite's 20s: the watcher ticks every 5s (WAKE_INTERVAL_MS),
  // and this test's own 30s budget throws a diagnostic ("Saw: ...") when the
  // watcher is broken. vitest's bare 20s cap must not fire first on a loaded
  // runner (observed on the macOS CI leg) or that diagnosis is lost.
  it(
    "notifies with the matching line the moment new output matches the pattern",
    { timeout: 45_000 },
    async () => {
      const queue = new AgentNotificationQueue();
      const pm = await manager(queue);

      const started = await pm.start(
        "echo building; sleep 1; echo 'error TS2304: cannot find name'; sleep 60",
        process.cwd(),
        undefined,
        { pattern: /error TS\d+/, silenceMs: 120_000 },
      );

      const entry = await waitForNotification(queue, (e) => e.text.includes("wake pattern"));
      expect(entry.text).toContain(started.id);
      expect(entry.text).toContain("cannot find name");
      expect(entry.text).toContain("Still running");
      expect(entry.terminal).toBe(false);
    },
  );

  it(
    "retires the wake watcher once every declared rule has fired",
    { timeout: 45_000 },
    async () => {
      const queue = new AgentNotificationQueue();
      const pm = await manager(queue);

      await pm.start("echo doomed; sleep 60", process.cwd(), undefined, { pattern: /doomed/ });

      await waitForNotification(queue, (e) => e.text.includes("doomed"));
      // One-shot: the pattern rule is spent and it was the only rule, so the
      // watcher must be gone even though the process still runs.
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(pm.activeWakeWatchers()).not.toContain(
        pm.list().find((proc) => proc.command.includes("doomed"))?.id,
      );
    },
  );

  it("notifies when a running task goes silent past silenceMs", { timeout: 45_000 }, async () => {
    const queue = new AgentNotificationQueue();
    const pm = await manager(queue);

    const started = await pm.start("echo started; sleep 60", process.cwd(), undefined, {
      silenceMs: 6_000,
    });

    const entry = await waitForNotification(queue, (e) => e.text.includes("stalled"));
    expect(entry.text).toContain(started.id);
    expect(entry.text).toContain("Last output: started");
    expect(entry.terminal).toBe(false);
  });

  it("fires no wake notification and keeps no watcher without rules", async () => {
    const queue = new AgentNotificationQueue();
    const pm = await manager(queue);

    await pm.start("echo quiet-start; sleep 60", process.cwd());
    expect(pm.activeWakeWatchers()).toHaveLength(0);

    // Give any (buggy) watcher a tick interval to fire.
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    const drained = queue.drain();
    expect(drained.every((entry) => !entry.text.includes("stalled"))).toBe(true);
  });

  it("drops the wake watcher when the process exits", { timeout: 45_000 }, async () => {
    const queue = new AgentNotificationQueue();
    const pm = await manager(queue);

    await pm.start("echo matched-then-exit", process.cwd(), undefined, {
      pattern: /never-matches/,
    });

    const exit = await waitForNotification(queue, (e) => e.terminal);
    expect(exit.text).toContain("exited");
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(pm.activeWakeWatchers()).toHaveLength(0);
  });
});
