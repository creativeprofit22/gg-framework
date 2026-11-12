/**
 * Hand-off of a still-running foreground command to a background task. These
 * drive real processes: the guards' whole point is real children, which a fake
 * cannot prove. Time is a manual clock, so no test sleeps for minutes.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentNotificationQueue, type AgentNotification } from "./agent-notifications.js";
import { AdoptExitedError, ProcessManager, type AdoptedCommandLimits } from "./process-manager.js";

const managers: ProcessManager[] = [];
const tempDirs: string[] = [];
const children: ChildProcess[] = [];
const leftoverPids: number[] = [];

type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * A fake clock for the manager's `now` and its hard-limit timers, plus a count
 * of real wake evaluations so tests wait for ticks instead of sleeping.
 */
function manualClock() {
  let current = Date.now();
  const timers = new Map<TimerHandle, { at: number; callback: () => void }>();
  const evaluations = new Map<string, number>();
  return {
    now: () => current,
    commandTimers: {
      set: (callback: () => void, ms: number): TimerHandle => {
        // A real, already-cleared handle keeps the type honest without a cast.
        const handle = setTimeout(() => {}, 0);
        clearTimeout(handle);
        timers.set(handle, { at: current + ms, callback });
        return handle;
      },
      clear: (handle: TimerHandle) => {
        timers.delete(handle);
      },
    },
    onWakeEvaluated: (id: string) => {
      evaluations.set(id, (evaluations.get(id) ?? 0) + 1);
    },
    advance(ms: number): void {
      current += ms;
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= current)
        .sort(([, a], [, b]) => a.at - b.at);
      for (const [handle, timer] of due) {
        timers.delete(handle);
        timer.callback();
      }
    },
    pending: () => timers.size,
    /** Resolve after two more wake evaluations of the task at the current fake time. */
    async ticks(pm: ProcessManager, id: string): Promise<void> {
      expect(pm.activeWakeWatchers()).toContain(id);
      const target = (evaluations.get(id) ?? 0) + 2;
      await expect
        .poll(() => evaluations.get(id) ?? 0, { timeout: 5_000 })
        .toBeGreaterThanOrEqual(target);
    },
  };
}

type ManualClock = ReturnType<typeof manualClock>;

async function manager(
  notifications?: AgentNotificationQueue,
  clock?: ManualClock,
): Promise<ProcessManager> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gg-process-adopt-"));
  tempDirs.push(directory);
  const instance = new ProcessManager({
    bgDir: directory,
    notifications,
    ...(clock
      ? {
          now: clock.now,
          commandTimers: clock.commandTimers,
          wakeIntervalMs: 10,
          onWakeEvaluated: clock.onWakeEvaluated,
        }
      : {}),
  });
  managers.push(instance);
  return instance;
}

