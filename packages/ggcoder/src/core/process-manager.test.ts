import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import type { ProcessTarget } from "../utils/process.js";
import { localProcessLifecycle, type ProcessLifecycleAdapter } from "../tools/operations.js";
import { ProcessManager, type BackgroundProcess } from "./process-manager.js";

interface FakeChildHarness {
  child: ChildProcess;
  stdout: PassThrough;
  stderr: PassThrough;
  emitSpawn(): void;
  emitError(error: Error): void;
  emitClose(code?: number | null): void;
}

function fakeChild(pid = 4321): FakeChildHarness {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const state: { exitCode: number | null; signalCode: NodeJS.Signals | null } = {
    exitCode: null,
    signalCode: null,
  };
  Object.defineProperties(emitter, {
    exitCode: { get: () => state.exitCode, configurable: true },
    signalCode: { get: () => state.signalCode, configurable: true },
  });
  const child = Object.assign(emitter, {
    pid,
    stdin,
    stdout,
    stderr,
    unref: vi.fn(),
  }) as unknown as ChildProcess;
  return {
    child,
    stdout,
    stderr,
    emitSpawn() {
      emitter.emit("spawn");
    },
    emitError(error) {
      emitter.emit("error", error);
    },
    emitClose(code = 0) {
      state.exitCode = code;
      emitter.emit("close", code, null);
    },
  };
}

function lifecycle(overrides: Partial<ProcessLifecycleAdapter> = {}): ProcessLifecycleAdapter {
  return { ...localProcessLifecycle, ...overrides };
}

function trackedManager(adapter: ProcessLifecycleAdapter): {
  manager: ProcessManager;
  child: ChildProcess;
  proc: BackgroundProcess;
} {
  const manager = new ProcessManager(adapter);
  const { child } = fakeChild();
  const proc: BackgroundProcess = {
    id: "bg-test",
    pid: child.pid!,
    command: "fixture",
    logFile: "fixture.log",
    startedAt: Date.now(),
    exitCode: null,
    lastReadOffset: 0,
  };
  const internals = manager as unknown as {
    processes: Map<string, BackgroundProcess>;
    children: Map<string, ChildProcess>;
  };
  internals.processes.set(proc.id, proc);
  internals.children.set(proc.id, child);
  return { manager, child, proc };
}

