import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ElicitResult } from "@modelcontextprotocol/client";
import type { AgentTool, ToolContext } from "@kenkaiiii/gg-agent";
import { MCPClientManager, type MCPElicitHandler } from "./client.js";
import { createElicitationBridge, type ElicitationPrompt } from "./elicitation-bridge.js";
import { McpCatalogCache } from "./catalog-cache.js";
import type { MCPServerConfig } from "./types.js";

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "__fixtures__",
  "elicit-mcp-server.mjs",
);

let dir: string;
const managers: MCPClientManager[] = [];

function manager(onElicit?: MCPElicitHandler): MCPClientManager {
  const instance = new MCPClientManager({
    catalogCache: new McpCatalogCache(path.join(dir, "mcp-catalog.json")),
    onElicit,
  });
  managers.push(instance);
  return instance;
}

function config(): MCPServerConfig {
  return {
    name: "elicit-fixture",
    command: process.execPath,
    args: [FIXTURE],
    timeout: 10_000,
  };
}

function toolContext(signal?: AbortSignal): ToolContext {
  return { signal: signal ?? new AbortController().signal, toolCallId: "call-1" };
}

async function callTool(tools: AgentTool[], suffix: string): Promise<string> {
  const tool = tools.find((t) => t.name === `mcp__elicit-fixture__${suffix}`);
  if (!tool) throw new Error(`missing tool ${suffix}: ${tools.map((t) => t.name).join(", ")}`);
  const result = await tool.execute({}, toolContext());
  return typeof result === "string" ? result : JSON.stringify(result);
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-mcp-elicit-"));
});

afterEach(async () => {
  await Promise.all(managers.splice(0).map((instance) => instance.dispose()));
  await fs.rm(dir, { recursive: true, force: true });
});

describe("MCP elicitation capability", () => {
  it("declares form-mode elicitation when a handler is supplied", async () => {
    const tools = await manager(async () => ({ action: "cancel" })).connectAll([config()]);
    const declared = JSON.parse(await callTool(tools, "client_capabilities"));
    expect(declared.elicitation).toEqual({ form: {} });
  }, 30_000);

  it("declares no elicitation capability without a handler", async () => {
    const tools = await manager().connectAll([config()]);
    const declared = JSON.parse(await callTool(tools, "client_capabilities"));
    expect(declared.elicitation).toBeUndefined();
  }, 30_000);
});

describe("MCP elicitation round-trip", () => {
  it("returns accepted content to the server", async () => {
    let seen: { server: string; message: string } | undefined;
    const tools = await manager(async (request) => {
      seen = { server: request.server, message: request.message };
      // The schema the fixture asked for, filled in.
      expect(Object.keys(request.requestedSchema.properties as object)).toEqual([
        "name",
        "count",
        "confirm",
      ]);
      return { action: "accept", content: { name: "Ken", count: 3, confirm: true } };
    }).connectAll([config()]);

    expect(JSON.parse(await callTool(tools, "ask"))).toEqual({
      action: "accept",
      content: { name: "Ken", count: 3, confirm: true },
    });
    expect(seen).toEqual({ server: "elicit-fixture", message: "The server needs some details" });
  }, 30_000);

  for (const action of ["decline", "cancel"] as const) {
    it(`passes a ${action} through with no content`, async () => {
      const tools = await manager(async () => ({ action })).connectAll([config()]);
      expect(JSON.parse(await callTool(tools, "ask"))).toEqual({ action });
    }, 30_000);
  }
});

describe("elicitation bridge", () => {
  function bridge(timeoutMs?: number): {
    prompts: ElicitationPrompt[];
    instance: ReturnType<typeof createElicitationBridge>;
  } {
    const prompts: ElicitationPrompt[] = [];
    const instance = createElicitationBridge({
      broadcast: (prompt) => prompts.push(prompt),
      timeoutMs,
    });
    return { prompts, instance };
  }

  const request = (server: string) => ({
    server,
    message: "please confirm",
    requestedSchema: { type: "object", properties: {} },
  });

  it("parks a request until the host answers it", async () => {
    const { prompts, instance } = bridge();
    const pending = instance.onElicit(request("alpha"));
    expect(prompts).toHaveLength(1);
    expect(instance.pendingCount).toBe(1);

    const answer: ElicitResult = { action: "accept", content: { ok: true } };
    expect(instance.settle(prompts[0]!.id, answer)).toBe(true);
    await expect(pending).resolves.toEqual(answer);
    expect(instance.pendingCount).toBe(0);
  });

  it("keys requests separately so two servers can ask at once", async () => {
    const { prompts, instance } = bridge();
    const first = instance.onElicit(request("alpha"));
    const second = instance.onElicit(request("beta"));
    expect(prompts.map((p) => p.server)).toEqual(["alpha", "beta"]);
    expect(new Set(prompts.map((p) => p.id)).size).toBe(2);

    instance.settle(prompts[1]!.id, { action: "decline" });
    await expect(second).resolves.toEqual({ action: "decline" });
    expect(instance.pendingCount).toBe(1);

    instance.settle(prompts[0]!.id, { action: "accept", content: {} });
    await expect(first).resolves.toEqual({ action: "accept", content: {} });
  });

  it("cancels every parked request on abort or teardown", async () => {
    const { instance } = bridge();
    const first = instance.onElicit(request("alpha"));
    const second = instance.onElicit(request("beta"));

    instance.cancelAll();

    await expect(first).resolves.toEqual({ action: "cancel" });
    await expect(second).resolves.toEqual({ action: "cancel" });
    expect(instance.pendingCount).toBe(0);
  });

  it("rejects an answer for an unknown or already-settled id", () => {
    const { prompts, instance } = bridge();
    void instance.onElicit(request("alpha"));
    expect(instance.settle("elicit-999", { action: "cancel" })).toBe(false);
    expect(instance.settle(prompts[0]!.id, { action: "cancel" })).toBe(true);
    // Second answer for the same id: the tool call has already moved on.
    expect(instance.settle(prompts[0]!.id, { action: "accept", content: {} })).toBe(false);
  });

  it("auto-cancels rather than hanging the turn forever", async () => {
    const { instance } = bridge(20);
    await expect(instance.onElicit(request("alpha"))).resolves.toEqual({ action: "cancel" });
    expect(instance.pendingCount).toBe(0);
  });
});

describe("MCP elicitation under a run abort", () => {
  it("unblocks the tool call when the bridge cancels mid-flight", async () => {
    const prompts: ElicitationPrompt[] = [];
    const elicitations = createElicitationBridge({
      broadcast: (prompt) => {
        prompts.push(prompt);
        // The host's abort path fires while the server is still waiting.
        queueMicrotask(() => elicitations.cancelAll());
      },
    });

    const tools = await manager(elicitations.onElicit).connectAll([config()]);
    expect(JSON.parse(await callTool(tools, "ask"))).toEqual({ action: "cancel" });
    expect(prompts).toHaveLength(1);
    expect(elicitations.pendingCount).toBe(0);
  }, 30_000);
});
