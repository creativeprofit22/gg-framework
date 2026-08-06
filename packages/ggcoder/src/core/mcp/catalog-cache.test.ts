import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpCatalogCache, hashServerConfig } from "./catalog-cache.js";
import type { MCPServerConfig } from "./types.js";

let dir: string;
let file: string;

const server: MCPServerConfig = {
  name: "kencode-search",
  command: "node",
  args: ["server.js"],
};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-mcp-catalog-"));
  file = path.join(dir, "mcp-catalog.json");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("hashServerConfig", () => {
  it("is stable across key and header ordering", () => {
    const a: MCPServerConfig = { name: "x", url: "https://x", headers: { a: "1", b: "2" } };
    const b: MCPServerConfig = { name: "x", headers: { b: "2", a: "1" }, url: "https://x" };
    expect(hashServerConfig(a)).toBe(hashServerConfig(b));
  });

  it("changes when the command or args change", () => {
    expect(hashServerConfig(server)).not.toBe(hashServerConfig({ ...server, args: ["other.js"] }));
    expect(hashServerConfig(server)).not.toBe(hashServerConfig({ ...server, command: "bun" }));
  });

  it("ignores the fields that cannot change the exposed tools", () => {
    expect(hashServerConfig(server)).toBe(
      hashServerConfig({ ...server, enabled: false, timeout: 999 }),
    );
  });
});

describe("McpCatalogCache", () => {
  it("round-trips tools and the negotiated protocol era", async () => {
    const cache = new McpCatalogCache(file);
    await cache.save(
      server,
      [{ name: "mcp__kencode-search__search", description: "search code", rawInputSchema: {} }],
      "legacy",
    );

    const entries = await new McpCatalogCache(file).entriesFor([server]);
    expect(entries.get(server.name)?.tools).toEqual([
      { name: "mcp__kencode-search__search", description: "search code", rawInputSchema: {} },
    ]);
    expect(await cache.protocolEraFor(server)).toBe("legacy");
  });

  it("invalidates an entry when the server config changes", async () => {
    const cache = new McpCatalogCache(file);
    await cache.save(server, [{ name: "mcp__kencode-search__search", description: "x" }]);

    const changed = { ...server, args: ["different.js"] };
    expect((await cache.entriesFor([changed])).size).toBe(0);
    expect((await cache.entriesFor([server])).size).toBe(1);
  });

  it("ignores servers that were never cached", async () => {
    const cache = new McpCatalogCache(file);
    await cache.save(server, [{ name: "mcp__kencode-search__search", description: "x" }]);
    expect((await cache.entriesFor([{ name: "other", command: "node" }])).size).toBe(0);
  });

  it("treats a malformed cache file as empty instead of throwing", async () => {
    await fs.writeFile(file, "{ not json", "utf-8");
    const cache = new McpCatalogCache(file);
    expect((await cache.entriesFor([server])).size).toBe(0);

    // And it recovers by overwriting.
    await cache.save(server, [{ name: "mcp__kencode-search__search", description: "x" }]);
    expect((await cache.entriesFor([server])).size).toBe(1);
  });

  it("drops entries with an invalid shape but keeps the valid ones", async () => {
    const other: MCPServerConfig = { name: "other", command: "node", args: ["o.js"] };
    await new McpCatalogCache(file).save(other, [{ name: "mcp__other__a", description: "a" }]);
    const raw = JSON.parse(await fs.readFile(file, "utf-8")) as {
      servers: Record<string, unknown>;
    };
    raw.servers[server.name] = { configHash: 42, tools: "nope" };
    await fs.writeFile(file, JSON.stringify(raw), "utf-8");

    const entries = await new McpCatalogCache(file).entriesFor([server, other]);
    expect(entries.has(server.name)).toBe(false);
    expect(entries.get(other.name)?.tools).toHaveLength(1);
  });

  it("ignores entries that have aged out", async () => {
    const cache = new McpCatalogCache(file);
    await cache.save(server, [{ name: "mcp__kencode-search__search", description: "x" }]);
    const raw = JSON.parse(await fs.readFile(file, "utf-8")) as {
      servers: Record<string, { savedAt: number }>;
    };
    raw.servers[server.name].savedAt = Date.now() - 400 * 24 * 60 * 60 * 1000;
    await fs.writeFile(file, JSON.stringify(raw), "utf-8");

    expect((await cache.entriesFor([server])).size).toBe(0);
  });

  it("does not lose a concurrent save from another server", async () => {
    const cache = new McpCatalogCache(file);
    const other: MCPServerConfig = { name: "other", command: "node", args: ["o.js"] };
    await Promise.all([
      cache.save(server, [{ name: "mcp__kencode-search__search", description: "x" }]),
      cache.save(other, [{ name: "mcp__other__a", description: "a" }]),
    ]);
    const entries = await cache.entriesFor([server, other]);
    expect([...entries.keys()].sort()).toEqual(["kencode-search", "other"]);
  });

  it("clears a server's entry", async () => {
    const cache = new McpCatalogCache(file);
    await cache.save(server, [{ name: "mcp__kencode-search__search", description: "x" }]);
    await cache.clear(server.name);
    expect((await cache.entriesFor([server])).size).toBe(0);
  });
});
