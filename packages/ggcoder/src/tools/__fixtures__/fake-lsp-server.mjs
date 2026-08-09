#!/usr/bin/env node
/**
 * Fake LSP server for manager tests — speaks JSON-RPC over stdio with
 * Content-Length framing. Zero deps, CI-safe (no real language servers).
 *
 * Behavior: any line containing the token "ERROR" in a synced document
 * produces one error diagnostic; clean content publishes an empty list.
 *
 * Flags:
 *   --pull               advertise pull diagnostics (diagnosticProvider)
 *   --delay-ms=N         delay publishing diagnostics by N milliseconds
 *   --shutdown-file=PATH write PATH when the shutdown request arrives
 *   --progress            begin indexing progress and leave it active
 *   --progress-end        end indexing progress after publishing
 *   --premature-empty     reproduce tsserver's cold-project-load sequence: end
 *                         progress, publish an EMPTY set before the file has
 *                         actually been analysed, then publish the real
 *                         diagnostics shortly after
 *   --init-error          fail initialization
 *   --crash-on-open       exit after initialization when a document opens
 *   --silent              never publish diagnostics
 *   --pid-file=PATH       write this process's pid at startup, so a test can
 *                         assert the server was actually reaped
 *   --no-nav              do not advertise or answer navigation requests
 *   --nav-silent          advertise navigation, then never answer it
 *   --location-links      answer definition with LocationLink, not Location
 *   --flat-symbols        answer documentSymbol with legacy SymbolInformation
 */
import fs from "node:fs";

const args = process.argv.slice(2);
const hasPull = args.includes("--pull");
const delayMs = Number(args.find((a) => a.startsWith("--delay-ms="))?.split("=")[1] ?? 0);
const shutdownFile = args.find((a) => a.startsWith("--shutdown-file="))?.split("=")[1];
const prematureEmpty = args.includes("--premature-empty");
const hasProgress =
  args.includes("--progress") || args.includes("--progress-end") || prematureEmpty;
const endsProgress = args.includes("--progress-end") || prematureEmpty;
const initError = args.includes("--init-error");
const crashOnOpen = args.includes("--crash-on-open");
const silent = args.includes("--silent");
const pidFile = args.find((a) => a.startsWith("--pid-file="))?.split("=")[1];
const noNav = args.includes("--no-nav");
const navSilent = args.includes("--nav-silent");
const locationLinks = args.includes("--location-links");
const flatSymbols = args.includes("--flat-symbols");
if (pidFile) fs.writeFileSync(pidFile, String(process.pid));

const documents = new Map(); // uri -> text

function send(msg) {
  const body = JSON.stringify(msg);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function diagnosticsFor(text) {
  const diagnostics = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const character = lines[i].indexOf("ERROR");
    if (character === -1) continue;
    diagnostics.push({
      range: { start: { line: i, character }, end: { line: i, character: character + 5 } },
      severity: 1,
      message: `fake error on line ${i + 1}`,
      source: "fake",
    });
  }
  return diagnostics;
}

function publish(uri) {
  if (silent) return;
  const text = documents.get(uri) ?? "";
  if (hasProgress) {
    send({
      jsonrpc: "2.0",
      method: "$/progress",
      params: { token: "index", value: { kind: "begin", title: "Indexing" } },
    });
  }
  const fire = () => {
    if (endsProgress) {
      send({
        jsonrpc: "2.0",
        method: "$/progress",
        params: { token: "index", value: { kind: "end" } },
      });
    }
    // What real tsserver does on a cold project load: it ends the load progress
    // and immediately publishes an EMPTY set for the open file, then publishes
    // the actual diagnostics once it has type-checked. Treating that first empty
    // publish as "clean" is the Windows CI failure this reproduces.
    if (prematureEmpty) {
      send({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: { uri, diagnostics: [] },
      });
      setTimeout(() => {
        send({
          jsonrpc: "2.0",
          method: "textDocument/publishDiagnostics",
          params: { uri, diagnostics: diagnosticsFor(text) },
        });
      }, 120);
      return;
    }
    send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri, diagnostics: diagnosticsFor(text) },
    });
  };
  if (delayMs > 0) setTimeout(fire, delayMs);
  else fire();
}

