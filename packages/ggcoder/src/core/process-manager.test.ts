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

describe("ProcessManager POSIX termination", () => {
  it("owns close before dispatch and routes stop through async tree cleanup", async () => {
    vi.useFakeTimers();
    try {
      const order: string[] = [];
      const childRef: { current?: EventEmitter } = {};
      const killProcessTreeAsync = vi.fn(async () => {
        const child = childRef.current!;
        order.push(`cleanup:close-listeners=${child.listenerCount("close")}`);
        child.emit("close", 0);
      });
      const tracked = trackedManager({ platform: "linux", killProcessTreeAsync });
      const child = tracked.child;
      childRef.current = child;
      const baseline = child.listenerCount("close");

      await expect(tracked.manager.stop(tracked.proc.id)).resolves.toBe(
        `Process ${tracked.proc.id} stopped`,
      );

      expect(order).toEqual([`cleanup:close-listeners=${baseline + 1}`]);
      expect(killProcessTreeAsync).toHaveBeenCalledWith(tracked.proc.pid);
      expect(child.listenerCount("close")).toBe(baseline);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for cooperative close after the shared cleanup returns", async () => {
    vi.useFakeTimers();
    try {
      const killProcessTreeAsync = vi.fn(async () => {});
      const { manager, child, proc } = trackedManager({ platform: "darwin", killProcessTreeAsync });
      const stopping = manager.stop(proc.id);
      await Promise.resolve();
      expect(killProcessTreeAsync).toHaveBeenCalledOnce();
      child.emit("close", 0);
      await expect(stopping).resolves.toBe(`Process ${proc.id} stopped`);
      expect(child.listenerCount("close")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a missing close as failure and keeps the process retryable", async () => {
    vi.useFakeTimers();
    try {
      const killProcessTreeAsync = vi.fn(async () => {});
      const { manager, child, proc } = trackedManager({ platform: "linux", killProcessTreeAsync });
      const baseline = child.listenerCount("close");
      const stopping = manager.stop(proc.id);
      await Promise.resolve();
      expect(child.listenerCount("close")).toBe(baseline + 1);
      await vi.advanceTimersByTimeAsync(5000);
      await expect(stopping).resolves.toBe(
        `Failed to stop process ${proc.id}: process did not exit within 5 seconds and may still be running.`,
      );
      expect(child.listenerCount("close")).toBe(baseline);

      const retrying = manager.stop(proc.id);
      await vi.advanceTimersByTimeAsync(5000);
      await expect(retrying).resolves.toBe(
        `Failed to stop process ${proc.id}: process did not exit within 5 seconds and may still be running.`,
      );
      expect(killProcessTreeAsync).toHaveBeenCalledTimes(2);
      expect(manager.list()).toContain(proc);
      expect(
        (manager as unknown as { children: Map<string, EventEmitter> }).children.get(proc.id),
      ).toBe(child);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports cleanup rejection with no close as failure and keeps the process retryable", async () => {
    vi.useFakeTimers();
    try {
      const killProcessTreeAsync = vi.fn(async () => {
        throw new Error("group access denied");
      });
      const { manager, child, proc } = trackedManager({ platform: "linux", killProcessTreeAsync });
      const stopping = manager.stop(proc.id);
      await vi.advanceTimersByTimeAsync(5000);
      await expect(stopping).resolves.toBe(
        `Failed to stop process ${proc.id}: process did not exit within 5 seconds and may still be running.`,
      );
      expect(child.listenerCount("close")).toBe(0);

      const retrying = manager.stop(proc.id);
      await vi.advanceTimersByTimeAsync(5000);
      await expect(retrying).resolves.toBe(
        `Failed to stop process ${proc.id}: process did not exit within 5 seconds and may still be running.`,
      );
      expect(killProcessTreeAsync).toHaveBeenCalledTimes(2);
      expect(manager.list()).toContain(proc);
      expect(
        (manager as unknown as { children: Map<string, EventEmitter> }).children.get(proc.id),
      ).toBe(child);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps synchronous shutdownAll on the immediate tree-kill seam", () => {
    const killProcessTree = vi.fn();
    const killProcessTreeAsync = vi.fn(async () => {});
    const { manager, proc } = trackedManager({
      platform: "linux",
      killProcessTree,
      killProcessTreeAsync,
    });

    manager.shutdownAll();

    expect(killProcessTree).toHaveBeenCalledWith(proc.pid);
    expect(killProcessTreeAsync).not.toHaveBeenCalled();
  });
});

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

      const baselineCloseListeners = child.listenerCount("close");
      const stopping = manager.stop(proc.id);

      expect(child.listenerCount("close")).toBe(baselineCloseListeners + 1);
      expect(order).toEqual(["tree-kill"]);
      expect(killProcessTree).toHaveBeenCalledWith(proc.pid);
      expect(kill).not.toHaveBeenCalled();
      child.emit("close", 1);
      await expect(stopping).resolves.toBe(`Process ${proc.id} stopped`);
      expect(child.listenerCount("close")).toBe(baselineCloseListeners);
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

      const baselineCloseListeners = child.listenerCount("close");
      const stopping = manager.stop(proc.id);
      expect(child.listenerCount("close")).toBe(baselineCloseListeners + 1);
      await vi.advanceTimersByTimeAsync(5000);

      await expect(stopping).resolves.toBe(
        `Failed to stop process ${proc.id}: process did not exit within 5 seconds and may still be running.`,
      );
      expect(child.listenerCount("close")).toBe(baselineCloseListeners);

      const retrying = manager.stop(proc.id);
      expect(child.listenerCount("close")).toBe(baselineCloseListeners + 1);
      await vi.advanceTimersByTimeAsync(5000);
      await expect(retrying).resolves.toBe(
        `Failed to stop process ${proc.id}: process did not exit within 5 seconds and may still be running.`,
      );

      expect(child.listenerCount("close")).toBe(baselineCloseListeners);
      expect(killProcessTree).toHaveBeenCalledTimes(2);
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
