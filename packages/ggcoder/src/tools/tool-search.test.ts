import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentTool, ToolContext } from "@kenkaiiii/gg-agent";
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
    const tool = createToolSearchTool(
      catalog,
      () => {},
      async () => resolution,
    );

    const result = await search(tool, "UI design screenshots");
    expect(result).toContain("No usable tools matched");
    expect(result).toContain("figma");
    expect(result).toContain("spawn ENOENT");
  });

  it("promotes the reachable tools and flags only the unreachable ones", async () => {
    const catalog = new DeferredToolCatalog();
    catalog.add([
      stub("mcp__figma__get_screens", "fetch design screenshots"),
      stub("mcp__dead__get_screens", "fetch design screenshots"),
    ]);
    const tool = createToolSearchTool(
      catalog,
      () => {},
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
  });

  it("works without a resolver (all tools already live)", async () => {
    const catalog = new DeferredToolCatalog();
    catalog.add([stub("mcp__figma__get_screens", "fetch design screenshots")]);
    const tool = createToolSearchTool(catalog, () => {});
    expect(await search(tool, "design screenshots")).toContain("1 tool(s) now available");
  });
});
