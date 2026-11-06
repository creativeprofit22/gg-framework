// A stdio MCP server that asks the client for input mid tool call.
//
// It implements the 2025-era surface plus a server→client `elicitation/create`
// request, which is the whole point: it lets us prove that our client declares
// the elicitation capability, routes the request to the host handler, and
// returns the user's answer to the server.
//
// Tools:
//   ask                — sends elicitation/create and echoes back what came back
//   client_capabilities — returns the capabilities the client declared at
//                         initialize, so a test can assert what we advertise

import process from "node:process";

const PROTOCOL_VERSION = "2025-11-25";

/** Capabilities the client declared during `initialize`. */
let clientCapabilities = null;
/** Pending server→client requests, keyed by the id we assigned. */
const inflight = new Map();
let requestSeq = 0;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

/** Ask the client a question and resolve with its ElicitResult. */
function elicit(message, requestedSchema) {
  return new Promise((resolve) => {
    const id = `srv-${++requestSeq}`;
    inflight.set(id, resolve);
    send({ jsonrpc: "2.0", id, method: "elicitation/create", params: { message, requestedSchema } });
  });
}

const ASK_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", title: "Your name" },
    count: { type: "integer", title: "How many" },
    confirm: { type: "boolean", title: "Proceed?" },
  },
  required: ["name"],
};

async function callTool(id, name) {
  if (name === "client_capabilities") {
    respond(id, { content: [{ type: "text", text: JSON.stringify(clientCapabilities ?? {}) }] });
    return;
  }
  const result = await elicit("The server needs some details", ASK_SCHEMA);
  respond(id, { content: [{ type: "text", text: JSON.stringify(result) }] });
}

function handle(message) {
  // A response to one of OUR requests carries an id but no method.
  if (message.method === undefined && message.id !== undefined) {
    const resolve = inflight.get(message.id);
    if (resolve) {
      inflight.delete(message.id);
      resolve(message.error ? { action: "error", error: message.error } : message.result);
    }
    return;
  }

  // Notifications carry no id and never get a response.
  if (message.id === undefined || message.id === null) return;

  switch (message.method) {
    case "initialize":
      clientCapabilities = message.params?.capabilities ?? {};
      respond(message.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "elicit-fixture", version: "1.0.0" },
      });
      return;
    case "ping":
      respond(message.id, {});
      return;
    case "tools/list":
      respond(message.id, {
        tools: [
          {
            name: "ask",
            description: "Ask the user for details, then report what they answered",
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "client_capabilities",
            description: "Report the capabilities the client declared at initialize",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      });
      return;
    case "tools/call":
      void callTool(message.id, message.params?.name);
      return;
    default:
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `Method not found: ${message.method}` },
      });
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
        // Malformed input is not something this fixture reports back.
      }
    }
    newline = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));
