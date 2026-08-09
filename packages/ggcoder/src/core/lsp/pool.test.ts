import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LspManager } from "./manager.js";
import { LspClientPool } from "./pool.js";
import type { LspServerSpec } from "./servers.js";
import { removeWhenReleased } from "./test-support.js";

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../tools/__fixtures__/fake-lsp-server.mjs",
);

function fakeSpec(serverArgs: string[] = []): LspServerSpec {
  return {
    id: "fake",
    extensions: [".fake"],
    rootMarkers: ["fake-root.json"],
    languageIdFor: () => "fake",
    resolveCommand: () => ({ command: process.execPath, args: [FIXTURE, ...serverArgs] }),
  };
}

/** True while a pid is a live process. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(file: string, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = await fs.readFile(file, "utf8").catch(() => undefined);
    if (body) return body;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitUntilDead(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

describe("LspClientPool", () => {
  let tmpDir: string;
  let pool: LspClientPool;
  const managers: LspManager[] = [];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-pool-test-"));
    await fs.writeFile(path.join(tmpDir, "fake-root.json"), "{}");
    // Long TTL by default so only the tests that mean to exercise expiry do.
    pool = new LspClientPool({ idleTtlMs: 60_000 });
  });

  afterEach(async () => {
    for (const manager of managers.splice(0)) manager.shutdownAll();
    pool.shutdownAll();
    await removeWhenReleased(tmpDir);
  });

  /**
   * Two managers sharing one catalog spec is exactly the production shape: the
   * server catalog is module-level, so every session sees the same spec object.
   */
  function twoSessions(spec: LspServerSpec): [LspManager, LspManager] {
    const build = (): LspManager => {
      const manager = new LspManager(tmpDir, {
        catalog: [spec],
        pool,
        warmBudgetMs: 5000,
        firstBudgetMs: 5000,
      });
      managers.push(manager);
      return manager;
    };
    return [build(), build()];
  }

  it("spawns ONE server for two sessions on the same project root", async () => {
    const pidFile = path.join(tmpDir, "server.pid");
    const spec = fakeSpec([`--pid-file=${pidFile}`]);
    const [a, b] = twoSessions(spec);

    const first = await a.diagnosticsAfterWrite(path.join(tmpDir, "a.fake"), "has ERROR here\n");
    const second = await b.diagnosticsAfterWrite(path.join(tmpDir, "b.fake"), "has ERROR here\n");

    // Both sessions get real diagnostics from the one shared server.
    expect(first).toContain("Diagnostics in a.fake");
    expect(second).toContain("Diagnostics in b.fake");
    expect(pool.size).toBe(1);
    expect(pool.refCount(spec, tmpDir)).toBe(2);
  });

  it("keeps the server alive when one session disposes, and kills it when the last does", async () => {
    const pidFile = path.join(tmpDir, "server.pid");
    const spec = fakeSpec([`--pid-file=${pidFile}`]);
    const [a, b] = twoSessions(spec);

    await a.diagnosticsAfterWrite(path.join(tmpDir, "a.fake"), "ok\n");
    await b.diagnosticsAfterWrite(path.join(tmpDir, "b.fake"), "ok\n");
    const pid = Number(await waitForFile(pidFile));
    expect(alive(pid)).toBe(true);

    a.shutdownAll();
    expect(pool.refCount(spec, tmpDir)).toBe(1);
    // The surviving session's server must still be running and usable.
    expect(alive(pid)).toBe(true);
    const afterFirstDispose = await b.diagnosticsAfterWrite(
      path.join(tmpDir, "c.fake"),
      "has ERROR here\n",
    );
    expect(afterFirstDispose).toContain("Diagnostics in c.fake");

    b.shutdownAll();
    expect(pool.size).toBe(0);
    expect(await waitUntilDead(pid)).toBe(true);
  }, 20_000);

  it("gives different project roots their own servers", async () => {
    const otherRoot = path.join(tmpDir, "nested");
    await fs.mkdir(otherRoot, { recursive: true });
    await fs.writeFile(path.join(otherRoot, "fake-root.json"), "{}");
    const spec = fakeSpec();
    const [a] = twoSessions(spec);

    await a.diagnosticsAfterWrite(path.join(tmpDir, "a.fake"), "ok\n");
    await a.diagnosticsAfterWrite(path.join(otherRoot, "b.fake"), "ok\n");

    expect(pool.size).toBe(2);
  });

  /** The pinning bug: a root touched once used to stay resident forever. */
  it("reclaims a server that has gone idle even while a session still holds it", async () => {
    const pidFile = path.join(tmpDir, "server.pid");
    // Expiry is driven by passing a future `now` to sweepNow rather than by
    // sleeping past a short TTL: a background sweep racing the assertions made
    // this flaky under parallel test load.
    const idleTtlMs = 60_000;
    const idlePool = new LspClientPool({ idleTtlMs, sweepIntervalMs: 10_000 });
    const spec = fakeSpec([`--pid-file=${pidFile}`]);
    const manager = new LspManager(tmpDir, { catalog: [spec], pool: idlePool });
    managers.push(manager);

    await manager.diagnosticsAfterWrite(path.join(tmpDir, "a.fake"), "ok\n");
    const pid = Number(await waitForFile(pidFile));
    expect(idlePool.size).toBe(1);

    idlePool.sweepNow(Date.now() + idleTtlMs + 1);

    expect(idlePool.size).toBe(0);
    expect(await waitUntilDead(pid)).toBe(true);

    // ...and the session still works afterwards: the next edit rebuilds it.
    const revived = await manager.diagnosticsAfterWrite(
      path.join(tmpDir, "b.fake"),
      "has ERROR here\n",
    );
    expect(revived).toContain("Diagnostics in b.fake");
    idlePool.shutdownAll();
  }, 20_000);

  /**
   * A cached failure must not outlive the daemon's patience. Not retrying on
   * every write is deliberate, but pooling made the failure process-wide, so
   * without expiry one broken spawn would disable that root for every present
   * AND future session — where pre-pool a new session simply got a fresh
   * manager and tried again.
   */
  it("lets the idle sweep clear a cached failure so a later session can retry", async () => {
    let spawns = 0;
    // Real elapsed time rather than a synthetic future `now`: the bug is that
    // continued use refreshes a failed entry's timestamp, which only shows up
    // when the writes are actually spread across the TTL.
    const idleTtlMs = 600;
    const failPool = new LspClientPool({ idleTtlMs, sweepIntervalMs: 10_000 });
    const spec: LspServerSpec = {
      ...fakeSpec(),
      resolveCommand: () => {
        spawns++;
        return { command: process.execPath, args: [FIXTURE, "--init-error"] };
      },
    };
    const manager = new LspManager(tmpDir, {
      catalog: [spec],
      pool: failPool,
      firstBudgetMs: 3000,
      warmBudgetMs: 3000,
    });
    managers.push(manager);

    const file = path.join(tmpDir, "a.fake");
    const start = Date.now();
    expect((await manager.diagnosticsAfterWriteDetailed(file, "x\n")).kind).toBe("server_failed");

    // A second write PAST the halfway mark. This is the discriminating step: if
    // a failed retain refreshed `lastUsedAt`, continued writing would keep the
    // entry looking fresh forever and the sweep below would spare it.
    await new Promise((resolve) => setTimeout(resolve, idleTtlMs * 0.7));
    expect((await manager.diagnosticsAfterWriteDetailed(file, "y\n")).kind).toBe("server_failed");
    // Still cached: no respawn on the next write while the entry lives.
    expect(spawns).toBe(1);

    // Now past the TTL as measured from the FAILURE, not from the last write.
    await new Promise((resolve) => setTimeout(resolve, idleTtlMs * 0.5));
    failPool.sweepNow();
    expect(Date.now() - start).toBeLessThan(idleTtlMs * 2);
    expect(failPool.size).toBe(0);

    await manager.diagnosticsAfterWriteDetailed(file, "z\n");
    expect(spawns).toBe(2);
    failPool.shutdownAll();
  }, 20_000);

  /**
   * After reclamation the replacement server is genuinely cold. Treating it as
   * warm would hand it the short budget and skip the cold-load settle guard,
   * which turns tsserver's premature empty publish into a reported "clean" — a
   * false all-clear, the worst failure mode for a diagnostics tool.
   */
  it("treats a rebuilt server as cold again rather than inheriting warm state", async () => {
    const idleTtlMs = 60_000;
    const idlePool = new LspClientPool({ idleTtlMs, sweepIntervalMs: 10_000 });
    // The server needs longer than the WARM budget but less than the FIRST
    // budget, so which budget the manager picks is directly observable: a cold
    // pass returns diagnostics, a wrongly-warm one times out.
    const spec = fakeSpec(["--delay-ms=700"]);
    const manager = new LspManager(tmpDir, {
      catalog: [spec],
      pool: idlePool,
      firstBudgetMs: 5000,
      warmBudgetMs: 250,
      settleMs: 0,
    });
    managers.push(manager);

    const first = await manager.diagnosticsAfterWriteDetailed(
      path.join(tmpDir, "a.fake"),
      "has ERROR here\n",
    );
    expect(first.kind).toBe("diagnostics");
    expect(idlePool.generationFor(spec, tmpDir)).toBe(1);

    idlePool.sweepNow(Date.now() + idleTtlMs + 1);
    expect(idlePool.size).toBe(0);

    // The replacement is a new generation, so the warm mark is stale and this
    // pass must get the first-file budget again.
    const revived = await manager.diagnosticsAfterWriteDetailed(
      path.join(tmpDir, "b.fake"),
      "has ERROR here\n",
    );
    expect(idlePool.generationFor(spec, tmpDir)).toBe(2);
    expect(revived.kind).toBe("diagnostics");
    idlePool.shutdownAll();
  }, 20_000);

  it("does not reclaim a server while a diagnostics pass is still in flight", async () => {
    const idlePool = new LspClientPool({ idleTtlMs: 0, sweepIntervalMs: 10_000 });
    // Publishes only after 400ms, so the sweep below lands mid-pass.
    const spec = fakeSpec(["--delay-ms=400"]);
    const manager = new LspManager(tmpDir, {
      catalog: [spec],
      pool: idlePool,
      firstBudgetMs: 5000,
      warmBudgetMs: 5000,
    });
    managers.push(manager);

    const pending = manager.diagnosticsAfterWrite(
      path.join(tmpDir, "slow.fake"),
      "has ERROR here\n",
    );
    // Let the client spawn and the pass register before sweeping.
    await new Promise((resolve) => setTimeout(resolve, 200));
    idlePool.sweepNow();
    expect(idlePool.size).toBe(1);

    // The in-flight pass still gets its answer rather than a dead server.
    expect(await pending).toContain("Diagnostics in slow.fake");
    idlePool.shutdownAll();
  }, 20_000);

  it("releasing a holder twice does not disturb another session's server", async () => {
    const spec = fakeSpec();
    const [a, b] = twoSessions(spec);

    await a.diagnosticsAfterWrite(path.join(tmpDir, "a.fake"), "ok\n");
    await b.diagnosticsAfterWrite(path.join(tmpDir, "b.fake"), "ok\n");

    a.shutdownAll();
    a.shutdownAll();

    expect(pool.refCount(spec, tmpDir)).toBe(1);
    expect(
      await b.diagnosticsAfterWrite(path.join(tmpDir, "c.fake"), "has ERROR here\n"),
    ).toContain("Diagnostics in c.fake");
  }, 20_000);

  /**
   * Caching a start failure is the pre-existing contract (see manager.test.ts:
   * "marks a server broken after spawn failure and never retries"). Pooling must
   * not turn one broken toolchain into a fresh spawn on every write.
   */
  it("caches a start failure across BOTH sessions instead of respawning per write", async () => {
    let spawns = 0;
    const spec: LspServerSpec = {
      ...fakeSpec(["--init-error"]),
      resolveCommand: () => {
        spawns++;
        return { command: process.execPath, args: [FIXTURE, "--init-error"] };
      },
    };
    const [a, b] = twoSessions(spec);

    for (const manager of [a, b, a, b]) {
      const outcome = await manager.diagnosticsAfterWriteDetailed(
        path.join(tmpDir, "a.fake"),
        "has ERROR here\n",
      );
      expect(outcome.kind).toBe("server_failed");
    }
    expect(spawns).toBe(1);
  }, 20_000);

  it("shuts every pooled server down on pool shutdown regardless of holders", async () => {
    const pidFile = path.join(tmpDir, "server.pid");
    const spec = fakeSpec([`--pid-file=${pidFile}`]);
    const [a] = twoSessions(spec);

    await a.diagnosticsAfterWrite(path.join(tmpDir, "a.fake"), "ok\n");
    const pid = Number(await waitForFile(pidFile));

    pool.shutdownAll();

    expect(pool.size).toBe(0);
    expect(await waitUntilDead(pid)).toBe(true);
  }, 20_000);
});
