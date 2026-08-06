import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { DeferredToolCatalog } from "../core/mcp/deferred-catalog.js";

const ToolSearchParams = z.object({
  query: z
    .string()
    .describe(
      "The capability you need, e.g. 'search UI design screenshots' or 'query github code'",
    ),
});

/** Outcome of waiting for the MCP server behind a cached-only catalog entry. */
export interface CachedToolResolution {
  serverName: string;
  ok: boolean;
  error?: string;
}

/**
 * Discovery tool for the deferred MCP catalog. Matching tools are promoted
 * into the live toolset immediately — callable from the very next turn.
 * `onPromote` pushes onto the session's live tools array (the agent loop
 * re-reads it every turn).
 *
 * `resolveCached` settles entries that came from the on-disk catalog cache and
 * whose server has not connected yet: it waits for that connection so the model
 * learns *now* whether the capability really exists, instead of promoting a
 * tool that will fail on first call. Returns undefined for already-live tools.
 */
export function createToolSearchTool(
  catalog: DeferredToolCatalog,
  onPromote: (tools: AgentTool[]) => void,
  resolveCached?: (toolName: string) => Promise<CachedToolResolution | undefined>,
): AgentTool<typeof ToolSearchParams> {
  return {
    name: "tool_search",
    description:
      "Search the extended tool catalog (MCP servers and integrations) by capability. " +
      "Matching tools become available immediately — call them on your next step. " +
      "Use this when you need a capability not in your current toolset.",
    parameters: ToolSearchParams,
    async execute({ query }) {
      const matches = catalog.search(query);
      if (matches.length === 0) {
        const remaining = catalog.names();
        return remaining.length === 0
          ? "No tools matched and the catalog is empty — every catalog tool is already available."
          : `No tools matched "${query}". Still in the catalog: ${remaining.join(", ")}`;
      }
      const promoted = catalog.promote(matches.map((t) => t.name));
      onPromote(promoted);

      const unavailable = new Map<string, CachedToolResolution>();
      if (resolveCached) {
        const settled = await Promise.all(
          promoted.map(async (tool) => [tool.name, await resolveCached(tool.name)] as const),
        );
        for (const [name, resolution] of settled) {
          if (resolution && !resolution.ok) unavailable.set(name, resolution);
        }
      }

      const available = promoted.filter((tool) => !unavailable.has(tool.name));
      const failures = [...unavailable].map(
        ([name, resolution]) =>
          `- ${name}: MCP server "${resolution.serverName}" did not connect (${resolution.error ?? "unknown error"}).`,
      );

      if (available.length === 0) {
        return `No usable tools matched "${query}". Offered from a cached catalog but unreachable:\n${failures.join("\n")}`;
      }
      const lines = available.map(
        (t) => `- ${t.name}: ${t.description.split("\n")[0].slice(0, 200)}`,
      );
      const body = `${available.length} tool(s) now available:\n${lines.join("\n")}`;
      return failures.length > 0 ? `${body}\n\nUnreachable:\n${failures.join("\n")}` : body;
    },
  };
}
