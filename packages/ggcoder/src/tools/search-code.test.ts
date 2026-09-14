import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createSearchCodeTool } from "./search-code.js";

/**
 * Deterministic tests for the code_search tool — no API. We build a temp repo,
 * run the AST-chunk + BM25 pipeline, and assert ranking, the max_results cap,
 * `file:line → symbol` headers, non-TS skipping, the empty/no-results paths, and
 * `path` subdir scoping.
 */
describe("createSearchCodeTool", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "search-code-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function ctx(id: string) {
    return { signal: new AbortController().signal, toolCallId: id };
  }

  async function run(args: { query: string; path?: string; max_results?: number }) {
    const tool = createSearchCodeTool(tmpDir);
    return (await tool.execute(args, ctx("t"))) as string;
  }

  it("returns the chunk whose symbol matches the query first", async () => {
    await fs.writeFile(
      path.join(tmpDir, "auth.ts"),
      [
        "export function resolveCredentials(provider: string): string {",
        "  return provider + ':refreshed-oauth-token';",
        "}",
        "",
        "export function unrelatedHelper(x: number): number {",
        "  return x * 2;",
        "}",
      ].join("\n"),
    );

    const out = await run({ query: "resolve provider credentials oauth refresh" });
    const firstHeader = out.split("\n").find((l) => l.startsWith("//"))!;
    expect(firstHeader).toContain("resolveCredentials");
  });

  it("respects max_results", async () => {
    await fs.writeFile(
      path.join(tmpDir, "many.ts"),
      Array.from({ length: 6 }, (_, i) => `export function fn${i}(): number { return ${i}; }`).join(
        "\n",
      ),
    );

    const out = await run({ query: "fn", max_results: 2 });
    const headers = out.split("\n").filter((l) => l.startsWith("// "));
    expect(headers).toHaveLength(2);
  });

  it("emits file:line → symbol headers", async () => {
    await fs.writeFile(
      path.join(tmpDir, "thing.ts"),
      ["", "", "export class WidgetFactory {", "  build(): void {}", "}"].join("\n"),
    );

    const out = await run({ query: "widget factory build" });
    // Class starts on line 3 (1-based) after two blank lines.
    expect(out).toContain("// thing.ts:3 → WidgetFactory");
  });

  it("ignores file types it cannot chunk", async () => {
    await fs.writeFile(path.join(tmpDir, "notes.md"), "# resolveCredentials lives here\n");
    await fs.writeFile(path.join(tmpDir, "data.json"), '{"resolveCredentials": true}\n');

    const out = await run({ query: "resolveCredentials" });
    expect(out).toContain("No indexable source files here");
  });

  it("indexes languages beyond TS/JS", async () => {
    await fs.writeFile(
      path.join(tmpDir, "auth.py"),
      "def resolve_credentials(profile):\n    return profile.token\n",
    );

    const out = await run({ query: "resolve credentials for a profile" });
    expect(out).toContain("auth.py:1 \u2192 resolve_credentials");
    expect(out).toContain("return profile.token");
  });

  it("returns a clean no-results message when no symbols match nothing useful", async () => {
    // A file with no top-level declarations → no chunks.
    await fs.writeFile(path.join(tmpDir, "side.ts"), "console.log('hi');\nimport './x.js';\n");

    const out = await run({ query: "anything" });
    expect(out).toContain("No top-level symbols found");
  });

  it("honors a path subdir scope", async () => {
    await fs.mkdir(path.join(tmpDir, "pkg-a"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "pkg-b"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "pkg-a", "a.ts"),
      "export function alphaHandler(): string { return 'a'; }\n",
    );
    await fs.writeFile(
      path.join(tmpDir, "pkg-b", "b.ts"),
      "export function betaHandler(): string { return 'b'; }\n",
    );

    const out = await run({ query: "handler", path: "pkg-a" });
    expect(out).toContain("alphaHandler");
    expect(out).not.toContain("betaHandler");
    // Headers stay cwd-relative even when scoped to a subdir.
    expect(out).toContain("// pkg-a/a.ts:1 → alphaHandler");
  });
});
