import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { ProcessManager, type BackgroundProcess } from "../core/process-manager.js";
import { createTools } from "./index.js";
import { localOperations, localProcessLifecycle } from "./operations.js";
import { createTaskStopTool } from "./task-stop.js";

describe("task_stop tool", () => {
  it("documents platform-specific process-tree termination and delegates by ID", async () => {
    const processManager = new ProcessManager();
    const stop = vi.spyOn(processManager, "stop").mockResolvedValue("Process bg-test stopped");
    const tool = createTaskStopTool(processManager);

    expect(tool.description).toBe(
      "Stop a background process tree by ID using the configured execution target's cleanup lifecycle.",
    );

    const result = await tool.execute({ id: "bg-test" }, {
      signal: new AbortController().signal,
    } as never);

    expect(stop).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledWith("bg-test");
    expect(result).toBe("Process bg-test stopped");
  });

  it("routes task_stop through the manager's custom lifecycle adapter", async () => {
    const emitter = new EventEmitter();
    const state = { exitCode: null as number | null };
    Object.defineProperties(emitter, {
      pid: { value: 7654 },
      exitCode: { get: () => state.exitCode },
      signalCode: { value: null },
    });
    const child = emitter as unknown as ChildProcess;
    const cleanupProcessTree = vi.fn(async () => {
      state.exitCode = 0;
      emitter.emit("close", 0, null);
    });
    const { processManager: manager, tools } = await createTools(process.cwd(), {
      operations: {
        ...localOperations,
        process: { ...localProcessLifecycle, cleanupProcessTree },
      },
      lspDiagnostics: false,
    });
    const proc: BackgroundProcess = {
      id: "remote-bg",
      pid: 7654,
      command: "remote command",
      logFile: "remote.log",
      startedAt: Date.now(),
      completedAt: null,
      exitCode: null,
      signal: null,
      lastReadOffset: null,
    };
    const internals = manager as unknown as {
      processes: Map<string, BackgroundProcess>;
      children: Map<string, ChildProcess>;
    };
    internals.processes.set(proc.id, proc);
    internals.children.set(proc.id, child);

    const taskStop = tools.find((tool) => tool.name === "task_stop");
    if (!taskStop) throw new Error("task_stop was not registered");
    const result = await taskStop.execute({ id: proc.id }, {
      signal: new AbortController().signal,
    } as never);

    expect(result).toBe(`Process ${proc.id} stopped`);
    expect(cleanupProcessTree).toHaveBeenCalledWith(
      expect.objectContaining({ pid: 7654, isExited: expect.any(Function) }),
    );
  });
});