describe("ProcessManager lifecycle adapter", () => {
  it("spawns background work through the adapter with piped output", async () => {
    const fake = fakeChild(9876);
    const spawn = vi.fn(() => {
      queueMicrotask(() => fake.emitSpawn());
      return fake.child;
    });
    const reapProcessWrapper = vi.fn();
    const manager = new ProcessManager(lifecycle({ spawn, reapProcessWrapper }));

    const started = await manager.start("echo remote", "/remote/workspace");

    expect(started.pid).toBe(9876);
    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        cwd: "/remote/workspace",
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    fake.stdout.write("remote stdout\n");
    fake.stderr.write("remote stderr\n");
    fake.emitClose(0);
    let output = "";
    for (let attempt = 0; attempt < 20 && !output.includes("remote stderr"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      output = (await manager.readOutput(started.id, true)).output;
    }
    expect(output).toContain("remote stdout");
    expect(output).toContain("remote stderr");
    expect(reapProcessWrapper).toHaveBeenCalledWith(
      expect.objectContaining({ pid: 9876, isExited: expect.any(Function) }),
    );
  });

  it("rejects a synchronous spawn throw without tracking a process", async () => {
    const error = new Error("spawn threw");
    const logStream = new PassThrough();
    const endLog = vi.spyOn(logStream, "end");
    const manager = new ProcessManager(
      lifecycle({
        spawn: () => {
          throw error;
        },
      }),
      () => logStream,
    );

    await expect(manager.start("missing command", "/workspace")).rejects.toBe(error);
    expect(manager.list()).toEqual([]);
    expect(endLog).toHaveBeenCalledOnce();
  });

  it("rejects an asynchronous startup error without tracking or unrefing the child", async () => {
    const fake = fakeChild();
    const error = new Error("ENOENT");
    const logStream = new PassThrough();
    const endLog = vi.spyOn(logStream, "end");
    const manager = new ProcessManager(
      lifecycle({
        spawn: () => {
          queueMicrotask(() => fake.emitError(error));
          return fake.child;
        },
      }),
      () => logStream,
    );
    const starting = manager.start("missing command", "/workspace");

    await expect(starting).rejects.toBe(error);
    expect(manager.list()).toEqual([]);
    expect(fake.child.unref).not.toHaveBeenCalled();
    expect(fake.child.listenerCount("error")).toBeGreaterThan(0);
    expect(endLog).toHaveBeenCalledOnce();
    expect(() => fake.emitError(new Error("later failure"))).not.toThrow();
  });

  it("tracks spawn before handling an immediate close", async () => {
    const fake = fakeChild(7654);
    const reapProcessWrapper = vi.fn();
    const logStream = new PassThrough();
    const endLog = vi.spyOn(logStream, "end");
    const manager = new ProcessManager(
      lifecycle({
        spawn: () => {
          queueMicrotask(() => {
            fake.emitSpawn();
            fake.emitClose(0);
          });
          return fake.child;
        },
        reapProcessWrapper,
      }),
      () => logStream,
    );
    const starting = manager.start("fast command", "/workspace");

    await expect(starting).resolves.toMatchObject({ pid: 7654 });
    await vi.waitFor(() => {
      expect(manager.list()).toEqual([expect.objectContaining({ pid: 7654, exitCode: 0 })]);
      expect((manager as unknown as { children: Map<string, ChildProcess> }).children.size).toBe(0);
      expect(reapProcessWrapper).toHaveBeenCalledOnce();
    });
    expect(fake.child.unref).toHaveBeenCalledOnce();
    expect(endLog).toHaveBeenCalledOnce();
  });

  it("keeps completion pending until the log stream flushes", async () => {
    const fake = fakeChild(2468);
    let finishLogFlush: (() => void) | undefined;
    const logStream = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
      final(callback) {
        finishLogFlush = callback;
      },
    });
    const reapProcessWrapper = vi.fn();
    const manager = new ProcessManager(
      lifecycle({
        spawn: () => {
          queueMicrotask(() => fake.emitSpawn());
          return fake.child;
        },
        reapProcessWrapper,
      }),
      () => logStream,
    );

    const started = await manager.start("flush logs", "/workspace");
    fake.stdout.write("final output\n");
    fake.emitClose(0);

    expect(manager.list()).toEqual([expect.objectContaining({ exitCode: null })]);
    expect(
      (manager as unknown as { children: Map<string, ChildProcess> }).children.has(started.id),
    ).toBe(true);
    expect(reapProcessWrapper).not.toHaveBeenCalled();

    finishLogFlush?.();
    await vi.waitFor(() => {
      expect(manager.list()).toEqual([expect.objectContaining({ exitCode: 0 })]);
      expect(
        (manager as unknown as { children: Map<string, ChildProcess> }).children.has(started.id),
      ).toBe(false);
      expect(reapProcessWrapper).toHaveBeenCalledOnce();
    });
  });

  it("routes task stop through graceful target cleanup", async () => {
    const childRef: { current?: ChildProcess } = {};
    let capturedTarget: ProcessTarget | undefined;
    const cleanupProcessTree = vi.fn(async (target: ProcessTarget) => {
      capturedTarget = target;
      childRef.current?.emit("close", 0, null);
    });
    const tracked = trackedManager(lifecycle({ cleanupProcessTree }));
    childRef.current = tracked.child;

    await expect(tracked.manager.stop(tracked.proc.id)).resolves.toBe(
      `Process ${tracked.proc.id} stopped`,
    );
    expect(cleanupProcessTree).toHaveBeenCalledWith(
      expect.objectContaining({ pid: tracked.proc.pid, isExited: expect.any(Function) }),
    );
    expect(capturedTarget?.isExited?.()).toBe(false);
    Object.defineProperty(tracked.child, "exitCode", { value: 0, configurable: true });
    expect(capturedTarget?.isExited?.()).toBe(true);
  });

  it("keeps a process retryable when cleanup does not produce close", async () => {
    vi.useFakeTimers();
    try {
      const cleanupProcessTree = vi.fn(async () => {});
      const { manager, proc } = trackedManager(lifecycle({ cleanupProcessTree }));
      const stopping = manager.stop(proc.id);
      await vi.advanceTimersByTimeAsync(5000);

      await expect(stopping).resolves.toContain("may still be running");
      expect(manager.list()).toContain(proc);
      expect(cleanupProcessTree).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes shutdown through immediate target cleanup", () => {
    const killProcessTree = vi.fn();
    const { manager, proc } = trackedManager(lifecycle({ killProcessTree }));

    manager.shutdownAll();

    expect(killProcessTree).toHaveBeenCalledWith(
      expect.objectContaining({ pid: proc.pid, isExited: expect.any(Function) }),
    );
    expect(manager.list()[0]?.exitCode).toBe(1);
  });

  it("does not clean up records that already completed naturally", () => {
    const killProcessTree = vi.fn();
    const tracked = trackedManager(lifecycle({ killProcessTree }));
    tracked.proc.exitCode = 0;
    (tracked.manager as unknown as { children: Map<string, ChildProcess> }).children.delete(
      tracked.proc.id,
    );

    tracked.manager.shutdownAll();

    expect(killProcessTree).not.toHaveBeenCalled();
  });
});
