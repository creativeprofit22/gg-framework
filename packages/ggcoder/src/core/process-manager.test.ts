import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { ProcessManager, type BackgroundProcess } from "./process-manager.js";

function trackedManager(ops: ConstructorParameters<typeof ProcessManager>[0] = {}): {
  manager: ProcessManager;
  child: EventEmitter;
  proc: BackgroundProcess;
} {
  const manager = new ProcessManager(ops);
  const child = new EventEmitter();
  const proc: BackgroundProcess = {
    id: "bg-test",
    pid: 4321,
    command: "fixture",
    logFile: "fixture.log",
    startedAt: Date.now(),
    exitCode: null,
    lastReadOffset: 0,
  };
  const internals = manager as unknown as {
    processes: Map<string, BackgroundProcess>;
    children: Map<string, EventEmitter>;
  };
  internals.processes.set(proc.id, proc);
  internals.children.set(proc.id, child);
  return { manager, child, proc };
}

describe("ProcessManager Windows termination", () => {
  it("dispatches PID-tree termination before waiting and reports confirmed close", async () => {
    vi.useFakeTimers();
    try {
      const order: string[] = [];
      const kill = vi.fn(() => {
        order.push("direct-signal");
        return true;
      }) as unknown as typeof process.kill;
      const killProcessTree = vi.fn(() => {
        order.push("tree-kill");
      });
      const { manager, child, proc } = trackedManager({
        platform: "win32",
        kill,
        killProcessTree,
      });

      const stopping = manager.stop(proc.id);

      expect(order).toEqual(["tree-kill"]);
      expect(killProcessTree).toHaveBeenCalledWith(proc.pid);
      expect(kill).not.toHaveBeenCalled();
      child.emit("close", 1);
      await expect(stopping).resolves.toBe(`Process ${proc.id} stopped`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports failure and preserves tracking when the child does not close", async () => {
    vi.useFakeTimers();
    try {
      const killProcessTree = vi.fn();
      const { manager, child, proc } = trackedManager({
        platform: "win32",
        killProcessTree,
      });

      const stopping = manager.stop(proc.id);
      await vi.advanceTimersByTimeAsync(5000);

      await expect(stopping).resolves.toBe(
        `Failed to stop process ${proc.id}: process did not exit within 5 seconds and may still be running.`,
      );
      expect(killProcessTree).toHaveBeenCalledOnce();
      expect(manager.list()).toContain(proc);
      expect(proc.exitCode).toBeNull();
      expect(
        (manager as unknown as { children: Map<string, EventEmitter> }).children.get(proc.id),
      ).toBe(child);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shutdownAll routes each live PID through the shared tree-kill seam", () => {
    const order: string[] = [];
    const killProcessTree = vi.fn((pid: number) => order.push(`tree:${pid}`));
    const kill = vi.fn(() => {
      order.push("direct-signal");
      return true;
    }) as unknown as typeof process.kill;
    const { manager, proc } = trackedManager({ platform: "win32", kill, killProcessTree });

    manager.shutdownAll();

    expect(order).toEqual([`tree:${proc.pid}`]);
    expect(killProcessTree).toHaveBeenCalledWith(proc.pid);
    expect(kill).not.toHaveBeenCalled();
    expect(manager.list()[0]?.exitCode).toBe(1);
  });

  it("treats already-closed and dead records as harmless", async () => {
    const killProcessTree = vi.fn();
    const closed = trackedManager({ platform: "win32", killProcessTree });
    closed.proc.exitCode = 0;
    (closed.manager as unknown as { children: Map<string, EventEmitter> }).children.delete(
      closed.proc.id,
    );

    await expect(closed.manager.stop(closed.proc.id)).resolves.toBe(
      `Process ${closed.proc.id} already exited (code 0)`,
    );
    closed.manager.shutdownAll();

    expect(killProcessTree).not.toHaveBeenCalled();
  });
});
