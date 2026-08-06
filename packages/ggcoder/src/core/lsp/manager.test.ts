import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import { removeWhenReleased } from "./test-support.js";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { LspManager } from "./manager.js";
import type { LspServerSpec } from "./servers.js";

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../tools/__fixtures__/fake-lsp-server.mjs",
);

function fakeSpec(serverArgs: string[] = [], overrides?: Partial<LspServerSpec>): LspServerSpec {
  return {
    id: "fake",
    extensions: [".fake"],
    rootMarkers: ["fake-root.json"],
    languageIdFor: () => "fake",
    resolveCommand: () => ({ command: process.execPath, args: [FIXTURE, ...serverArgs] }),
    ...overrides,
  };
}

describe("LspManager", () => {
  let tmpDir: string;
  let managers: LspManager[];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-manager-test-"));
    await fs.writeFile(path.join(tmpDir, "fake-root.json"), "{}");
    managers = [];
  });

  afterEach(async () => {
    for (const manager of managers) manager.shutdownAll();
    await removeWhenReleased(tmpDir);
  });

  function makeManager(
    spec: LspServerSpec,
    budgets?: { warm?: number; first?: number },
  ): LspManager {
    const manager = new LspManager(tmpDir, {
      catalog: [spec],
      warmBudgetMs: budgets?.warm ?? 5000,
      firstBudgetMs: budgets?.first ?? 5000,
    });
    managers.push(manager);
    return manager;
  }

  it("returns formatted diagnostics for broken content", async () => {
    const manager = makeManager(fakeSpec());
    const filePath = path.join(tmpDir, "broken.fake");

    const result = await manager.diagnosticsAfterWrite(filePath, "ok line\nhas ERROR here\n");

    expect(result).toContain("Diagnostics in broken.fake");
    expect(result).toContain("L2:5 fake error on line 2 (fake)");
    expect(manager.getLatestOutcome(filePath)).toMatchObject({
      kind: "diagnostics",
      filePath: path.resolve(filePath),
    });
  });

  it("returns empty string once a follow-up edit fixes the file", async () => {
    const manager = makeManager(fakeSpec());
    const filePath = path.join(tmpDir, "cycle.fake");

    const broken = await manager.diagnosticsAfterWrite(filePath, "ERROR\n");
    expect(broken).toContain("fake error on line 1");

    const fixed = await manager.diagnosticsAfterWrite(filePath, "all good\n");
    expect(fixed).toBe("");

    const rebroken = await manager.diagnosticsAfterWrite(filePath, "fine\nERROR again\n");
    expect(rebroken).toContain("fake error on line 2");
  });

  it("records a high-confidence clean outcome", async () => {
    const manager = makeManager(fakeSpec());
    const filePath = path.join(tmpDir, "clean.fake");
    const outcome = await manager.diagnosticsAfterWriteDetailed(filePath, "all good\n");
    expect(outcome).toMatchObject({ kind: "clean", filePath: path.resolve(filePath) });
  });

  it("records low confidence for an empty result while indexing is active", async () => {
    const manager = makeManager(fakeSpec(["--progress"]));
    const filePath = path.join(tmpDir, "indexing.fake");
    const outcome = await manager.diagnosticsAfterWriteDetailed(filePath, "all good\n");
    expect(outcome.kind).toBe("low_confidence");
    expect(await manager.diagnosticsAfterWrite(filePath, "still good\n")).toBe("");
  });

  it("keeps found errors high confidence while indexing is active", async () => {
    const manager = makeManager(fakeSpec(["--progress"]));
    const filePath = path.join(tmpDir, "indexing-error.fake");
    const outcome = await manager.diagnosticsAfterWriteDetailed(filePath, "ERROR\n");
    expect(outcome.kind).toBe("diagnostics");
  });

  it("records clean after indexing progress ends", async () => {
    const manager = makeManager(fakeSpec(["--progress-end"]));
    const outcome = await manager.diagnosticsAfterWriteDetailed(
      path.join(tmpDir, "indexed.fake"),
      "all good\n",
    );
    expect(outcome.kind).toBe("clean");
  });

  // Regression guard for the Windows CI failure in `windows.test.ts`: on a cold
  // project load tsserver ends its load progress and publishes an EMPTY set for
  // the open file BEFORE type-checking it, then publishes the real diagnostics.
  // Taking that first publish at face value reported a broken file as clean, so
  // inline diagnostics silently did nothing on the first edit in a project.
  it("does not report clean on a server's premature empty publish during cold load", async () => {
    const manager = makeManager(fakeSpec(["--premature-empty"]));
    const outcome = await manager.diagnosticsAfterWriteDetailed(
      path.join(tmpDir, "premature.fake"),
      "ERROR\n",
    );
    expect(outcome.kind).toBe("diagnostics");
  });

  // The settle window must not turn a genuinely clean cold file into a stall or
  // a wrong verdict: no follow-up publish ever arrives here, so it still has to
  // land on `clean`.
  it("still reports clean when the follow-up publish never comes", async () => {
    const manager = makeManager(fakeSpec(["--progress-end"]));
    const outcome = await manager.diagnosticsAfterWriteDetailed(
      path.join(tmpDir, "cold-clean.fake"),
      "all good\n",
    );
    expect(outcome.kind).toBe("clean");
  });

  it("works with pull-diagnostics servers", async () => {
    const manager = makeManager(fakeSpec(["--pull"]));
    const filePath = path.join(tmpDir, "pull.fake");

    const result = await manager.diagnosticsAfterWrite(filePath, "ERROR\n");

    expect(result).toContain("fake error on line 1");
  });

  it("returns empty string and records unsupported extensions without spawning", async () => {
    const manager = makeManager(fakeSpec());
    const filePath = path.join(tmpDir, "readme.md");

    const result = await manager.diagnosticsAfterWrite(filePath, "# hi");

    expect(result).toBe("");
    expect(manager.getLatestOutcome(filePath)?.kind).toBe("unsupported");
  });

  it("returns empty string when the time budget is exceeded", async () => {
    const manager = makeManager(fakeSpec(["--delay-ms=2000"]), { warm: 300, first: 300 });
    const filePath = path.join(tmpDir, "slow.fake");

    const started = Date.now();
    const result = await manager.diagnosticsAfterWrite(filePath, "ERROR\n");

    expect(result).toBe("");
    expect(Date.now() - started).toBeLessThan(1500);
    expect(manager.getLatestOutcome(filePath)?.kind).toBe("timeout");
  });

  it("marks a server broken after spawn failure and never retries", async () => {
    let resolveCalls = 0;
    const spec = fakeSpec([], {
      resolveCommand: () => {
        resolveCalls++;
        return { command: path.join(tmpDir, "does-not-exist-binary"), args: [] };
      },
    });
    const manager = makeManager(spec);
    const filePath = path.join(tmpDir, "broken-server.fake");

    expect(await manager.diagnosticsAfterWrite(filePath, "ERROR\n")).toBe("");
    expect(await manager.diagnosticsAfterWrite(filePath, "ERROR\n")).toBe("");
    expect(resolveCalls).toBe(1);
  });

  it("returns empty string and records unavailable when no server command resolves", async () => {
    const spec = fakeSpec([], { resolveCommand: () => null });
    const manager = makeManager(spec);
    const filePath = path.join(tmpDir, "a.fake");

    const result = await manager.diagnosticsAfterWrite(filePath, "ERROR\n");

    expect(result).toBe("");
    expect(manager.getLatestOutcome(filePath)?.kind).toBe("unavailable");
  });

  it("records initialization failure separately", async () => {
    const manager = makeManager(fakeSpec(["--init-error"]));
    const outcome = await manager.diagnosticsAfterWriteDetailed(
      path.join(tmpDir, "init-failed.fake"),
      "ERROR\n",
    );
    expect(outcome.kind).toBe("server_failed");
  });

  it("kills a server that fails to initialize instead of leaking it", async () => {
    // `new LspClient` SPAWNS the process, so an initialize that rejects used to
    // drop the only reference to a LIVE server: one orphan per (server, root)
    // for the whole session. Invisible on POSIX; on Windows the orphan holds
    // handles in the project directory, which is how it surfaced — as an EBUSY
    // rmdir in this suite's teardown, long after the assertions had passed.
    const pidFile = path.join(tmpDir, "server.pid");
    const manager = makeManager(fakeSpec(["--init-error", `--pid-file=${pidFile}`]));

    const outcome = await manager.diagnosticsAfterWriteDetailed(
      path.join(tmpDir, "init-failed.fake"),
      "ERROR\n",
    );
    expect(outcome.kind).toBe("server_failed");

    const pid = Number(await fs.readFile(pidFile, "utf-8"));
    expect(Number.isInteger(pid)).toBe(true);

    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    // Termination is asynchronous (taskkill on Windows); give it a moment.
    for (let attempt = 0; attempt < 50 && alive(); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (alive()) {
      process.kill(pid, "SIGKILL"); // never leak a live process out of the suite
      throw new Error(`language server ${pid} survived a failed initialize`);
    }
  }, 30_000);

  it("records a post-initialization server crash", async () => {
    const manager = makeManager(fakeSpec(["--crash-on-open"]));
    const outcome = await manager.diagnosticsAfterWriteDetailed(
      path.join(tmpDir, "crashed.fake"),
      "ERROR\n",
    );
    expect(outcome.kind).toBe("server_failed");
  });

  it("bounds latest per-file outcomes", async () => {
    const manager = new LspManager(tmpDir, { catalog: [fakeSpec()], snapshotLimit: 2 });
    managers.push(manager);
    for (const name of ["one.md", "two.md", "three.md"]) {
      await manager.diagnosticsAfterWriteDetailed(path.join(tmpDir, name), "safe");
    }
    expect(manager.getLatestOutcomes()).toHaveLength(2);
    expect(manager.getLatestOutcome(path.join(tmpDir, "one.md"))).toBeUndefined();
  });

  it("performs the shutdown handshake on shutdownAll", async () => {
    const shutdownFile = path.join(tmpDir, "shutdown-marker");
    const manager = makeManager(fakeSpec([`--shutdown-file=${shutdownFile}`]));
    const filePath = path.join(tmpDir, "bye.fake");

    await manager.diagnosticsAfterWrite(filePath, "ok\n");
    manager.shutdownAll();

    // Poll for the marker the fixture writes when it receives `shutdown`.
    const deadline = Date.now() + 3000;
    let seen = false;
    while (Date.now() < deadline && !seen) {
      seen = await fs.access(shutdownFile).then(
        () => true,
        () => false,
      );
      if (!seen) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(seen).toBe(true);
  });

  it("returns empty string after shutdownAll", async () => {
    const manager = makeManager(fakeSpec());
    manager.shutdownAll();

    const result = await manager.diagnosticsAfterWrite(path.join(tmpDir, "a.fake"), "ERROR\n");

    expect(result).toBe("");
  });
});
