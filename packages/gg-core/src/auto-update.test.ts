import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutoUpdater } from "./auto-update.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn(), execFileSync: vi.fn() }));

let root: string;
let statePath: string;
let child: EventEmitter & { unref: ReturnType<typeof vi.fn> };
let updater: ReturnType<typeof createAutoUpdater>;
const pending = () => ({ lastCheckedAt: Date.now(), latestVersion: "2.0.0", updatePending: true });
const readState = () => JSON.parse(fs.readFileSync(statePath, "utf8"));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gg-core-update-"));
  statePath = path.join(root, "update-state.json");
  fs.writeFileSync(statePath, JSON.stringify(pending()));
  child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  vi.mocked(spawn).mockReset().mockReturnValue(child as unknown as ChildProcess);
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.spyOn(process, "argv", "get").mockReturnValue(["node", "/usr/lib/node_modules/@kenkaiiii/ggcoder/cli.js"]);
  vi.spyOn(fs, "realpathSync").mockImplementation((file) => String(file));
  vi.mocked(execFileSync).mockReset().mockImplementation((command) => {
    if (command === "pnpm") return "/home/user/.local/share/pnpm/global/5/node_modules";
    if (command === "yarn") return "/home/user/.config/yarn/global";
    return "/usr/lib/node_modules";
  });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  updater = createAutoUpdater({ packageName: "@kenkaiiii/ggcoder", stateFilePath: statePath });
});

afterEach(() => {
  updater.stopPeriodicUpdateCheck();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("background updater lifecycle", () => {
  it.each([
    String.raw`E:\Projects\gg-framework-fork\packages\ggcoder\dist\cli.js`,
    "/work/project/node_modules/@kenkaiiii/ggcoder/dist/cli.js",
    "/opt/bundled/cli.js",
    "/unknown/ggcoder.js",
    "",
  ])("never installs or promises next-launch changes for %s", (script) => {
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", script]);
    expect(updater.checkAndAutoUpdate("1.0.0")).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
    expect(readState().updatePending).toBe(true);
    expect(readState().lastUpdateAttempt).toBeUndefined();
  });
  it("does not promise automatic updates from periodic checkout checks", async () => {
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", String.raw`E:\Projects\gg-framework-fork\packages\ggcoder\dist\cli.js`]);
    vi.mocked(fetch).mockResolvedValue({ json: async () => ({ version: "2.0.0" }) } as Response);
    const notify = vi.fn();
    vi.useFakeTimers();
    try {
      updater.startPeriodicUpdateCheck("1.0.0", notify);
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(notify).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(execFileSync).not.toHaveBeenCalled();
    } finally {
      updater.stopPeriodicUpdateCheck();
      vi.useRealTimers();
    }
  });

  it("records an attempt only on spawn and clears pending only on successful exit", () => {
    expect(updater.checkAndAutoUpdate("1.0.0")).toContain("Attempting a background update");
    expect(readState().lastUpdateAttempt).toBeUndefined();
    expect(readState().updatePending).toBe(true);
    expect(child.unref).toHaveBeenCalledOnce();
    expect(updater.checkAndAutoUpdate("1.0.0")).toBeNull();
    expect(spawn).toHaveBeenCalledOnce();
    child.emit("spawn");
    expect(readState().lastUpdateAttempt).toEqual(expect.any(Number));
    expect(readState().updatePending).toBe(true);
    child.emit("exit", 0);
    expect(readState().updatePending).toBe(false);
  });

  it.each([1, null])("keeps pending after failed/signalled exit %s", (code) => {
    updater.checkAndAutoUpdate("1.0.0");
    child.emit("spawn");
    child.emit("exit", code);
    expect(readState().updatePending).toBe(true);
    updater.checkAndAutoUpdate("1.0.0");
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("handles synchronous spawn failure without claiming an attempt", () => {
    vi.mocked(spawn).mockImplementation(() => { throw new Error("EINVAL"); });
    expect(updater.checkAndAutoUpdate("1.0.0")).toBeNull();
    expect(readState().updatePending).toBe(true);
    expect(readState().lastUpdateAttempt).toBeUndefined();
  });

  it("does not let a stale check erase pending state during an install", () => {
    fs.writeFileSync(statePath, JSON.stringify({ ...pending(), lastCheckedAt: 0 }));
    updater.checkAndAutoUpdate("1.0.0");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not clear a newer pending version on exit", () => {
    updater.checkAndAutoUpdate("1.0.0");
    child.emit("spawn");
    fs.writeFileSync(statePath, JSON.stringify({ ...pending(), latestVersion: "3.0.0" }));
    child.emit("exit", 0);
    expect(readState().updatePending).toBe(true);
    expect(readState().latestVersion).toBe("3.0.0");
  });

  it.each([
    ["/usr/lib/node_modules/@kenkaiiii/ggcoder/cli.js", "npm", ["install", "-g"]],
    ["/home/user/.local/share/pnpm/global/5/node_modules/@kenkaiiii/ggcoder/cli.js", "pnpm", ["add", "-g"]],
    ["/home/user/.config/yarn/global/node_modules/@kenkaiiii/ggcoder/cli.js", "yarn", ["global", "add"]],
  ] as const)("passes separate arguments for %s", (script, manager, prefix) => {
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", script]);
    vi.stubEnv("QWEN_CLOUD_TOKEN_PLAN_KEY", "fixture-not-a-secret");
    try {
      updater.checkAndAutoUpdate("1.0.0");
      expect(spawn).toHaveBeenCalledWith(manager, [...prefix, "@kenkaiiii/ggcoder@latest"],
        expect.objectContaining({ shell: false, detached: true, stdio: "ignore", windowsHide: true }));
      const options = vi.mocked(spawn).mock.calls[0]![2]!;
      expect(options.env).not.toHaveProperty("QWEN_CLOUD_TOKEN_PLAN_KEY");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("absorbs asynchronous ENOENT and leaves the update retryable", async () => {
    updater.checkAndAutoUpdate("1.0.0");
    await expect(new Promise<void>((resolve, reject) => {
      setImmediate(() => {
        try {
          child.emit("error", Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" }));
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    })).resolves.toBeUndefined();
    expect(readState().updatePending).toBe(true);
    expect(readState().lastUpdateAttempt).toBeUndefined();
  });
});