function nodeChild(script: string, env?: Record<string, string>): ChildProcess {
  const child = spawn(process.execPath, ["-e", script], {
    detached: true,
    env: env ? { ...process.env, ...env } : process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}

async function firstOutput(child: ChildProcess): Promise<string> {
  return await new Promise((resolve) => {
    child.stdout?.once("data", (data: Buffer) => {
      child.stdout?.pause();
      resolve(data.toString("utf8"));
    });
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function silenceNotices(entries: AgentNotification[], id: string): AgentNotification[] {
  return entries.filter((n) => n.id === id && /has produced no output for/.test(n.text));
}

const NO_LIMITS: AdoptedCommandLimits = { quietMs: null, hardMs: null, exitSettleMs: 500 };
/** Real defaults: a 600 s quiet notice and a 60 min hard limit. */
const DEFAULTS: AdoptedCommandLimits = { quietMs: 600_000, hardMs: 3_600_000, exitSettleMs: 500 };
const SILENT_CHILD = "console.log('ready'); setTimeout(() => {}, 120000);";

afterEach(async () => {
  for (const instance of managers.splice(0)) instance.shutdownAll();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  for (const pid of leftoverPids.splice(0)) {
    try {
      process.kill(pid);
    } catch {
      // Already gone.
    }
  }
  await Promise.all(
    tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("ProcessManager.adopt", () => {
  it("keeps the output so far, streams new output, and reports the exit", async () => {
    const notifications = new AgentNotificationQueue();
    const pm = await manager(notifications);
    const child = nodeChild(
      "console.log('first'); setTimeout(() => console.log('second'), 800); setTimeout(() => {}, 1200);",
    );
    const seed = await firstOutput(child);

    const { id } = await pm.adopt({
      child,
      pid: child.pid ?? 0,
      command: "fixture",
      startedAt: Date.now(),
      limits: NO_LIMITS,
      takeOver: () => ({ seedOutput: seed, lastOutputAt: Date.now() }),
    });

    expect(await pm.waitForExitOrWake(id, 10_000)).toBe("exited");
    const read = await pm.readOutput(id, true);
    expect(read.output).toContain("first");
    expect(read.output).toContain("second");
    expect(read.isRunning).toBe(false);
    expect(read.exitCode).toBe(0);
    expect(read.stopReason).toBeNull();
    await expect
      .poll(() => notifications.drain().some((n) => n.terminal && n.id === id))
      .toBe(true);
  });

  it("refuses to adopt a command that already exited", async () => {
    const pm = await manager();
    const child = nodeChild("");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    let tookOver = false;

    await expect(
      pm.adopt({
        child,
        pid: child.pid ?? 0,
        command: "fixture",
        startedAt: Date.now(),
        limits: NO_LIMITS,
        takeOver: () => {
          tookOver = true;
          return { seedOutput: "", lastOutputAt: Date.now() };
        },
      }),
    ).rejects.toBeInstanceOf(AdoptExitedError);
    expect(tookOver).toBe(false);
  });

  it("keeps a quiet moved command alive past 13 minutes and notifies once", async () => {
    const clock = manualClock();
    const notifications = new AgentNotificationQueue();
    const pm = await manager(notifications, clock);
    const child = nodeChild(SILENT_CHILD);
    const seed = await firstOutput(child);
    const pid = child.pid ?? 0;

    // Moved after the 120 s yield and silent since it started.
    const { id, logFile } = await pm.adopt({
      child,
      pid,
      command: "quiet gate",
      startedAt: clock.now() - 120_000,
      limits: DEFAULTS,
      takeOver: () => ({ seedOutput: seed, lastOutputAt: clock.now() - 120_000 }),
    });

    clock.advance(420_000); // 9 min of silence
    await clock.ticks(pm, id);
    expect(silenceNotices(notifications.drain(), id)).toHaveLength(0);

    clock.advance(60_000); // 10 min of silence and in total
    await clock.ticks(pm, id);
    const notices = silenceNotices(notifications.drain(), id);
    expect(notices).toHaveLength(1);
    const text = notices[0]?.text ?? "";
    expect(text).toContain(id);
    expect(text).toContain("no output for 600s");
    expect(text).toContain("running 10m in total");
    expect(text).toContain(`Log: ${logFile}`);
    expect(text).toContain("silence never stops it");
    expect(text).toContain("hard limit in 50m");

    clock.advance(180_000); // 13 min in total
    await clock.ticks(pm, id);
    const read = await pm.readOutput(id);
    expect(read.isRunning).toBe(true);
    expect(read.stopReason).toBeNull();
    expect(isAlive(pid)).toBe(true);

    // One-shot: no second notice however long the silence lasts.
    clock.advance(600_000);
    await clock.ticks(pm, id);
    expect(notifications.drain().filter((n) => n.id === id)).toHaveLength(0);
  }, 20_000);

  it("postpones the quiet notice when output arrives", async () => {
    const clock = manualClock();
    const notifications = new AgentNotificationQueue();
    const pm = await manager(notifications, clock);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gg-process-burst-"));
    tempDirs.push(directory);
    const sentinel = path.join(directory, "burst");
    // Prints once per sentinel file, so the test decides when output arrives.
    const child = nodeChild(
      "const fs = require('node:fs'); const file = process.env.GG_SENTINEL;" +
        "console.log('ready');" +
        "setInterval(() => { if (fs.existsSync(file)) { fs.unlinkSync(file); console.log('burst'); } }, 20);",
      { GG_SENTINEL: sentinel },
    );
    const seed = await firstOutput(child);

    const { id } = await pm.adopt({
      child,
      pid: child.pid ?? 0,
      command: "bursty gate",
      startedAt: clock.now(),
      limits: DEFAULTS,
      takeOver: () => ({ seedOutput: seed, lastOutputAt: clock.now() }),
    });

    clock.advance(500_000);
    await fs.writeFile(sentinel, "");
    await expect.poll(async () => (await pm.readOutput(id, true)).output).toContain("burst");
    await clock.ticks(pm, id); // growth is seen at fake 500 s

    clock.advance(550_000); // 1050 s in total, 550 s since the burst
    await clock.ticks(pm, id);
    expect(silenceNotices(notifications.drain(), id)).toHaveLength(0);

    clock.advance(60_000); // 610 s since the burst
    await clock.ticks(pm, id);
    const notices = silenceNotices(notifications.drain(), id);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.text).toContain("burst");
  }, 20_000);

  it("still stops at the hard limit and cleans up the process tree", async () => {
    const clock = manualClock();
    const notifications = new AgentNotificationQueue();
    const pm = await manager(notifications, clock);
    // Prints its grandchild's PID; the grandchild shares the tree and stays silent.
    const child = nodeChild(`
const { spawn } = require("node:child_process");
const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
console.log("grandchild:" + grandchild.pid);
setTimeout(() => {}, 120000);
`);
    const seed = await firstOutput(child);
    const pid = child.pid ?? 0;
    const grandchildPid = Number(/grandchild:(\d+)/.exec(seed)?.[1] ?? 0);
    expect(grandchildPid).toBeGreaterThan(0);
    leftoverPids.push(grandchildPid);

    const { id } = await pm.adopt({
      child,
      pid,
      command: "runaway",
      startedAt: clock.now() - 120_000,
      limits: DEFAULTS,
      takeOver: () => ({ seedOutput: seed, lastOutputAt: clock.now() - 120_000 }),
    });
    expect(pm.activeCommandWatchdogs()).toEqual([id]);

    clock.advance(3_479_999); // 1 ms before the 60 min hard limit
    await clock.ticks(pm, id);
    expect((await pm.readOutput(id)).isRunning).toBe(true);
    expect(silenceNotices(notifications.drain(), id)).toHaveLength(1);

    clock.advance(1);
    expect(await pm.waitForExit(id, 10_000)).toBe("exited");
    const read = await pm.readOutput(id, true);
    expect(read.stopReason).toBe("timedOut");
    expect(read.isRunning).toBe(false);
    expect(pm.activeCommandWatchdogs()).toEqual([]);
    await expect.poll(() => isAlive(pid), { timeout: 10_000 }).toBe(false);
    await expect.poll(() => isAlive(grandchildPid), { timeout: 10_000 }).toBe(false);
    await expect
      .poll(() =>
        notifications
          .drain()
          .some((n) => n.id === id && n.terminal && /hard time limit reached/.test(n.text)),
      )
      .toBe(true);
  }, 30_000);

  it("charges hard-limit time already spent in the foreground", async () => {
    const clock = manualClock();
    const pm = await manager(undefined, clock);
    const child = nodeChild(SILENT_CHILD);
    const seed = await firstOutput(child);

    const { id } = await pm.adopt({
      child,
      pid: child.pid ?? 0,
      command: "busy fixture",
      // 9 s of a 10 s hard limit are already used in the foreground.
      startedAt: clock.now() - 9_000,
      limits: { quietMs: 5_000, hardMs: 10_000, exitSettleMs: 500 },
      takeOver: () => ({ seedOutput: seed, lastOutputAt: clock.now() }),
    });

    clock.advance(999);
    expect((await pm.readOutput(id)).isRunning).toBe(true);
    clock.advance(1);
    expect(await pm.waitForExit(id, 10_000)).toBe("exited");
    expect((await pm.readOutput(id)).stopReason).toBe("timedOut");
  }, 20_000);

  it("does not stop a chatty command that keeps printing", async () => {
    const pm = await manager();
    const child = nodeChild(
      "let n = 0; const t = setInterval(() => { console.log('tick', n); if (++n === 12) { clearInterval(t); } }, 200);",
    );
    const seed = await firstOutput(child);

    const { id } = await pm.adopt({
      child,
      pid: child.pid ?? 0,
      command: "chatty fixture",
      startedAt: Date.now(),
      limits: { quietMs: 1_000, hardMs: null, exitSettleMs: 500 },
      takeOver: () => ({ seedOutput: seed, lastOutputAt: Date.now() }),
    });

    expect(await pm.waitForExitOrWake(id, 10_000)).toBe("exited");
    const read = await pm.readOutput(id, true);
    expect(read.stopReason).toBeNull();
    expect(read.exitCode).toBe(0);
    expect(read.output).toContain("tick 11");
  }, 20_000);

  it("disposes both guards on an explicit task stop", async () => {
    const clock = manualClock();
    const notifications = new AgentNotificationQueue();
    const pm = await manager(notifications, clock);
    const child = nodeChild(SILENT_CHILD);
    const seed = await firstOutput(child);

    const { id } = await pm.adopt({
      child,
      pid: child.pid ?? 0,
      command: "fixture",
      startedAt: clock.now(),
      limits: DEFAULTS,
      takeOver: () => ({ seedOutput: seed, lastOutputAt: clock.now() }),
    });
    expect(pm.activeCommandWatchdogs()).toEqual([id]);
    expect(pm.activeWakeWatchers()).toContain(id);

    await pm.stop(id);
    expect(pm.activeCommandWatchdogs()).toEqual([]);
    expect(clock.pending()).toBe(0);
    await expect.poll(() => pm.activeWakeWatchers().includes(id)).toBe(false);

    clock.advance(4_000_000);
    expect((await pm.readOutput(id)).stopReason).toBeNull();
    const after: AgentNotification[] = [];
    await expect
      .poll(() => {
        after.push(...notifications.drain());
        return after.some((n) => n.id === id && n.terminal);
      })
      .toBe(true);
    expect(silenceNotices(after, id)).toHaveLength(0);
  }, 20_000);

  it("disposes both guards on process-manager shutdown", async () => {
    const clock = manualClock();
    const notifications = new AgentNotificationQueue();
    const pm = await manager(notifications, clock);
    const child = nodeChild(SILENT_CHILD);
    const seed = await firstOutput(child);
    const pid = child.pid ?? 0;

    const { id } = await pm.adopt({
      child,
      pid,
      command: "fixture",
      startedAt: clock.now(),
      limits: DEFAULTS,
      takeOver: () => ({ seedOutput: seed, lastOutputAt: clock.now() }),
    });

    pm.shutdownAll();
    expect(pm.activeCommandWatchdogs()).toEqual([]);
    expect(pm.activeWakeWatchers()).not.toContain(id);
    expect(clock.pending()).toBe(0);
    await expect.poll(() => isAlive(pid), { timeout: 10_000 }).toBe(false);

    clock.advance(4_000_000);
    expect(silenceNotices(notifications.drain(), id)).toHaveLength(0);
  }, 20_000);

  it("reports the exit when a leftover process still holds the output pipes", async () => {
    const pm = await manager();
    // Prints its detached grandchild's PID, then exits while that grandchild
    // (which inherited stdio) keeps the output pipes open.
    const child = nodeChild(`
const { spawn } = require("node:child_process");
const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 12000)"], {
  detached: true,
  stdio: "inherit",
});
holder.unref();
console.log("holder:" + holder.pid);
setTimeout(() => process.exit(0), 1500);
`);
    const seed = await firstOutput(child);
    const holderPid = Number(/holder:(\d+)/.exec(seed)?.[1] ?? 0);
    if (holderPid > 0) leftoverPids.push(holderPid);

    const { id } = await pm.adopt({
      child,
      pid: child.pid ?? 0,
      command: "holder fixture",
      startedAt: Date.now(),
      limits: NO_LIMITS,
      takeOver: () => ({ seedOutput: seed, lastOutputAt: Date.now() }),
    });

    expect(await pm.waitForExitOrWake(id, 5_000)).toBe("exited");
    const read = await pm.readOutput(id, true);
    expect(read.isRunning).toBe(false);
    expect(read.exitCode).toBe(0);
    expect(read.stopReason).toBeNull();
    expect(read.output).toContain("holder:");
  }, 15_000);

  it("never guards explicit background tasks", async () => {
    const pm = await manager();
    const { id } = await pm.start("sleep 5", process.cwd());
    expect(pm.activeCommandWatchdogs()).toEqual([]);
    expect((await pm.readOutput(id)).stopReason).toBeNull();
  });
});
