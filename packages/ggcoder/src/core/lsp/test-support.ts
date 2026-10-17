import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setEditTelemetryPathForTests } from "./edit-telemetry.js";
import { LspManager, type LspManagerOptions } from "./manager.js";
import { LspClientPool } from "./pool.js";
import type { LspServerSpec } from "./servers.js";

const fakeLspServer = fileURLToPath(
  new URL("../../tools/__fixtures__/fake-lsp-server.mjs", import.meta.url),
);

/** A `.fake`-file server spec that runs the fake LSP fixture with `args`. */
export function fakeServerSpec(id: string, args: string[]): LspServerSpec {
  return {
    id,
    extensions: [".fake"],
    rootMarkers: ["fake-root.json"],
    languageIdFor: () => "fake",
    resolveCommand: () => ({ command: process.execPath, args: [fakeLspServer, ...args] }),
  };
}

export interface ManagerHarness {
  readonly cwd: string;
  readonly pool: LspClientPool;
  /** A manager over `spec` in `cwd`, shut down by `cleanup()`. */
  manager(spec: LspServerSpec, options?: LspManagerOptions): LspManager;
  /** Shut down every manager and the pool, then remove `cwd`. */
  cleanup(): Promise<void>;
}

/**
 * A temp project (with the fake root marker), a private pool, and edit
 * telemetry redirected into it. Call from `beforeEach`; `cleanup` in `afterEach`.
 */
export async function createManagerHarness(tempPrefix: string): Promise<ManagerHarness> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), tempPrefix));
  await fs.writeFile(path.join(cwd, "fake-root.json"), "{}");
  const pool = new LspClientPool();
  setEditTelemetryPathForTests(path.join(cwd, "edit-quality.jsonl"));
  const managers: LspManager[] = [];
  return {
    cwd,
    pool,
    manager(spec, options = {}) {
      const result = new LspManager(cwd, { pool, catalog: [spec], ...options });
      managers.push(result);
      return result;
    },
    async cleanup() {
      for (const manager of managers.splice(0)) manager.shutdownAll();
      pool.shutdownAll();
      setEditTelemetryPathForTests(undefined);
      await removeWhenReleased(cwd);
    },
  };
}

/**
 * Remove a temp directory once the OS lets go of it.
 *
 * `shutdownAll()` signals a language server but does not wait for it to be
 * reaped. POSIX happily unlinks a directory a live process still holds open;
 * Windows refuses with EBUSY/EPERM until every handle is closed. A plain
 * `fs.rm` in `afterEach`/`afterAll` therefore fails LSP suites on Windows in
 * TEARDOWN, with every real assertion already passed — noise that buries the
 * failures worth reading.
 *
 * Retries briefly, then lets a genuine failure surface rather than swallowing
 * it. Test-only helper; not part of the shipped LSP surface.
 */
export async function removeWhenReleased(
  dir: string,
  { attempts = 40, delayMs = 50 } = {},
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  await fs.rm(dir, { recursive: true, force: true });
}
