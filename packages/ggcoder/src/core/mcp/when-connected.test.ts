import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MCPClientManager } from "./client.js";
import { McpCatalogCache } from "./catalog-cache.js";
import type { MCPServerConfig } from "./types.js";

let dir: string;
let manager: MCPClientManager;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-mcp-when-connected-"));
  manager = new MCPClientManager({
    catalogCache: new McpCatalogCache(path.join(dir, "mcp-catalog.json")),
  });
});

afterEach(async () => {
  await manager.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

/** A stdio command that cannot possibly start, so the connect fails fast. */
const BROKEN: MCPServerConfig = {
  name: "broken",
  command: "gg-nonexistent-mcp-binary",
  args: [],
  timeout: 2_000,
};

describe("MCPClientManager.whenConnected", () => {
  it("reports the failure reason instead of hanging when a server cannot connect", async () => {
    const waiter = manager.whenConnected("broken", 20_000);
    await manager.connectAllDetailed([BROKEN]);

    const outcome = await waiter;
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error.length > 0).toBe(true);
  }, 30_000);

  it("settles for a caller that arrives after the connect attempt finished", async () => {
    await manager.connectAllDetailed([BROKEN]);
    const outcome = await manager.whenConnected("broken", 20_000);
    expect(outcome.ok).toBe(false);
  }, 30_000);

  it("times out rather than waiting forever for a server nobody ever connects", async () => {
    const started = Date.now();
    const outcome = await manager.whenConnected("never-attempted", 150);
    expect(outcome).toEqual({ ok: false, error: "timed out after 150ms" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
