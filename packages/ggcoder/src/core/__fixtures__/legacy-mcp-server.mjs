// A deliberately 2025-only stdio MCP server.
//
// It implements exactly the pre-2026 surface: the `initialize` handshake,
// `notifications/initialized`, and `tools/list`. Anything it does not
// recognize — notably the 2026-07-28 `server/discover` probe — gets a
// JSON-RPC "method not found", which is what a real un-upgraded server does.
//
// Used to prove that enabling `versionNegotiation: { mode: "auto" }` still
// connects such a server instead of failing or hanging.
//
// `GG_FIXTURE_SILENT_ON_UNKNOWN=1` makes it ignore unknown methods entirely
// (no reply at all), the harsher shape of legacy server that forces the probe
// to fall back on timeout rather than on an error response.

import process from "node:process";

const SILENT_ON_UNKNOWN = process.env.GG_FIXTURE_SILENT_ON_UNKNOWN === "1";
const PROTOCOL_VERSION = "2025-11-25";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handle(message) {
  // Notifications carry no id and never get a response.
  if (message.id === undefined || message.id === null) return;

  switch (message.method) {
    case "initialize":
      respond(message.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "legacy-fixture", version: "1.0.0" },
      });
      return;
    case "ping":
      respond(message.id, {});
      return;
    case "tools/list":
      respond(message.id, {
        tools: [
          {
            name: "echo",
            description: "Echo the provided text back to the caller",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        ],
      });
      return;
    case "tools/call":
      respond(message.id, {
        content: [{ type: "text", text: String(message.params?.arguments?.text ?? "") }],
      });
      return;
    default:
      if (SILENT_ON_UNKNOWN) return;
      respondError(message.id, -32601, `Method not found: ${message.method}`);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      try {
        handle(JSON.parse(line));
      } catch {
        // A malformed line is not something a legacy server reports back.
      }
    }
    newline = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));
