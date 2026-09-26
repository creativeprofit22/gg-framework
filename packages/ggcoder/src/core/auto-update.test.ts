import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  checkAndAutoUpdate,
  startPeriodicUpdateCheck,
  stopPeriodicUpdateCheck,
} from "./auto-update.js";

// Use a temp directory for state file instead of the real ~/.gg
const tmpDir = path.join(os.tmpdir(), `gg-update-test-${process.pid}`);
let child: EventEmitter & { unref: ReturnType<typeof vi.fn> };

// Mock the state file path
vi.mock("node:os", async () => {
  const actual = await vi.importActual("node:os");
  return {
    ...(actual as Record<string, unknown>),
    default: {
      ...(actual as Record<string, unknown>),
      homedir: () => tmpDir,
    },
  };
});

// Mock spawn so we never actually run install commands
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(() => "/usr/lib/node_modules"),
}));

function writeStateFile(state: Record<string, unknown>): void {
  fs.mkdirSync(path.join(tmpDir, ".gg"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, ".gg", "update-state.json"), JSON.stringify(state));
}

function readStateFile(): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(tmpDir, ".gg", "update-state.json"), "utf-8"));
  } catch {
    return null;
  }
}

beforeEach(() => {
  fs.mkdirSync(path.join(tmpDir, ".gg"), { recursive: true });
  // Clear any existing state
  try {
    fs.unlinkSync(path.join(tmpDir, ".gg", "update-state.json"));
  } catch {
    // fine
  }
  vi.restoreAllMocks();
  child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  vi.mocked(spawn).mockReset().mockReturnValue(child as unknown as ChildProcess);
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.spyOn(process, "argv", "get").mockReturnValue(["node", "/usr/lib/node_modules/@kenkaiiii/ggcoder/cli.js"]);
  vi.spyOn(fs, "realpathSync").mockImplementation((file) => String(file));
});

afterEach(() => {
  stopPeriodicUpdateCheck();
  vi.restoreAllMocks();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // fine
  }
});

describe("checkAndAutoUpdate", () => {
  it("returns null on first run with no state file", () => {
    // Mock fetch to return a version (but the background check is async, so
    // on first call it just schedules a check and returns null)
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ version: "99.0.0" }),
      }),
    );

    const result = checkAndAutoUpdate("1.0.0");
    expect(result).toBeNull();
  });

  it("returns null when already on latest version", () => {
    writeStateFile({
      lastCheckedAt: Date.now(),
      latestVersion: "1.0.0",
      updatePending: true,
    });

    const result = checkAndAutoUpdate("1.0.0");
    expect(result).toBeNull();

    // Should clear the pending flag
    const state = readStateFile();
    expect(state?.updatePending).toBe(false);
  });

  it("returns null when on a newer version than registry (manual install)", () => {
    writeStateFile({
      lastCheckedAt: Date.now(),
      latestVersion: "1.0.0",
      updatePending: true,
    });

    const result = checkAndAutoUpdate("2.0.0");
    expect(result).toBeNull();

    const state = readStateFile();
    expect(state?.updatePending).toBe(false);
  });

  it("triggers background update when pending update exists", () => {
    writeStateFile({
      lastCheckedAt: Date.now(),
      latestVersion: "2.0.0",
      updatePending: true,
    });

    const result = checkAndAutoUpdate("1.0.0");

    expect(result).toContain("2.0.0");
    expect(result).toContain("Attempting a background update");
    expect(vi.mocked(spawn)).toHaveBeenCalled();
    expect(readStateFile()?.updatePending).toBe(true);
    expect(readStateFile()?.lastUpdateAttempt).toBeUndefined();
    child.emit("spawn");
    expect(readStateFile()?.lastUpdateAttempt).toBeDefined();
    expect(readStateFile()?.updatePending).toBe(true);
    child.emit("exit", 0);

    // Only a successful install clears the pending flag.
    const state = readStateFile();
    expect(state?.updatePending).toBe(false);
    expect(state?.lastUpdateAttempt).toBeDefined();
  });

  it("schedules background check when last check was long ago", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ version: "5.0.0" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    writeStateFile({
      lastCheckedAt: 0, // very old
      latestVersion: "1.0.0",
      updatePending: false,
    });

    checkAndAutoUpdate("1.0.0");

    // Give the async check time to complete
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });

    // Wait for the state to be written
    await vi.waitFor(() => {
      const state = readStateFile();
      expect(state?.latestVersion).toBe("5.0.0");
      expect(state?.updatePending).toBe(true);
    });
  });

  it("does not schedule check when recently checked", () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ version: "5.0.0" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    writeStateFile({
      lastCheckedAt: Date.now(), // just now
      latestVersion: "1.0.0",
      updatePending: false,
    });

    checkAndAutoUpdate("1.0.0");

    // fetch should NOT be called since we just checked
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("handles fetch failure gracefully", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network error"));
    vi.stubGlobal("fetch", fetchMock);

    writeStateFile({
      lastCheckedAt: 0,
      updatePending: false,
    });

    // Should not throw
    const result = checkAndAutoUpdate("1.0.0");
    expect(result).toBeNull();
  });

  it("handles corrupt state file gracefully", () => {
    fs.writeFileSync(path.join(tmpDir, ".gg", "update-state.json"), "not json{{{");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ version: "2.0.0" }),
      }),
    );

    // Should not throw — treats corrupt file like no file
    const result = checkAndAutoUpdate("1.0.0");
    expect(result).toBeNull();
  });
});

describe("startPeriodicUpdateCheck", () => {
  it("calls onUpdate when a newer version is found", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ version: "99.0.0" }),
      }),
    );

    const onUpdate = vi.fn();
    vi.useFakeTimers();

    startPeriodicUpdateCheck("1.0.0", onUpdate);

    // Advance past one check interval
    await vi.advanceTimersByTimeAsync(1 * 60 * 60 * 1000 + 100);

    expect(onUpdate).toHaveBeenCalledWith(expect.stringContaining("99.0.0"));

    vi.useRealTimers();
  });

  it("does not call onUpdate when already on latest", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ version: "1.0.0" }),
      }),
    );

    const onUpdate = vi.fn();
    vi.useFakeTimers();

    startPeriodicUpdateCheck("1.0.0", onUpdate);

    await vi.advanceTimersByTimeAsync(1 * 60 * 60 * 1000 + 100);

    expect(onUpdate).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("stops checking after first notification", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ version: "99.0.0" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const onUpdate = vi.fn();
    vi.useFakeTimers();

    startPeriodicUpdateCheck("1.0.0", onUpdate);

    // First interval
    await vi.advanceTimersByTimeAsync(1 * 60 * 60 * 1000 + 100);
    expect(onUpdate).toHaveBeenCalledTimes(1);

    // Second interval — should NOT fire again (timer stopped)
    fetchMock.mockClear();
    await vi.advanceTimersByTimeAsync(1 * 60 * 60 * 1000 + 100);
    expect(fetchMock).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});