const NAVIGATION_METHODS = new Set([
  "textDocument/definition",
  "textDocument/references",
  "textDocument/documentSymbol",
  "textDocument/hover",
]);

function range(line, startChar, endChar) {
  return {
    start: { line, character: startChar },
    end: { line, character: endChar },
  };
}

function navigationResult(msg) {
  const uri = msg.params.textDocument.uri;
  if (msg.method === "textDocument/definition") {
    return locationLinks
      ? [{ targetUri: uri, targetRange: range(0, 0, 20), targetSelectionRange: range(0, 6, 12) }]
      : { uri, range: range(0, 6, 12) };
  }
  if (msg.method === "textDocument/references") {
    return [
      { uri, range: range(0, 6, 12) },
      { uri, range: range(2, 2, 8) },
    ];
  }
  if (msg.method === "textDocument/documentSymbol") {
    if (flatSymbols) {
      return [
        { name: "Widget", kind: 5, location: { uri, range: range(0, 0, 6) } },
        {
          name: "render",
          kind: 6,
          containerName: "Widget",
          location: { uri, range: range(1, 2, 8) },
        },
      ];
    }
    // Shaped like a real tsserver reply: grouped by name rather than document
    // order, and carrying body-locals nested under a function.
    return [
      {
        name: "helper",
        kind: 12,
        range: range(10, 0, 6),
        selectionRange: range(10, 9, 15),
        children: [
          { name: "tmp", kind: 13, range: range(11, 2, 5) },
          { name: "i", kind: 13, range: range(12, 2, 3) },
        ],
      },
      {
        name: "Widget",
        kind: 5,
        range: range(0, 0, 6),
        selectionRange: range(0, 6, 12),
        children: [{ name: "render", kind: 6, detail: "(): void", range: range(1, 2, 8) }],
      },
    ];
  }
  return { contents: { kind: "markdown", value: "```ts\nconst widget: Widget\n```" } };
}

function onMessage(msg) {
  if (msg.method === "initialize") {
    if (initError) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32002, message: "init failed" } });
    } else {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          capabilities: {
            ...(hasPull ? { diagnosticProvider: {} } : {}),
            ...(noNav
              ? {}
              : {
                  definitionProvider: true,
                  referencesProvider: true,
                  documentSymbolProvider: true,
                  hoverProvider: true,
                }),
          },
        },
      });
    }
    return;
  }
  if (msg.method === "textDocument/didOpen") {
    if (crashOnOpen) process.exit(2);
    const { uri, text } = msg.params.textDocument;
    documents.set(uri, text);
    publish(uri);
    return;
  }
  if (msg.method === "textDocument/didChange") {
    const { uri } = msg.params.textDocument;
    documents.set(uri, msg.params.contentChanges[0].text);
    publish(uri);
    return;
  }
  if (msg.method === "textDocument/diagnostic") {
    const { uri } = msg.params.textDocument;
    const reply = () =>
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { kind: "full", items: diagnosticsFor(documents.get(uri) ?? "") },
      });
    if (delayMs > 0) setTimeout(reply, delayMs);
    else reply();
    return;
  }
  if (NAVIGATION_METHODS.has(msg.method)) {
    if (noNav) {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `method not found: ${msg.method}` },
      });
      return;
    }
    // Advertised but mute: the shape that used to be indistinguishable from an
    // honest "no results".
    if (navSilent) return;
    send({ jsonrpc: "2.0", id: msg.id, result: navigationResult(msg) });
    return;
  }
  if (msg.method === "shutdown") {
    if (shutdownFile) fs.writeFileSync(shutdownFile, "shutdown-received");
    send({ jsonrpc: "2.0", id: msg.id, result: null });
    return;
  }
  if (msg.method === "exit") {
    process.exit(0);
  }
}

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const match = /Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString());
    if (!match) return;
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + length) return;
    const body = buffer.subarray(start, start + length).toString();
    buffer = buffer.subarray(start + length);
    try {
      onMessage(JSON.parse(body));
    } catch {
      // ignore malformed input
    }
  }
});
process.stdin.on("end", () => process.exit(0));
