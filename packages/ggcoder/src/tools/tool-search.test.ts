import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentTool, ToolContext } from "@kenkaiiii/gg-agent";
import { resolveContextLimits } from "../core/context-limits.js";
import { DeferredToolCatalog } from "../core/mcp/deferred-catalog.js";
import { createToolSearchTool, type CachedToolResolution } from "./tool-search.js";

const CONTEXT = {} as ToolContext;

function stub(name: string, description: string, result = "ok"): AgentTool {
  return {
    name,
    description,
    parameters: z.record(z.string(), z.unknown()),
    execute: async () => result,
  };
}

async function search(tool: ReturnType<typeof createToolSearchTool>, query: string) {
  return String(await tool.execute({ query }, CONTEXT));
}

describe("tool_search", () => {
  it("answers correctly on turn 1 from a cache-seeded catalog", async () => {
    const catalog = new DeferredToolCatalog();
    // Cold start: servers are still connecting, so every entry is a cached stub.
    catalog.add([stub("mcp__figma__get_screens", "fetch UI design screenshots")]);
    const promotedNames: string[] = [];
    const tool = createToolSearchTool(
      catalog,
      (tools) => promotedNames.push(...tools.map((t) => t.name)),
      async () => ({ serverName: "figma", ok: true }),
    );

    const result = await search(tool, "UI design screenshots");
    expect(result).toContain("mcp__figma__get_screens");
    expect(result).not.toContain("the catalog is empty");
    expect(promotedNames).toEqual(["mcp__figma__get_screens"]);
  });

  it("reports the empty catalog only when it really is empty", async () => {
    const tool = createToolSearchTool(new DeferredToolCatalog(), () => {});
    expect(await search(tool, "UI design screenshots")).toContain("the catalog is empty");
  });

  it("returns a model-visible error when the cached tool's server failed", async () => {
    const catalog = new DeferredToolCatalog();
    catalog.add([stub("mcp__figma__get_screens", "fetch UI design screenshots")]);
    const resolution: CachedToolResolution = {
      serverName: "figma",
      ok: false,
      error: "spawn ENOENT",
    };
    const promotedNames: string[] = [];
    const tool = createToolSearchTool(
      catalog,
      (tools) => promotedNames.push(...tools.map((candidate) => candidate.name)),
      async () => resolution,
    );

    const result = await search(tool, "UI design screenshots");
    expect(result).toContain("No usable tools matched");
    expect(result).toContain("figma");
    expect(result).toContain("spawn ENOENT");
    expect(promotedNames).toEqual([]);
    expect(catalog.names()).toEqual(["mcp__figma__get_screens"]);
  });

  it("promotes the reachable tools and flags only the unreachable ones", async () => {
    const catalog = new DeferredToolCatalog();
    catalog.add([
      stub("mcp__figma__get_screens", "fetch design screenshots"),
      stub("mcp__dead__get_screens", "fetch design screenshots"),
    ]);
    const promotedNames: string[] = [];
    const tool = createToolSearchTool(
      catalog,
      (tools) => promotedNames.push(...tools.map((candidate) => candidate.name)),
      async (name) =>
        name.startsWith("mcp__dead__")
          ? { serverName: "dead", ok: false, error: "timed out after 30000ms" }
          : undefined,
    );

    const result = await search(tool, "design screenshots");
    expect(result).toContain("1 tool(s) now available");
    expect(result).toContain("mcp__figma__get_screens");
    expect(result).toContain("Unreachable:");
    expect(result).toContain("mcp__dead__get_screens");
    expect(promotedNames).toEqual(["mcp__figma__get_screens"]);
    expect(catalog.names()).toEqual(["mcp__dead__get_screens"]);
  });

  it("does not name or promote catalog tools hidden by a live capability policy", async () => {
    const catalog = new DeferredToolCatalog();
    catalog.add([
      stub("mcp__kencode-search__searchCode", "search public code"),
      stub("mcp__unknown-mutator__write", "search and mutate code"),
    ]);
    const promotedNames: string[] = [];
    const tool = createToolSearchTool(
      catalog,
      (tools) => promotedNames.push(...tools.map((candidate) => candidate.name)),
      undefined,
      (name) => name.startsWith("mcp__kencode-search__"),
    );

    const result = await search(tool, "search code");
    expect(result).toContain("mcp__kencode-search__searchCode");
    expect(result).not.toContain("mcp__unknown-mutator__write");
    expect(promotedNames).toEqual(["mcp__kencode-search__searchCode"]);
    expect(catalog.names()).toEqual(["mcp__unknown-mutator__write"]);
  });

  it("works without a resolver (all tools already live)", async () => {
    const catalog = new DeferredToolCatalog();
    catalog.add([stub("mcp__figma__get_screens", "fetch design screenshots")]);
    const tool = createToolSearchTool(catalog, () => {});
    expect(await search(tool, "design screenshots")).toContain("1 tool(s) now available");
  });

  it("refuses promotion of a tool whose schema exceeds the byte budget", async () => {
    const catalog = new DeferredToolCatalog();
    const huge = z.object({
      blob: z.string().describe("x".repeat(200 * 1024)), // 200KB serialized schema
    });
    catalog.add([
      {
        name: "mcp__big__blob",
        description: "fetch design screenshots",
        parameters: huge,
        execute: async () => "ok",
      },
      stub("mcp__figma__get_screens", "fetch design screenshots"),
    ]);
    const promotedNames: string[] = [];
    const tool = createToolSearchTool(catalog, (tools) =>
      promotedNames.push(...tools.map((t) => t.name)),
    );

    const result = await search(tool, "design screenshots");
    // The fit tool promoted; the oversized one was refused and named.
    expect(result).toContain("1 tool(s) now available");
    expect(result).toContain("mcp__figma__get_screens");
    expect(result).toContain("Refused (schema byte budget)");
    expect(result).toContain("mcp__big__blob");
    expect(result).toContain("contextLimits.mcpToolSchemaBytes");
    expect(promotedNames).toEqual(["mcp__figma__get_screens"]);
    // Refused tool stays in the catalog, not the live toolset.
    expect(catalog.names()).toContain("mcp__big__blob");
  });

  it("fails closed when EVERY match exceeds the schema budget", async () => {
    const catalog = new DeferredToolCatalog();
    catalog.add([
      {
        name: "mcp__big__blob",
        description: "fetch design screenshots",
        parameters: z.object({ blob: z.string().describe("x".repeat(200 * 1024)) }),
        execute: async () => "ok",
      },
    ]);
    const promotedNames: string[] = [];
    const tool = createToolSearchTool(catalog, (tools) =>
      promotedNames.push(...tools.map((t) => t.name)),
    );

    const result = await search(tool, "design screenshots");
    expect(result).toContain("No tools promoted");
    expect(result).toContain("mcp__big__blob");
    expect(promotedNames).toEqual([]);
  });

  it("honors a raised schema budget from limits", async () => {
    const catalog = new DeferredToolCatalog();
    catalog.add([
      {
        name: "mcp__big__blob",
        description: "fetch design screenshots",
        parameters: z.object({ blob: z.string().describe("x".repeat(8 * 1024)) }), // ~8KB
        execute: async () => "ok",
      },
    ]);
    const tool = createToolSearchTool(
      catalog,
      () => {},
      undefined,
      resolveContextLimits({ mcpToolSchemaBytes: 16 * 1024 }),
    );
    expect(await search(tool, "design screenshots")).toContain("1 tool(s) now available");
  });
});
