import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { pathToFileURL } from "node:url";

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function sendSse(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function startDesktopMcpAcceptanceFixture({ port = 0, tls } = {}) {
  let nextSession = 1;
  let nextCall = 1;
  let sessions = new Set();
  const records = [];
  const record = (entry) => {
    const value = { at: new Date().toISOString(), ...entry };
    records.push(value);
  };

  const handleRequest = async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "POST" && url.pathname === "/control/expire") {
        sessions = new Set();
        record({ kind: "control", action: "expire" });
        return sendJson(res, 200, { expired: true });
      }
      if (req.method === "GET" && url.pathname === "/control/state") {
        return sendJson(res, 200, { records, activeSessions: sessions.size });
      }
      if (req.method === "POST" && url.pathname === "/openai/v1/responses") {
        const body = await readJson(req);
        record({ kind: "provider", body });
        const inputItems = Array.isArray(body.input) ? body.input : [];
        const lastUserIndex = inputItems.findLastIndex(
          (item) => item && typeof item === "object" && item.role === "user",
        );
        const currentInput = inputItems.slice(Math.max(0, lastUserIndex));
        const prompt = JSON.stringify(inputItems[lastUserIndex] ?? {});
        const functionCalls = currentInput.filter(
          (item) => item && typeof item === "object" && item.type === "function_call",
        );
        const outputs = currentInput.filter(
          (item) => item && typeof item === "object" && item.type === "function_call_output",
        );
        const lastFunctionName = functionCalls.at(-1)?.name;
        if (outputs.length > 0 && lastFunctionName !== "tool_search") {
          return sendSse(res, [
            { type: "response.output_text.delta", delta: "Fixture turn complete." },
            {
              type: "response.completed",
              response: { usage: { input_tokens: 20, output_tokens: 4 } },
            },
          ]);
        }
        if (prompt.includes("NO_TOOL")) {
          return sendSse(res, [
            { type: "response.output_text.delta", delta: "No tool requested." },
            {
              type: "response.completed",
              response: { usage: { input_tokens: 10, output_tokens: 3 } },
            },
          ]);
        }
        const desiredTool = prompt.includes("DISPLAY_ERROR")
          ? "mcp__acceptance__fail"
          : "mcp__acceptance__echo";
        const declaredTools = Array.isArray(body.tools) ? body.tools : [];
        const toolName =
          outputs.length === 0 && !declaredTools.some((tool) => tool?.name === desiredTool)
            ? "tool_search"
            : desiredTool;
        const id = nextCall++;
        const args = JSON.stringify(
          toolName === "tool_search"
            ? { query: "acceptance" }
            : { text: prompt.includes("AFTER_RECOVERY") ? "after-recovery" : "acceptance-ok" },
        );
        return sendSse(res, [
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name: toolName },
          },
          {
            type: "response.function_call_arguments.done",
            output_index: 0,
            item_id: `fc_${id}`,
            arguments: args,
          },
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              type: "function_call",
              id: `fc_${id}`,
              call_id: `call_${id}`,
              name: toolName,
              arguments: args,
            },
          },
          {
            type: "response.completed",
            response: { usage: { input_tokens: 10, output_tokens: 3 } },
          },
        ]);
      }
      if (req.method !== "POST" || url.pathname !== "/mcp") {
        return sendJson(res, 405, { error: "Method not allowed" });
      }
      const body = await readJson(req);
      const method = body.method;
      const sessionId = req.headers["mcp-session-id"];
      record({ kind: "mcp", method, sessionId: sessionId ?? null, params: body.params ?? null });
      if (method === "initialize") {
        const id = `acceptance-session-${nextSession++}`;
        sessions.add(id);
        return sendJson(
          res,
          200,
          {
            jsonrpc: "2.0",
            id: body.id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "acceptance", version: "1.0.0" },
            },
          },
          { "mcp-session-id": id },
        );
      }
      if (method === "notifications/initialized") {
        res.writeHead(202);
        return res.end();
      }
      if (typeof sessionId !== "string" || !sessions.has(sessionId)) {
        return sendJson(res, 404, {
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32001, message: "Session not found" },
        });
      }
      if (method === "tools/list") {
        return sendJson(res, 200, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [
              {
                name: "echo",
                description: "Return deterministic acceptance text",
                inputSchema: {
                  type: "object",
                  properties: { text: { type: "string" } },
                  required: ["text"],
                },
              },
              {
                name: "fail",
                description: "Return a deterministic MCP tool error",
                inputSchema: { type: "object", properties: { text: { type: "string" } } },
              },
            ],
          },
        });
      }
      if (method === "tools/call") {
        const name = body.params?.name;
        const text = String(body.params?.arguments?.text ?? "");
        const failed = name === "fail";
        record({ kind: "tool-call", name, text, failed });
        return sendJson(res, 200, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [{ type: "text", text: failed ? "fixture-is-error" : `fixture-echo:${text}` }],
            isError: failed,
          },
        });
      }
      return sendJson(res, 200, { jsonrpc: "2.0", id: body.id, result: {} });
    } catch (error) {
      record({
        kind: "fixture-error",
        message: error instanceof Error ? error.message : String(error),
      });
      sendJson(res, 500, { error: "fixture failure" });
    }
  };
  const server = tls
    ? createHttpsServer({ key: tls.key, cert: tls.cert }, handleRequest)
    : createHttpServer(handleRequest);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind TCP");
  return {
    port: address.port,
    url: `${tls ? "https" : "http"}://127.0.0.1:${address.port}`,
    records,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = await startDesktopMcpAcceptanceFixture({
    port: Number(process.env.MCP_ACCEPTANCE_PORT ?? 0),
  });
  process.stdout.write(`${JSON.stringify({ port: fixture.port, url: fixture.url })}\n`);
  const stop = async () => {
    await fixture.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
