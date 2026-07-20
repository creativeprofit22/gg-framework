import { describe, expect, it, vi } from "vitest";
import { ProcessManager } from "../core/process-manager.js";
import { createTaskStopTool } from "./task-stop.js";

describe("task_stop tool", () => {
  it("documents platform-specific process-tree termination and delegates by ID", async () => {
    const processManager = new ProcessManager();
    const stop = vi.spyOn(processManager, "stop").mockResolvedValue("Process bg-test stopped");
    const tool = createTaskStopTool(processManager);

    expect(tool.description).toBe(
      "Stop a background process tree by ID. On POSIX, sends SIGTERM then hard-kills the tree after 5 seconds; on Windows, force-terminates the PID tree immediately.",
    );

    const result = await tool.execute({ id: "bg-test" }, {
      signal: new AbortController().signal,
    } as never);

    expect(stop).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledWith("bg-test");
    expect(result).toBe("Process bg-test stopped");
  });
});
