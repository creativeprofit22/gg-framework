import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { localProcessLifecycle } from "./operations.js";
import { MCPClientManager } from "../core/mcp/client.js";
import { McpCatalogCache } from "../core/mcp/catalog-cache.js";

const fake = "fake-qwen-isolation-test-only";
const probe = `JSON.stringify({ keys: Object.keys(process.env).filter(k => k.toUpperCase() === 'QWEN_CLOUD_TOKEN_PLAN_KEY'), kept: process.env.GG_ENV_SENTINEL })`;
afterEach(() => vi.unstubAllEnvs());

it.each([false, true])(
  "shared process operations strip secrets from a real child (explicit env: %s)",
  async (explicit) => {
    vi.stubEnv("QWEN_CLOUD_TOKEN_PLAN_KEY", fake);
    vi.stubEnv("GG_ENV_SENTINEL", "preserved");
    const child = localProcessLifecycle.spawn(process.execPath, ["-e", `console.log(${probe})`], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      ...(explicit
        ? {
            env: {
              ...process.env,
              qwen_cloud_token_plan_key: fake,
              Qwen_Cloud_Token_Plan_Key: fake,
            },
          }
        : {}),
    });
    let output = "";
    child.stdout!.on("data", (chunk) => {
      output += chunk;
    });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`child exit ${code}`)),
      );
    });
    expect(JSON.parse(output)).toEqual({ keys: [], kept: "preserved" });
  },
);

it("MCP transport strips inherited and explicit overrides in a real stdio server", async () => {
  vi.stubEnv("QWEN_CLOUD_TOKEN_PLAN_KEY", fake);
  const dir = await mkdtemp(path.join(os.tmpdir(), "gg-qwen-env-"));
  const manager = new MCPClientManager({
    catalogCache: new McpCatalogCache(path.join(dir, "catalog.json")),
  });
  try {
    const output = path.join(dir, "env.json");
    const fixture = path.join(dir, "server.cjs");
    await writeFile(
      fixture,
      `
      require('node:fs').writeFileSync(process.argv[2], ${probe});
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const msg = JSON.parse(line);
        if (msg.id === undefined) return;
        const result = msg.method === 'initialize'
          ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'env-fixture', version: '1' } }
          : { tools: [] };
        console.log(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      });
    `,
    );
    const results = await manager.connectAllDetailed([
      {
        name: "qwen-env-fixture",
        command: process.execPath,
        args: [fixture, output],
        timeout: 5000,
        env: {
          qwen_cloud_token_plan_key: fake,
          Qwen_Cloud_Token_Plan_Key: fake,
          GG_ENV_SENTINEL: "preserved",
        },
      },
    ]);
    expect(results[0]?.ok).toBe(true);
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({ keys: [], kept: "preserved" });
  } finally {
    await manager.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
