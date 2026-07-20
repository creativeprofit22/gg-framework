import { describe, expect, it, vi } from "vitest";
import type { ProcessManager } from "../core/process-manager.js";
import { killTask } from "./stores/taskbar-store.js";
import { createTaskKillFeedback, killTaskWithFeedback } from "./task-kill-feedback.js";

function processManagerWithStop(stop: ProcessManager["stop"]): ProcessManager {
  return { stop } as ProcessManager;
}

describe("background task kill feedback", () => {
  it("returns and awaits ProcessManager.stop before the result reaches the UI", async () => {
    let resolveStop!: (result: string) => void;
    const stop = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveStop = resolve;
        }),
    );
    const processManager = processManagerWithStop(stop as ProcessManager["stop"]);
    const appendFeedback = vi.fn();

    const pending = killTaskWithFeedback(processManager, "bg-1", "ui-1", appendFeedback);

    expect(stop).toHaveBeenCalledWith("bg-1");
    expect(appendFeedback).not.toHaveBeenCalled();

    resolveStop("Process bg-1 stopped");
    await pending;

    expect(appendFeedback).toHaveBeenCalledOnce();
    expect(appendFeedback).toHaveBeenCalledWith({
      kind: "info",
      text: "Process bg-1 stopped",
      id: "ui-1",
    });
  });

  it("returns the ProcessManager status from the store action", async () => {
    const processManager = processManagerWithStop(vi.fn().mockResolvedValue("status from stop"));

    await expect(killTask(processManager, "bg-2")).resolves.toBe("status from stop");
  });

  it("surfaces a Windows timeout as an existing-style live error item", () => {
    expect(
      createTaskKillFeedback(
        "Failed to stop process bg-3: process did not exit within 5 seconds and may still be running.",
        "ui-3",
      ),
    ).toEqual({
      kind: "error",
      headline: "Could not stop background task.",
      message:
        "Failed to stop process bg-3: process did not exit within 5 seconds and may still be running.",
      guidance: "The task may still be running. Try stopping it again.",
      id: "ui-3",
    });
  });

  it("surfaces a not-found status as a live info item", () => {
    expect(createTaskKillFeedback('No background process with id "stale"', "ui-4")).toEqual({
      kind: "info",
      text: 'No background process with id "stale"',
      id: "ui-4",
    });
  });
});
