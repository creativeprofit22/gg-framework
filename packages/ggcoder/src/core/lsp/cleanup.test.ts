import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type * as ChildProcessModule from "node:child_process";
import type * as ProcessModule from "../../utils/process.js";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { killProcessTree, killProcessTreeAsync } from "../../utils/process.js";
import { LspClient } from "./client.js";
import { LspClientPool } from "./pool.js";
import type { LspServerSpec } from "./servers.js";

vi.mock("node:child_process", async (original) => ({
  ...await original<typeof ChildProcessModule>(), spawn: vi.fn(),
}));
vi.mock("../../utils/process.js", async (original) => ({
  ...await original<typeof ProcessModule>(),
  killProcessTree: vi.fn(), killProcessTreeAsync: vi.fn(async () => {}),
}));

const spec: LspServerSpec = {
  id: "injected", extensions: [".test"], rootMarkers: [],
  languageIdFor: () => "test", resolveCommand: () => ({ command: "injected", args: [] }),
};
let child: ChildProcess;
let pool: LspClientPool;
beforeEach(() => {
  child = Object.assign(new EventEmitter(), {
    pid: 4321, exitCode: null, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
  }) as unknown as ChildProcess;
  vi.mocked(spawn).mockReturnValue(child);
  vi.mocked(killProcessTreeAsync).mockResolvedValue(undefined);
  vi.spyOn(LspClient.prototype, "initialize").mockResolvedValue(undefined);
  pool = new LspClientPool({ idleTtlMs: 0 });
});
afterEach(() => {
  child.emit("close", 0, null);
  pool.shutdownAll();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("verified language-server ownership", () => {
  it("releases a failed command resolver and allows a fresh holder to retry", async () => {
    const resolveCommand = vi.fn(spec.resolveCommand).mockImplementationOnce(() => {
      throw new Error("injected resolver failure");
    });
    const failingSpec = { ...spec, resolveCommand };
    const holder = {};
    await expect(pool.retain(failingSpec, "/workspace", holder)).resolves.toEqual({ status: "server_failed" });
    await pool.releaseAndWait(holder);
    expect(pool.size).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
    await expect(pool.retain(failingSpec, "/workspace", {})).resolves.toMatchObject({ status: "ready" });
    expect(resolveCommand).toHaveBeenCalledTimes(2);
  });

  it("releases a shared holder without killing another session's server", async () => {
    const first = {}, second = {};
    await pool.retain(spec, "/workspace", first);
    await pool.retain(spec, "/workspace", second);
    await pool.releaseAndWait(first);
    expect(pool.refCount(spec, "/workspace")).toBe(1);
    expect(killProcessTreeAsync).not.toHaveBeenCalled();
    const release = pool.releaseAndWait(second);
    await Promise.resolve();
    expect(killProcessTreeAsync).toHaveBeenCalledWith(
      expect.objectContaining({ pid: 4321, isExited: expect.any(Function) }), { requireSettlement: true },
    );
    expect(pool.refCount(spec, "/workspace")).toBe(1);
    child.emit("close", 0, null);
    await release;
    expect(pool.size).toBe(0);
    expect(killProcessTree).not.toHaveBeenCalled();
    expect(await pool.retain(spec, "/workspace", second)).toEqual({ status: "unavailable" });
  });

  it("rejects failed cleanup and blocks reuse of the surviving server", async () => {
    const holder = {};
    await pool.retain(spec, "/workspace", holder);
    vi.mocked(killProcessTreeAsync).mockRejectedValue(new Error("injected survivor"));
    await expect(pool.releaseAndWait(holder)).rejects.toThrow("injected survivor");
    await expect(pool.retain(spec, "/workspace", {})).rejects.toThrow("injected survivor");
    expect(pool.refCount(spec, "/workspace")).toBe(1);
    expect(spawn).toHaveBeenCalledOnce();
    expect(killProcessTree).not.toHaveBeenCalled();
  });

  it.each(["failed initialization", "dead server", "idle eviction"])("retains native ownership after %s", async (mode) => {
    if (mode === "failed initialization") vi.mocked(LspClient.prototype.initialize).mockRejectedValue(new Error("init failed"));
    const holder = {};
    await pool.retain(spec, "/workspace", holder);
    if (mode === "dead server") pool.markDead(spec, "/workspace");
    if (mode === "idle eviction") pool.sweepNow(Date.now() + 1);
    await Promise.resolve();
    let settled = false;
    const release = pool.releaseAndWait(holder).then(() => { settled = true; });
    await Promise.resolve();
    expect(killProcessTreeAsync).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    child.emit("close", 0, null);
    await release;
    expect(settled).toBe(true);
  });
});
