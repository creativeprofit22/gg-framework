/**
 * Hand-off of a still-running foreground command to a background task. These
 * drive real processes: the guard's whole point is stopping real silent
 * children, which a fake cannot prove.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentNotificationQueue } from "./agent-notifications.js";
import { AdoptExitedError, ProcessManager, type AdoptedCommandLimits } from "./process-manager.js";

const managers: ProcessManager[] = [];
const tempDirs: string[] = [];
const children: ChildProcess[] = [];
const leftoverPids: number[] = [];

async function manager(notifications?: AgentNotificationQueue): Promise<ProcessManager> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gg-process-adopt-"));
  tempDirs.push(directory);
  const instance = new ProcessManager({ bgDir: directory, notifications });
  managers.push(instance);
  return instance;
}

function nodeChild(script: string): ChildProcess {
  const child = spawn(process.execPath, ["-e", script], {
    detached: true,
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

const NO_LIMITS: AdoptedCommandLimits = { inactivityMs: null, hardMs: null, exitSettleMs: 500 };

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

  it("stops a command that goes silent after hand-off", async () => {
    const notifications = new AgentNotificationQueue();
    const pm = await manager(notifications);
    const child = nodeChild("console.log('ready'); setTimeout(() => {}, 60000);");
    const seed = await firstOutput(child);
    const pid = child.pid ?? 0;
    const startedAt = Date.now();

    const { id } = await pm.adopt({
      child,
      pid,
      command: "silent fixture",
      startedAt,
      limits: { inactivityMs: 1_000, hardMs: null, exitSettleMs: 500 },
      takeOver: () => ({ seedOutput: seed, lastOutputAt: Date.now() }),
    });

    expect(await pm.waitForExitOrWake(id, 10_000)).toBe("exited");
    expect(Date.now() - startedAt).toBeLessThan(8_000);
    const read = await pm.readOutput(id, true);
    expect(read.stopReason).toBe("inactive");
    expect(read.isRunning).toBe(false);
    expect(read.output).toContain("ready");
    await expect.poll(() => isAlive(pid), { timeout: 5_000 }).toBe(false);
    await expect
      .poll(() =>
        notifications.drain().some((n) => n.id === id && n.terminal && /inactive/.test(n.text)),
      )
      .toBe(true);
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
      limits: { inactivityMs: 1_000, hardMs: null, exitSettleMs: 500 },
      takeOver: () => ({ seedOutput: seed, lastOutputAt: Date.now() }),
    });

    expect(await pm.waitForExitOrWake(id, 10_000)).toBe("exited");
    const read = await pm.readOutput(id, true);
    expect(read.stopReason).toBeNull();
    expect(read.exitCode).toBe(0);
    expect(read.output).toContain("tick 11");
  }, 20_000);

  it("applies only the remaining hard limit after hand-off", async () => {
    const pm = await manager();
    const child = nodeChild(
      "console.log('go'); setInterval(() => console.log('still busy'), 100);",
    );
    const seed = await firstOutput(child);
    const adoptedAt = Date.now();

    const { id } = await pm.adopt({
      child,
      pid: child.pid ?? 0,
      command: "busy fixture",
      // 9 s of a 10 s hard limit are already used in the foreground.
      startedAt: adoptedAt - 9_000,
      limits: { inactivityMs: 5_000, hardMs: 10_000, exitSettleMs: 500 },
      takeOver: () => ({ seedOutput: seed, lastOutputAt: Date.now() }),
    });

    expect(await pm.waitForExitOrWake(id, 10_000)).toBe("exited");
    expect(Date.now() - adoptedAt).toBeLessThan(6_000);
    expect((await pm.readOutput(id)).stopReason).toBe("timedOut");
  }, 20_000);

  it("never fires the guard after an explicit task stop", async () => {
    const pm = await manager();
    const child = nodeChild("console.log('ready'); setTimeout(() => {}, 60000);");
    const seed = await firstOutput(child);

    const { id } = await pm.adopt({
      child,
      pid: child.pid ?? 0,
      command: "fixture",
      startedAt: Date.now(),
      limits: { inactivityMs: 1_500, hardMs: null, exitSettleMs: 500 },
      takeOver: () => ({ seedOutput: seed, lastOutputAt: Date.now() }),
    });
    expect(pm.activeCommandWatchdogs()).toEqual([id]);

    await pm.stop(id);
    expect(pm.activeCommandWatchdogs()).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect((await pm.readOutput(id)).stopReason).toBeNull();
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
