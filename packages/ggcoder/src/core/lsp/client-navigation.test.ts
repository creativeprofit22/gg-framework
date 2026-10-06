import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { LspClient } from "./client.js";
import { removeWhenReleased } from "./test-support.js";
import type { LspServerSpec } from "./servers.js";

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../tools/__fixtures__/fake-lsp-server.mjs",
);

const SPEC: LspServerSpec = {
  id: "fake",
  extensions: [".fake"],
  rootMarkers: ["fake-root.json"],
  languageIdFor: () => "fake",
  resolveCommand: () => ({ command: process.execPath, args: [FIXTURE] }),
};

const SOURCE = "class Widget {\n  render() {}\n}\nconst widget = new Widget();\n";

describe("LspClient navigation", () => {
  let tmpDir: string;
  let clients: LspClient[];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-nav-test-"));
    await fs.writeFile(path.join(tmpDir, "fake-root.json"), "{}");
    clients = [];
  });

  afterEach(async () => {
    for (const client of clients) client.terminate();
    await removeWhenReleased(tmpDir);
  });

  async function connect(serverArgs: string[] = []): Promise<{ client: LspClient; uri: string }> {
    const client = new LspClient(SPEC, tmpDir, {
      command: process.execPath,
      args: [FIXTURE, ...serverArgs],
    });
    clients.push(client);
    await client.initialize(5000);
    const uri = client.syncDocument(path.join(tmpDir, "widget.fake"), SOURCE);
    return { client, uri };
  }

  it("resolves a definition", async () => {
    const { client, uri } = await connect();
    const outcome = await client.definition(uri, { line: 3, character: 6 }, 5000);
    expect(outcome).toEqual({
      status: "ok",
      value: [
        { uri, range: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } } },
      ],
    });
  });

  it("normalizes a LocationLink reply to its selection range", async () => {
    const { client, uri } = await connect(["--location-links"]);
    const outcome = await client.definition(uri, { line: 3, character: 6 }, 5000);
    expect(outcome).toMatchObject({
      status: "ok",
      value: [{ uri, range: { start: { line: 0, character: 6 } } }],
    });
  });

  it("lists references", async () => {
    const { client, uri } = await connect();
    const outcome = await client.references(uri, { line: 0, character: 6 }, 5000);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.value).toHaveLength(2);
    expect(outcome.value[1].range.start.line).toBe(2);
  });

  it("flattens hierarchical document symbols with their containers", async () => {
    const { client, uri } = await connect();
    const outcome = await client.documentSymbols(uri, 5000);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    // The client stays faithful to the server: full tree, server order, no
    // filtering. Presentation decisions belong to the outline, not here.
    expect(outcome.value.map((s) => ({ name: s.name, containers: s.containers }))).toEqual([
      { name: "helper", containers: [] },
      { name: "tmp", containers: ["helper"] },
      { name: "i", containers: ["helper"] },
      { name: "Widget", containers: [] },
      { name: "render", containers: ["Widget"] },
    ]);
  });

  it("records each ancestor's kind so locals can be told from class members", async () => {
    const { client, uri } = await connect();
    const outcome = await client.documentSymbols(uri, 5000);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    const byName = new Map(outcome.value.map((s) => [s.name, s]));
    expect(byName.get("helper")!.containerKinds).toEqual([]);
    expect(byName.get("tmp")!.containerKinds).toEqual([12]); // inside a function
    expect(byName.get("render")!.containerKinds).toEqual([5]); // inside a class
  });

  it("flattens legacy SymbolInformation replies the same way", async () => {
    const { client, uri } = await connect(["--flat-symbols"]);
    const outcome = await client.documentSymbols(uri, 5000);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.value.map((s) => ({ name: s.name, containers: s.containers }))).toEqual([
      { name: "Widget", containers: [] },
      { name: "render", containers: ["Widget"] },
    ]);
  });

  it("collapses hover MarkupContent to text", async () => {
    const { client, uri } = await connect();
    const outcome = await client.hover(uri, { line: 3, character: 6 }, 5000);
    expect(outcome).toEqual({ status: "ok", value: "```ts\nconst widget: Widget\n```" });
  });

  it("reports unsupported rather than empty when the server lacks the method", async () => {
    const { client, uri } = await connect(["--no-nav"]);
    expect(await client.definition(uri, { line: 0, character: 0 }, 5000)).toEqual({
      status: "unsupported",
    });
    expect(await client.references(uri, { line: 0, character: 0 }, 5000)).toEqual({
      status: "unsupported",
    });
    expect(await client.documentSymbols(uri, 5000)).toEqual({ status: "unsupported" });
    expect(await client.hover(uri, { line: 0, character: 0 }, 5000)).toEqual({
      status: "unsupported",
    });
  });

  it("reports a timeout rather than empty when the server never answers", async () => {
    const { client, uri } = await connect(["--nav-silent"]);
    const outcome = await client.references(uri, { line: 0, character: 0 }, 150);
    expect(outcome).toEqual({ status: "timeout" });
  });

  it("reports failure once the server is gone", async () => {
    const { client, uri } = await connect();
    client.terminate();
    const outcome = await client.hover(uri, { line: 0, character: 0 }, 500);
    expect(outcome.status).toBe("failed");
  });
});
