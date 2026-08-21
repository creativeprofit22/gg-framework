import { afterEach, describe, expect, it } from "vitest";
import { startDesktopMcpAcceptanceFixture } from "./desktop-mcp-acceptance-fixture.mjs";

let fixture;
afterEach(async () => fixture?.close());

async function rpc(method, params, sessionId) {
  const response = await fetch(`${fixture.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { response, body: await response.json() };
}

describe("desktop MCP acceptance fixture", () => {
  it("lists, invokes, reports isError, and deterministically expires sessions", async () => {
    fixture = await startDesktopMcpAcceptanceFixture();
    const initialized = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
    const sessionId = initialized.response.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const listed = await rpc("tools/list", {}, sessionId);
    expect(listed.body.result.tools.map((tool) => tool.name)).toEqual(["echo", "fail"]);
    const echoed = await rpc("tools/call", { name: "echo", arguments: { text: "ok" } }, sessionId);
    expect(echoed.body.result.content[0].text).toBe("fixture-echo:ok");
    const failed = await rpc("tools/call", { name: "fail", arguments: {} }, sessionId);
    expect(failed.body.result).toMatchObject({ isError: true, content: [{ text: "fixture-is-error" }] });

    await fetch(`${fixture.url}/control/expire`, { method: "POST" });
    const expired = await rpc("tools/list", {}, sessionId);
    expect(expired.response.status).toBe(404);
  });
});
