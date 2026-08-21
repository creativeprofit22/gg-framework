import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpCatalogCache } from "./catalog-cache.js";
import { MCPClientManager } from "./client.js";
import type { MCPServerConfig } from "./types.js";

const PROTOCOL_VERSION = "2025-11-25";
const SERVER_NAME = "identity-fixture";
const UNSAFE_TOOL_NAME = "tool:name:日本語";
const UNSAFE_TOOL_ALIAS = "mcp__id__5JclNlPTPb-Qz5uOq3yLtRrwOXYyDeCnXB1AVIHjg7k";

interface StubServer {
  url: string;
  calls: Array<{ name: string; arguments?: Record<string, unknown> }>;
  close: () => Promise<void>;
}

async function startStubServer(): Promise<StubServer> {
  const calls: StubServer["calls"] = [];
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
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }

    void readBody(req).then((raw) => {
      const message = JSON.parse(raw) as {
        id?: number | string;
        method?: string;
        params?: { name?: unknown; arguments?: unknown };
      };
      const isNotification = message.id === undefined || message.id === null;
      const sendResult = (result: unknown, headers: Record<string, string> = {}) => {
        res
          .writeHead(200, { "content-type": "application/json", ...headers })
          .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      };

      if (message.method === "initialize") {
        sendResult(
          {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: "1.0.0" },
          },
          { "mcp-session-id": "identity-session" },
        );
        return;
      }

      if (isNotification) {
        res.writeHead(202).end();
        return;
      }

      if (message.method === "ping") {
        sendResult({});
        return;
      }

      if (message.method === "tools/list") {
        sendResult({
          tools: [
            {
              name: UNSAFE_TOOL_NAME,
              description: "Unsafe source identity",
              inputSchema: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
              },
            },
            { name: "duplicate:name", description: "first", inputSchema: { type: "object" } },
            { name: "unrelated", description: "kept", inputSchema: { type: "object" } },
            { name: "duplicate:name", description: "second", inputSchema: { type: "object" } },
          ],
        });
        return;
      }

      if (message.method === "tools/call") {
        calls.push({
          name: message.params?.name as string,
          arguments: message.params?.arguments as Record<string, unknown> | undefined,
        });
        const value = (message.params?.arguments as { value?: unknown } | undefined)?.value;
        if (value === "mcp-error") {
          sendResult({ content: [{ type: "text", text: "server rejected the call" }], isError: true });
          return;
        }
        if (value === "thrown-error") {
          res.writeHead(500, { "content-type": "text/plain" }).end("backend exploded");
          return;
        }
        sendResult({ content: [{ type: "text", text: "called" }] });
        return;
      }

      res.writeHead(404).end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

let dir: string;
let stub: StubServer;
let manager: MCPClientManager;
let cache: McpCatalogCache;
let config: MCPServerConfig;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gg-mcp-tool-identity-"));
  stub = await startStubServer();
  cache = new McpCatalogCache(path.join(dir, "mcp-catalog.json"));
  manager = new MCPClientManager({ catalogCache: cache });
  config = { name: SERVER_NAME, url: stub.url, timeout: 10_000 };
});

afterEach(async () => {
  await manager.dispose();
  await stub.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("MCPClientManager tool identities", () => {
  it("dispatches an unsafe alias by its exact source name and omits duplicate declarations", async () => {
    const tools = await manager.connectAll([config]);

    expect(tools.map((tool) => tool.name)).toEqual([UNSAFE_TOOL_ALIAS, "mcp__identity-fixture__unrelated"]);
    expect(tools.every((tool) => /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(tool.name))).toBe(true);

    const args = { value: "exact argument 日本語", nested: { enabled: true } };
    await expect(
      tools[0].execute(args, {
        signal: new AbortController().signal,
        toolCallId: "identity-call",
      }),
    ).resolves.toBe("called");

    expect(stub.calls).toEqual([{ name: UNSAFE_TOOL_NAME, arguments: args }]);
    expect((await cache.entriesFor([config])).get(SERVER_NAME)?.tools).toEqual([
      expect.objectContaining({ toolName: UNSAFE_TOOL_NAME, description: "Unsafe source identity" }),
      expect.objectContaining({ toolName: "unrelated", description: "kept" }),
    ]);
  });

  it("preserves an MCP isError result as an explicit failed tool result", async () => {
    const tools = await manager.connectAll([config]);

    await expect(
      tools[1].execute(
        { value: "mcp-error" },
        { signal: new AbortController().signal, toolCallId: "mcp-error-call" },
      ),
    ).resolves.toEqual({ content: "server rejected the call", isError: true });
  });

  it("throws a transport or protocol failure instead of returning successful error text", async () => {
    const tools = await manager.connectAll([config]);

    await expect(
      tools[1].execute(
        { value: "thrown-error" },
        { signal: new AbortController().signal, toolCallId: "thrown-error-call" },
      ),
    ).rejects.toThrow("MCP tool error: Error POSTing to endpoint: backend exploded");
  });
});
