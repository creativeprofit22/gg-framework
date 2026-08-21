import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentTool, ToolContext } from "@kenkaiiii/gg-agent";
import {
  MCPClientManager,
  type MCPServerStateChange,
} from "./client.js";
import { McpCatalogCache } from "./catalog-cache.js";
import type { MCPServerConfig } from "./types.js";

const PROTOCOL_VERSION = "2025-11-25";

/**
 * A minimal Streamable-HTTP MCP server with controllable session lifetime.
 *
 * Real remote servers drop sessions on restart or idle sweep, after which every
 * request carrying the stale `Mcp-Session-Id` gets a bare HTTP 404 — the exact
 * failure the SDK has no recovery for. `expireAll()` reproduces it on demand.
 */
interface StubServer {
  url: string;
  /** How many `initialize` handshakes the server has seen. One per connection. */
  initializeCount: number;
  /** Number of requests currently parked by `holdExpired`. */
  heldCount: number;
  /** Invalidate every issued session; later requests bearing one get a 404. */
  expireAll: () => void;
  /** Park expired-session requests instead of answering, so they overlap. */
  holdExpired: (hold: boolean) => void;
  /** Answer every parked request with its 404. */
  releaseHeld: () => void;
  /** 404 all tool traffic regardless of session — the server can never recover. */
  breakToolTraffic: (broken: boolean) => void;
  setTools: (tools: Array<{ name: string; description?: string }>) => void;
  close: () => Promise<void>;
}

async function startStubServer(): Promise<StubServer> {
  const validSessions = new Set<string>();
  let generation = 0;
  let holding = false;
  let toolTrafficBroken = false;
  let listedTools: Array<{ name: string; description?: string }> = [
    { name: "echo", description: "Echo the provided text back to the caller" },
  ];
  const held: Array<() => void> = [];

  const state = {
    initializeCount: 0,
    get heldCount() {
      return held.length;
    },
  };

  const readBody = (req: http.IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => resolve(raw));
      req.on("error", reject);
    });

  const server = http.createServer((req, res) => {
    // The SDK opens a standalone GET for server→client streaming and DELETEs on
    // teardown. 405 is the spec's "not offered", which it handles cleanly.
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }

    void readBody(req).then((raw) => {
      let message: { id?: number | string; method?: string; params?: unknown };
      try {
        message = JSON.parse(raw);
      } catch {
        res.writeHead(400).end();
        return;
      }

      const isNotification = message.id === undefined || message.id === null;
      const sendResult = (result: unknown, headers: Record<string, string> = {}) => {
        const body = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
        res.writeHead(200, { "content-type": "application/json", ...headers }).end(body);
      };

      if (message.method === "initialize") {
        state.initializeCount += 1;
        const sessionId = `session-${++generation}`;
        validSessions.add(sessionId);
        sendResult(
          {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "session-fixture", version: "1.0.0" },
          },
          { "mcp-session-id": sessionId },
        );
        return;
      }

      const sessionId = req.headers["mcp-session-id"];
      const isToolTraffic = message.method === "tools/list" || message.method === "tools/call";
      const expired =
        (typeof sessionId === "string" && !validSessions.has(sessionId)) ||
        (toolTrafficBroken && isToolTraffic);
      if (expired) {
        const reply = () => {
          res.writeHead(404, { "content-type": "text/plain" }).end("Session not found");
        };
        if (holding) held.push(reply);
        else reply();
        return;
      }

      if (isNotification) {
        res.writeHead(202).end();
        return;
      }

      switch (message.method) {
        case "ping":
          sendResult({});
          return;
        case "tools/list":
          sendResult({
            tools: listedTools.map((tool) => ({
              ...tool,
              inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
              },
            })),
          });
          return;
        case "tools/call": {
          const args = (message.params as { arguments?: { text?: unknown } } | undefined)
            ?.arguments;
          sendResult({ content: [{ type: "text", text: String(args?.text ?? "") }] });
          return;
        }
        default:
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32601, message: `Method not found: ${message.method}` },
            }),
          );
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    get initializeCount() {
      return state.initializeCount;
    },
    get heldCount() {
      return held.length;
    },
    expireAll: () => validSessions.clear(),
    holdExpired: (hold: boolean) => {
      holding = hold;
    },
    releaseHeld: () => {
      holding = false;
      while (held.length > 0) held.shift()?.();
    },
    breakToolTraffic: (broken: boolean) => {
      toolTrafficBroken = broken;
    },
    setTools: (tools) => {
      listedTools = tools;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function toolContext(signal?: AbortSignal): ToolContext {
  return { signal: signal ?? new AbortController().signal, toolCallId: "call-1" };
}

async function runTool(tool: AgentTool, text: string, signal?: AbortSignal): Promise<string> {
  const result = await tool.execute({ text }, toolContext(signal));
  return typeof result === "string" ? result : JSON.stringify(result);
}

let dir: string;
let stub: StubServer;
const managers: MCPClientManager[] = [];

function manager(onServerStateChange?: (change: MCPServerStateChange) => void): MCPClientManager {
  const instance = new MCPClientManager({
    catalogCache: new McpCatalogCache(path.join(dir, "mcp-catalog.json")),
    onServerStateChange,
  });
  managers.push(instance);
  return instance;
}

function httpConfig(): MCPServerConfig {
  return { name: "session-fixture", url: stub.url, timeout: 10_000 };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-mcp-session-"));
  stub = await startStubServer();
});

