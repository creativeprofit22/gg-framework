/**
 * Heavy-check slots through ProcessManager: two managers sharing one pool stand
 * in for two windows of one daemon. Fake children keep it deterministic.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localProcessLifecycle, type ProcessLifecycleAdapter } from "../tools/operations.js";
import { HeavyCheckSlots } from "./machine-profile.js";
import { ProcessManager } from "./process-manager.js";

interface FakeChild {
  child: ChildProcess;
  close(code?: number): void;
}

function fakeChild(pid: number): FakeChild {
  const emitter = new EventEmitter();
  const state: { exitCode: number | null } = { exitCode: null };
  Object.defineProperties(emitter, {
    exitCode: { get: () => state.exitCode, configurable: true },
    signalCode: { get: () => null, configurable: true },
  });
  const child = Object.assign(emitter, {
    pid,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    unref: vi.fn(),
  }) as unknown as ChildProcess;
  return {
    child,
    close(code = 0) {
      state.exitCode = code;
      emitter.emit("exit", code, null);
      emitter.emit("close", code, null);
    },
  };
}

const managers: ProcessManager[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const pm of managers.splice(0)) pm.shutdownAll();
  await Promise.all(
    dirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

async function window(
  slots: HeavyCheckSlots,
  spawn: ProcessLifecycleAdapter["spawn"],
): Promise<ProcessManager> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-heavy-slots-"));
  dirs.push(dir);
  const lifecycle: ProcessLifecycleAdapter = {
    ...localProcessLifecycle,
    spawn,
    killProcessTree: () => {},
    cleanupProcessTree: async () => {},
  };
  const pm = new ProcessManager(lifecycle, undefined, {
    backgroundLogRoot: dir,
    heavyCheckSlots: slots,
  });
  managers.push(pm);
  return pm;
}

function spawning(fake: FakeChild): ProcessLifecycleAdapter["spawn"] {
  return () => {
    queueMicrotask(() => fake.child.emit("spawn"));
    return fake.child;
  };
}

describe("ProcessManager heavy-check slots", () => {
  it("shares one pool across windows: same session refuses, another window queues until close", async () => {
    const slots = new HeavyCheckSlots();
    const running = fakeChild(5001);
    const first = await window(slots, spawning(running));
    const second = await window(slots, spawning(fakeChild(5002)));

    const lease = await first.acquireHeavySlot("pnpm test", "session-a", 1);
    expect(lease.ok).toBe(true);
    if (!lease.ok) return;
    const started = await first.start("pnpm test", "/w", undefined, undefined, {}, lease.lease);
    expect(slots.held).toBe(1);

    const again = await first.acquireHeavySlot("pnpm build", "session-a", 1);
    expect(again).toMatchObject({ ok: false, aborted: false });
    if (!again.ok) expect(again.message).toContain(`task ${started.id}`);

    const notices: string[] = [];
    const queued = second.acquireHeavySlot("pnpm test", "session-b", 1, undefined, (m) =>
      notices.push(m),
    );
    expect(notices[0]).toContain("Waiting for another window's `pnpm test`");
    expect(slots.held).toBe(1);

    running.close(0);
    const granted = await queued;
    expect(granted.ok).toBe(true);
    if (granted.ok) granted.lease.release();
    expect(slots.held).toBe(0);
  });

  it("lets a cancelled wait go without touching the running holder", async () => {
    const slots = new HeavyCheckSlots();
    const running = fakeChild(5003);
    const first = await window(slots, spawning(running));
    const second = await window(slots, spawning(fakeChild(5004)));
    const lease = await first.acquireHeavySlot("cargo test", "session-a", 1);
    if (!lease.ok) throw new Error("expected a lease");
    await first.start("cargo test", "/w", undefined, undefined, {}, lease.lease);

    const abort = new AbortController();
    const waiting = second.acquireHeavySlot("cargo test", "session-b", 1, abort.signal);
    abort.abort();
    expect(await waiting).toMatchObject({ ok: false, aborted: true });
    expect(first.list()[0]).toMatchObject({ isRunning: true });
    expect(slots.held).toBe(1);
  });

  it("releases the lease when the spawn fails", async () => {
    const slots = new HeavyCheckSlots();
    const pm = await window(slots, () => {
      throw new Error("spawn failed");
    });
    const lease = await pm.acquireHeavySlot("pnpm test", "session-a", 1);
    if (!lease.ok) throw new Error("expected a lease");
    await expect(
      pm.start("pnpm test", "/w", undefined, undefined, {}, lease.lease),
    ).rejects.toThrow("spawn failed");
    expect(slots.held).toBe(0);
  });

  it("keeps a handed-off foreground lease until the adopted child closes", async () => {
    const slots = new HeavyCheckSlots();
    const pm = await window(slots, spawning(fakeChild(5005)));
    const lease = await pm.acquireHeavySlot("pnpm test", "session-a", 1);
    if (!lease.ok) throw new Error("expected a lease");
    const fake = fakeChild(5006);
    const { id } = await pm.adopt({
      child: fake.child,
      pid: 5006,
      command: "pnpm test",
      startedAt: Date.now(),
      limits: { quietMs: null, hardMs: null, exitSettleMs: 1_000 },
      takeOver: () => ({ seedOutput: "", lastOutputAt: Date.now() }),
      heavySlot: lease.lease,
    });
    expect(slots.held).toBe(1);
    const refused = await pm.acquireHeavySlot("pnpm test", "session-a", 1);
    if (!refused.ok) expect(refused.message).toContain(`task ${id}`);
    else throw new Error("expected a refusal");

    fake.close(0);
    expect(slots.held).toBe(0);
  });

  it("does not limit anything when the limit is 0", async () => {
    const slots = new HeavyCheckSlots();
    const pm = await window(slots, spawning(fakeChild(5007)));
    const first = await pm.acquireHeavySlot("pnpm test", "session-a", 0);
    const second = await pm.acquireHeavySlot("pnpm test", "session-a", 0);
    expect(first.ok && second.ok).toBe(true);
    expect(slots.held).toBe(0);
  });
});
