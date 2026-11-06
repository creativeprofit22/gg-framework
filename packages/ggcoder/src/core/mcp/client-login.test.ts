import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MCPClientManager } from "./client.js";

interface StubServer {
  url: string;
  close: () => Promise<void>;
}

async function startAuthorizedStubServer(): Promise<StubServer> {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(200).end();
      return;
    }

    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const message = JSON.parse(raw) as { id?: number | string; method?: string };
      const sendResult = (result: unknown, headers: Record<string, string> = {}): void => {
        res
          .writeHead(200, { "content-type": "application/json", ...headers })
          .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      };

      if (message.method === "initialize") {
        sendResult(
          {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "oauth-count-fixture", version: "1.0.0" },
          },
          { "mcp-session-id": "oauth-count-session" },
        );
        return;
      }

      if (message.id === undefined || message.id === null) {
        res.writeHead(202).end();
        return;
      }

      if (message.method === "tools/list") {
        sendResult({
          tools: [
            { name: "duplicate", description: "first", inputSchema: { type: "object" } },
            { name: "unrelated", description: "usable", inputSchema: { type: "object" } },
            { name: "duplicate", description: "second", inputSchema: { type: "object" } },
          ],
        });
        return;
      }

      res.writeHead(404).end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

const managers: MCPClientManager[] = [];
const stubs: StubServer[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  await Promise.all(stubs.splice(0).map((stub) => stub.close()));
});

describe("MCPClientManager.login", () => {
  it("reports only usable tools when OAuth verification lists duplicate names", async () => {
    const stub = await startAuthorizedStubServer();
    stubs.push(stub);
    const manager = new MCPClientManager();
    managers.push(manager);

    const result = await manager.login(
      { name: "oauth-count-fixture", url: stub.url, timeout: 10_000 },
      () => {
        throw new Error("an already-authorized server must not request browser authorization");
      },
      10_000,
    );

    expect(result).toEqual({ ok: true, toolCount: 1 });
  });
});