afterEach(async () => {
  await Promise.all(managers.splice(0).map((instance) => instance.dispose()));
  await stub.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("MCP disconnect and HTTP recovery lifecycle", () => {
  it("removes idle-disconnected tools before starting HTTP recovery", async () => {
    const changes: MCPServerStateChange[] = [];
    const mcp = manager((change) => changes.push(change));
    const [stale] = await mcp.connectAll([httpConfig()]);
    changes.length = 0;

    const connected = (mcp as unknown as {
      servers: Array<{ client: { onclose?: () => void } }>;
    }).servers[0];
    connected.client.onclose?.();

    expect(changes.slice(0, 2).map((change) => change.status)).toEqual([
      "disconnected",
      "recovering",
    ]);
    await expect(runTool(stale, "idle-stale")).rejects.toThrow(/stale tool wrapper/);
    await waitFor(() => changes.some((change) => change.status === "connected"), 10_000);
    expect(stub.initializeCount).toBe(2);
  });

  it("rejects an active call on disconnect and recovers without replaying it", async () => {
    const changes: MCPServerStateChange[] = [];
    const mcp = manager((change) => changes.push(change));
    const [stale] = await mcp.connectAll([httpConfig()]);
    changes.length = 0;
    stub.expireAll();

    await expect(runTool(stale, "must-not-replay")).rejects.toThrow(/MCP tool error.*Session not found/);
    expect(changes.slice(0, 2).map((change) => change.status)).toEqual([
      "disconnected",
      "recovering",
    ]);
    await waitFor(() => changes.some((change) => change.status === "connected"), 10_000);
    expect(stub.initializeCount).toBe(2);
  }, 20_000);

  it("rejects a captured wrapper after successful recovery and publishes a fresh one", async () => {
    const changes: MCPServerStateChange[] = [];
    const mcp = manager((change) => changes.push(change));
    const [stale] = await mcp.connectAll([httpConfig()]);
    changes.length = 0;
    stub.expireAll();

    await expect(runTool(stale, "trigger")).rejects.toThrow(/Session not found/);
    await waitFor(() => changes.some((change) => change.status === "connected"), 10_000);
    const fresh = [...changes].reverse().find((change) => change.status === "connected")!.tools[0];

    await expect(runTool(stale, "stale")).rejects.toThrow(/stale tool wrapper/);
    expect(await runTool(fresh, "fresh")).toBe("fresh");
  }, 20_000);

  it("stays disconnected when HTTP recovery fails", async () => {
    const changes: MCPServerStateChange[] = [];
    const mcp = manager((change) => changes.push(change));
    const [tool] = await mcp.connectAll([httpConfig()]);
    changes.length = 0;
    stub.breakToolTraffic(true);

    await expect(runTool(tool, "doomed")).rejects.toThrow(/MCP tool error.*Session not found/);
    await waitFor(
      () => changes.at(-1)?.status === "disconnected" && Boolean(changes.at(-1)?.error),
      10_000,
    );
    expect(changes.map((change) => change.status)).toContain("recovering");
    expect(changes.at(-1)?.tools).toEqual([]);
    await expect(runTool(tool, "still-stale")).rejects.toThrow(/stale tool wrapper/);
  }, 20_000);

  it("reapplies identity and exact-name duplicate filtering after reconnect", async () => {
    const changes: MCPServerStateChange[] = [];
    const mcp = manager((change) => changes.push(change));
    const [tool] = await mcp.connectAll([httpConfig()]);
    changes.length = 0;
    stub.setTools([
      { name: "echo", description: "first exact duplicate wins" },
      { name: "echo", description: "must be omitted" },
      { name: "", description: "invalid identity must be omitted" },
      { name: "fresh", description: "new valid tool" },
    ]);
    stub.expireAll();

    await expect(runTool(tool, "trigger")).rejects.toThrow(/Session not found/);
    await waitFor(() => changes.some((change) => change.status === "connected"), 10_000);
    const published = [...changes].reverse().find((change) => change.status === "connected")!.tools;

    expect(published.map((candidate) => candidate.name)).toEqual([
      "mcp__session-fixture__fresh",
    ]);
    expect(published[0].description).toBe("new valid tool");
  }, 20_000);
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}
