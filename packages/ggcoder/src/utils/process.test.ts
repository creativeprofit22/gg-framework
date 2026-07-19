import type { spawn } from "node:child_process";
import { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { killProcessTreeAsync } from "./process.js";

function createKiller(): {
  child: ChildProcess;
  unref: ReturnType<typeof vi.fn>;
  events: EventEmitter;
} {
  const events = new EventEmitter();
  const unref = vi.fn();
  return {
    child: Object.assign(events, { unref }) as unknown as ChildProcess,
    unref,
    events,
  };
}

describe("killProcessTreeAsync on Windows", () => {
  it("starts taskkill with tree and force flags without synchronously waiting for it", async () => {
    const killer = createKiller();
    const spawnMock = vi.fn(() => killer.child) as unknown as typeof spawn;
    const killMock = vi.fn() as unknown as typeof process.kill;
    let settled = false;

    const cleanup = killProcessTreeAsync(4321, {
      platform: "win32",
      spawn: spawnMock,
      kill: killMock,
    });
    void cleanup.then(() => {
      settled = true;
    });

    expect(spawnMock).toHaveBeenCalledWith("taskkill", ["/PID", "4321", "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    expect(killer.unref).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(settled).toBe(false);

    killer.events.emit("close", 0);
    await cleanup;
    expect(killMock).not.toHaveBeenCalled();
    expect(killer.events.listenerCount("error")).toBe(0);
    expect(killer.events.listenerCount("close")).toBe(0);
  });

  it("falls back to direct SIGKILL when taskkill fails", async () => {
    const killer = createKiller();
    const spawnMock = vi.fn(() => killer.child) as unknown as typeof spawn;
    const killMock = vi.fn() as unknown as typeof process.kill;
    const cleanup = killProcessTreeAsync(8765, {
      platform: "win32",
      spawn: spawnMock,
      kill: killMock,
    });

    killer.events.emit("error", new Error("taskkill unavailable"));
    await cleanup;

    expect(killMock).toHaveBeenCalledWith(8765, "SIGKILL");
    expect(killer.events.listenerCount("error")).toBe(0);
    expect(killer.events.listenerCount("close")).toBe(0);
  });
});
