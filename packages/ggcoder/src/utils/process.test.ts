import type { spawn, spawnSync } from "node:child_process";
import { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as logger from "../core/logger.js";
import { killProcessTree, killProcessTreeAsync, resolveWindowsTaskkillPath } from "./process.js";

function createKiller(): {
  child: ChildProcess;
  kill: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
  events: EventEmitter;
} {
  const events = new EventEmitter();
  const kill = vi.fn(() => true);
  const unref = vi.fn();
  return {
    child: Object.assign(events, { kill, unref }) as unknown as ChildProcess,
    kill,
    unref,
    events,
  };
}

function errno(code: string, message = code): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

function aliveKill(): typeof process.kill {
  return vi.fn(() => true) as unknown as typeof process.kill;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("killProcessTree on Windows", () => {
  it("resolves taskkill only from System32 with a safe fallback", () => {
    expect(resolveWindowsTaskkillPath({ SystemRoot: "  D:\\WinRoot  " })).toBe(
      "D:\\WinRoot\\System32\\taskkill.exe",
    );
    expect(resolveWindowsTaskkillPath({})).toBe("C:\\Windows\\System32\\taskkill.exe");
  });

  it("uses WINDIR when SystemRoot is unavailable", () => {
    expect(resolveWindowsTaskkillPath({ WINDIR: "E:\\Windows" })).toBe(
      "E:\\Windows\\System32\\taskkill.exe",
    );
  });

  it("looks up Windows environment keys case-insensitively", () => {
    expect(resolveWindowsTaskkillPath({ systemroot: "F:\\Windows" })).toBe(
      "F:\\Windows\\System32\\taskkill.exe",
    );
    expect(resolveWindowsTaskkillPath({ windir: "G:\\Windows" })).toBe(
      "G:\\Windows\\System32\\taskkill.exe",
    );
  });

  it.each([
    ["relative", { SystemRoot: ".\\Windows" }],
    ["drive-relative", { SystemRoot: "C:Windows" }],
    ["UNC", { SystemRoot: "\\\\server\\Windows" }],
    ["semicolon injection", { SystemRoot: "C:\\Windows;C:\\attacker" }],
    ["newline injection", { SystemRoot: "C:\\Windows\nC:\\attacker" }],
    ["control-character injection", { SystemRoot: "C:\\Win\u0000dows" }],
  ])("rejects %s SystemRoot values", (_label, env) => {
    expect(resolveWindowsTaskkillPath(env)).toBe("C:\\Windows\\System32\\taskkill.exe");
  });

  it("uses a valid WINDIR when SystemRoot is unsafe", () => {
    expect(
      resolveWindowsTaskkillPath({ SystemRoot: "\\\\attacker\\Windows", WINDIR: "D:\\Windows" }),
    ).toBe("D:\\Windows\\System32\\taskkill.exe");
  });

  it("treats an already-dead PID as a successful no-op", () => {
    const kill = vi.fn(() => {
      throw errno("ESRCH");
    }) as unknown as typeof process.kill;
    const spawnSyncMock = vi.fn() as unknown as typeof spawnSync;

    killProcessTree(111, { platform: "win32", kill, spawnSync: spawnSyncMock });

    expect(kill).toHaveBeenCalledWith(111, 0);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("uses the absolute executable and PID-only tree arguments", () => {
    const spawnSyncMock = vi.fn(() => ({
      pid: 1,
      output: [],
      stdout: null,
      stderr: null,
      status: 0,
      signal: null,
    })) as unknown as typeof spawnSync;
    const kill = aliveKill();

    killProcessTree(4321, {
      platform: "win32",
      kill,
      spawnSync: spawnSyncMock,
      env: { SystemRoot: "C:\\TrustedWindows" },
    });

    expect(spawnSyncMock).toHaveBeenCalledWith(
      "C:\\TrustedWindows\\System32\\taskkill.exe",
      ["/PID", "4321", "/T", "/F"],
      { stdio: "ignore", windowsHide: true, timeout: 5_000 },
    );
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("passes an injected timeout to synchronous taskkill", () => {
    const spawnSyncMock = vi.fn(() => ({
      pid: 1,
      output: [],
      stdout: null,
      stderr: null,
      status: 0,
      signal: null,
    })) as unknown as typeof spawnSync;

    killProcessTree(4321, {
      platform: "win32",
      kill: aliveKill(),
      spawnSync: spawnSyncMock,
      taskkillTimeoutMs: 250,
    });

    expect(spawnSyncMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ timeout: 250 }),
    );
  });

  it("logs access-denied launch failures and tries the direct PID fallback", () => {
    const warning = vi.spyOn(logger, "log").mockImplementation(() => {});
    const spawnSyncMock = vi.fn(() => {
      throw errno("EACCES", "blocked");
    }) as unknown as typeof spawnSync;
    const kill = aliveKill();

    killProcessTree(8765, { platform: "win32", kill, spawnSync: spawnSyncMock });

    expect(warning).toHaveBeenCalledWith(
      "WARN",
      "process",
      "Windows process-tree cleanup failed",
      expect.objectContaining({
        pid: "8765",
        executable: expect.stringMatching(/System32\\taskkill\.exe$/),
        failureKind: "access-denied",
        error: "blocked",
      }),
    );
    expect(kill).toHaveBeenCalledWith(8765, "SIGKILL");
  });

  it("suppresses a non-zero failure when the PID exited before the post-check", () => {
    const warning = vi.spyOn(logger, "log").mockImplementation(() => {});
    let probes = 0;
    const kill = vi.fn((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0 && probes++ > 0) throw errno("ESRCH");
      return true;
    }) as unknown as typeof process.kill;
    const spawnSyncMock = vi.fn(() => ({
      pid: 1,
      output: [],
      stdout: null,
      stderr: null,
      status: 128,
      signal: null,
    })) as unknown as typeof spawnSync;

    killProcessTree(222, { platform: "win32", kill, spawnSync: spawnSyncMock });

    expect(warning).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalledWith(222, "SIGKILL");
  });
});

describe("killProcessTreeAsync on Windows", () => {
  it("waits for success and cleans listeners", async () => {
    const killer = createKiller();
    const spawnMock = vi.fn(() => killer.child) as unknown as typeof spawn;
    const kill = aliveKill();
    let settled = false;

    const cleanup = killProcessTreeAsync(4321, {
      platform: "win32",
      spawn: spawnMock,
      kill,
      env: { SystemRoot: "C:\\Windows" },
    });
    void cleanup.then(() => {
      settled = true;
    });

    expect(spawnMock).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\taskkill.exe",
      ["/PID", "4321", "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    );
    expect(killer.unref).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(settled).toBe(false);

    killer.events.emit("close", 0, null);
    await cleanup;
    expect(kill).toHaveBeenCalledTimes(1);
    expect(killer.events.listenerCount("error")).toBe(0);
    expect(killer.events.listenerCount("close")).toBe(0);
  });

  it("times out taskkill, cleans listeners and timer, then falls back to the target PID", async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(logger, "log").mockImplementation(() => {});
    const killer = createKiller();
    const kill = aliveKill();
    const cleanup = killProcessTreeAsync(9876, {
      platform: "win32",
      spawn: vi.fn(() => killer.child) as unknown as typeof spawn,
      kill,
      taskkillTimeoutMs: 250,
    });

    expect(killer.events.listenerCount("error")).toBe(1);
    expect(killer.events.listenerCount("close")).toBe(1);
    await vi.advanceTimersByTimeAsync(250);
    await cleanup;

    expect(killer.kill).toHaveBeenCalledOnce();
    expect(killer.kill).toHaveBeenCalledWith("SIGKILL");
    expect(killer.unref).toHaveBeenCalledTimes(2);
    expect(killer.events.listenerCount("error")).toBe(0);
    expect(killer.events.listenerCount("close")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(warning).toHaveBeenCalledWith(
      "WARN",
      "process",
      "Windows process-tree cleanup failed",
      expect.objectContaining({ pid: "9876", failureKind: "timed-out" }),
    );
    expect(kill).toHaveBeenCalledWith(9876, "SIGKILL");

    killer.events.emit("close", 0, null);
    expect(kill).toHaveBeenCalledTimes(3);
  });

  it("observes an emitted access-denied error and falls back exactly once", async () => {
    const warning = vi.spyOn(logger, "log").mockImplementation(() => {});
    const killer = createKiller();
    const spawnMock = vi.fn(() => killer.child) as unknown as typeof spawn;
    const kill = aliveKill();
    const cleanup = killProcessTreeAsync(8765, { platform: "win32", spawn: spawnMock, kill });

    killer.events.emit("error", errno("EPERM", "denied"));
    killer.events.emit("close", 1, null);
    await cleanup;

    expect(warning).toHaveBeenCalledWith(
      "WARN",
      "process",
      "Windows process-tree cleanup failed",
      expect.objectContaining({ failureKind: "access-denied", error: "denied" }),
    );
    expect(kill).toHaveBeenCalledWith(8765, "SIGKILL");
    expect(kill).toHaveBeenCalledTimes(3);
    expect(killer.events.listenerCount("error")).toBe(0);
    expect(killer.events.listenerCount("close")).toBe(0);
  });

  it("logs a non-zero status and signal", async () => {
    const warning = vi.spyOn(logger, "log").mockImplementation(() => {});
    const killer = createKiller();
    const kill = aliveKill();
    const cleanup = killProcessTreeAsync(333, {
      platform: "win32",
      spawn: vi.fn(() => killer.child) as unknown as typeof spawn,
      kill,
    });

    killer.events.emit("close", 9, "SIGTERM");
    await cleanup;

    expect(warning).toHaveBeenCalledWith(
      "WARN",
      "process",
      "Windows process-tree cleanup failed",
      expect.objectContaining({
        pid: "333",
        failureKind: "non-zero",
        status: "9",
        signal: "SIGTERM",
      }),
    );
  });

  it("suppresses an asynchronous failure after the target exits", async () => {
    const warning = vi.spyOn(logger, "log").mockImplementation(() => {});
    const killer = createKiller();
    let probes = 0;
    const kill = vi.fn((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === 0 && probes++ > 0) throw errno("ESRCH");
      return true;
    }) as unknown as typeof process.kill;
    const cleanup = killProcessTreeAsync(444, {
      platform: "win32",
      spawn: vi.fn(() => killer.child) as unknown as typeof spawn,
      kill,
    });

    killer.events.emit("close", 1, null);
    await cleanup;

    expect(warning).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalledWith(444, "SIGKILL");
  });

  it("handles synchronous spawn throws and logs a live fallback failure", async () => {
    const warning = vi.spyOn(logger, "log").mockImplementation(() => {});
    const kill = vi.fn((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === "SIGKILL") throw errno("EACCES", "fallback blocked");
      return true;
    }) as unknown as typeof process.kill;

    await killProcessTreeAsync(555, {
      platform: "win32",
      spawn: vi.fn(() => {
        throw errno("ENOENT", "missing taskkill");
      }) as unknown as typeof spawn,
      kill,
    });

    expect(warning).toHaveBeenCalledWith(
      "WARN",
      "process",
      "Windows process-tree cleanup failed",
      expect.objectContaining({ failureKind: "launch", error: "missing taskkill" }),
    );
    expect(warning).toHaveBeenCalledWith(
      "WARN",
      "process",
      "Direct PID cleanup fallback failed",
      expect.objectContaining({ pid: "555", error: "fallback blocked" }),
    );
  });
});
