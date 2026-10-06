import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MCPClientManager } from "./client.js";
import { McpCatalogCache } from "./catalog-cache.js";
import type { MCPServerConfig } from "./types.js";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "__fixtures__",
  "legacy-mcp-server.mjs",
);

let dir: string;
let cachePath: string;
const managers: MCPClientManager[] = [];

function manager(modernProtocol: boolean): MCPClientManager {
  const instance = new MCPClientManager({
    catalogCache: new McpCatalogCache(cachePath),
    modernProtocol,
  });
  managers.push(instance);
  return instance;
}

function legacyServer(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    name: "legacy-fixture",
    command: process.execPath,
    args: [FIXTURE],
    // Bounded so a genuine hang fails the test instead of stalling the suite.
    timeout: 10_000,
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-mcp-legacy-"));
  cachePath = path.join(dir, "mcp-catalog.json");
});

afterEach(async () => {
  await Promise.all(managers.splice(0).map((instance) => instance.dispose()));
  await fs.rm(dir, { recursive: true, force: true });
});

describe("2025-only stdio server under version negotiation", () => {
  it('connects with mode "auto" by falling back to the initialize handshake', async () => {
    const config = legacyServer();
    const results = await manager(true).connectAllDetailed([config]);

    expect(results[0]?.error).toBeUndefined();
    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.tools.map((tool) => tool.name)).toEqual(["mcp__legacy-fixture__echo"]);
  }, 40_000);

  it("records the legacy era so the next connect can skip the probe", async () => {
    const config = legacyServer();
    await manager(true).connectAllDetailed([config]);

    const cache = new McpCatalogCache(cachePath);
    expect(await cache.protocolEraFor(config)).toBe("legacy");

    // Second connect supplies prior:{kind:'legacy'} and must still work.
    const second = await manager(true).connectAllDetailed([config]);
    expect(second[0]?.ok).toBe(true);
  }, 40_000);

  it("connects a server that stays silent on the discovery probe", async () => {
    const config = legacyServer({
      name: "silent-legacy-fixture",
      env: { GG_FIXTURE_SILENT_ON_UNKNOWN: "1" },
      // Generous connect budget: the point is that the PROBE does not consume
      // it. Without a stdio-specific probe timeout the probe inherits this
      // value, so a silent server would burn the full 30s before falling back.
      timeout: 30_000,
    });
    const started = Date.now();
    const results = await manager(true).connectAllDetailed([config]);
    const elapsed = Date.now() - started;

    expect(results[0]?.error).toBeUndefined();
    expect(results[0]?.ok).toBe(true);
    // Silence on a local pipe is a legacy verdict the SDK can reach in
    // seconds; anything near the 30s connect timeout means the stdio probe
    // cap regressed.
    expect(elapsed).toBeLessThan(10_000);
  }, 60_000);

  it("still connects with negotiation off (the default)", async () => {
    const results = await manager(false).connectAllDetailed([legacyServer()]);
    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.toolCount).toBe(1);
  }, 40_000);
});
