import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { LspManager } from "./manager.js";
import { removeWhenReleased } from "./test-support.js";
import type { LspServerSpec } from "./servers.js";

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../tools/__fixtures__/fake-lsp-server.mjs",
);

function fakeSpec(serverArgs: string[] = [], overrides?: Partial<LspServerSpec>): LspServerSpec {
  return {
    id: "fake",
    extensions: [".fake"],
    rootMarkers: ["fake-root.json"],
    languageIdFor: () => "fake",
    resolveCommand: () => ({ command: process.execPath, args: [FIXTURE, ...serverArgs] }),
    ...overrides,
  };
}

const SOURCE = "class Widget {\n  render() {}\n}\nconst widget = new Widget();\n";

describe("LspManager navigation", () => {
  let tmpDir: string;
  let managers: LspManager[];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-nav-manager-"));
    await fs.writeFile(path.join(tmpDir, "fake-root.json"), "{}");
    managers = [];
  });

  afterEach(async () => {
    for (const manager of managers) manager.shutdownAll();
    await removeWhenReleased(tmpDir);
  });

  function makeManager(spec: LspServerSpec, budgets?: { warm?: number; first?: number }) {
    const manager = new LspManager(tmpDir, {
      catalog: [spec],
      warmBudgetMs: budgets?.warm ?? 5000,
      firstBudgetMs: budgets?.first ?? 5000,
    });
    managers.push(manager);
    return manager;
  }

  const file = () => path.join(tmpDir, "widget.fake");

  it("returns a definition location", async () => {
    const outcome = await makeManager(fakeSpec()).definition(file(), SOURCE, {
      line: 3,
      character: 6,
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.serverId).toBe("fake");
    expect(outcome.value[0].range.start.line).toBe(0);
  });

  it("returns references", async () => {
    const outcome = await makeManager(fakeSpec()).references(file(), SOURCE, {
      line: 0,
      character: 6,
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.value).toHaveLength(2);
  });

  it("returns document symbols", async () => {
    const outcome = await makeManager(fakeSpec()).documentSymbols(file(), SOURCE);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    // The manager passes the server's tree through untouched; trimming it to a
    // readable outline is the code_nav tool's job.
    expect(outcome.value.map((s) => s.name)).toEqual(["helper", "tmp", "i", "Widget", "render"]);
  });

  it("returns hover text", async () => {
    const outcome = await makeManager(fakeSpec()).hover(file(), SOURCE, { line: 3, character: 6 });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.value).toContain("const widget: Widget");
  });

  it("reports unsupported for a file no catalog server claims", async () => {
    const outcome = await makeManager(fakeSpec()).hover(path.join(tmpDir, "a.unknown"), "x", {
      line: 0,
      character: 0,
    });
    expect(outcome.kind).toBe("unsupported");
  });

  it("reports unsupported when the server lacks the capability", async () => {
    const outcome = await makeManager(fakeSpec(["--no-nav"])).definition(file(), SOURCE, {
      line: 0,
      character: 0,
    });
    expect(outcome.kind).toBe("unsupported");
    expect(outcome.serverId).toBe("fake");
  });

  it("reports timeout when the server never answers", async () => {
    const outcome = await makeManager(fakeSpec(["--nav-silent"]), {
      warm: 200,
      first: 200,
    }).references(file(), SOURCE, { line: 0, character: 0 });
    expect(outcome.kind).toBe("timeout");
  });

  it("reports unavailable when the server cannot be launched", async () => {
    const spec = fakeSpec();
    const outcome = await makeManager({ ...spec, resolveCommand: () => null }).hover(
      file(),
      SOURCE,
      { line: 0, character: 0 },
    );
    expect(outcome.kind).toBe("unavailable");
  });

  it("reports server_failed when the server dies on open", async () => {
    const outcome = await makeManager(fakeSpec(["--crash-on-open"]), {
      warm: 1000,
      first: 1000,
    }).hover(file(), SOURCE, { line: 0, character: 0 });
    expect(["server_failed", "timeout"]).toContain(outcome.kind);
  });

  it("reports unavailable after shutdown", async () => {
    const manager = makeManager(fakeSpec());
    manager.shutdownAll();
    const outcome = await manager.documentSymbols(file(), SOURCE);
    expect(outcome.kind).toBe("unavailable");
  });
});
