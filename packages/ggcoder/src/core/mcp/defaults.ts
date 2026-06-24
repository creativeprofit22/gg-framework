import type { Provider } from "@kenkaiiii/gg-ai";
import type { MCPServerConfig } from "./types.js";
import { loadServers } from "./store.js";

export const DEFAULT_MCP_SERVERS: MCPServerConfig[] = [
  // kencode-search ships as a ggcoder dependency, so `connectServer` rewrites
  // this `npx -y` form to a direct `node <binScript>` invocation at connect
  // time (see core/mcp/resolve-stdio.ts) — skipping the ~100 MB npx wrapper
  // process. The `npx` form is kept here so it still works if the dependency
  // is ever unavailable (graceful fallback to npx resolution).
  { name: "kencode-search", command: "npx", args: ["-y", "@kenkaiiii/kencode-search"] },
];

/**
 * Get MCP servers for a specific provider.
 * GLM models get Z.AI MCP servers for vision, web search, web reading, and GitHub exploration.
 */
export function getMCPServers(provider: Provider, apiKey?: string): MCPServerConfig[] {
  const servers = [...DEFAULT_MCP_SERVERS];

  if (provider === "glm" && apiKey) {
    const zaiAuth = { Authorization: `Bearer ${apiKey}` };

    // Vision (image support via stdio MCP server)
    servers.push({
      name: "zai_vision",
      command: "npx",
      args: ["-y", "@z_ai/mcp-server"],
      env: {
        Z_AI_API_KEY: apiKey,
        Z_AI_MODE: "ZAI",
      },
      timeout: 60_000,
    });

    // Web search
    servers.push({
      name: "zai_web_search",
      url: "https://api.z.ai/api/mcp/web_search_prime/mcp",
      headers: zaiAuth,
      timeout: 60_000,
    });

    // Web reader (full-page content extraction)
    servers.push({
      name: "zai_web_reader",
      url: "https://api.z.ai/api/mcp/web_reader/mcp",
      headers: zaiAuth,
      timeout: 60_000,
    });

    // GitHub repository exploration
    servers.push({
      name: "zai_zread",
      url: "https://api.z.ai/api/mcp/zread/mcp",
      headers: zaiAuth,
      timeout: 60_000,
    });
  }

  return servers;
}

/**
 * Full startup set: provider defaults + user-configured servers from
 * ~/.gg/mcp.json and ./.gg/mcp.json. Provider defaults stay authoritative —
 * a user server can only ADD a new name, never override a default like
 * `kencode-search`.
 */
export async function getAllMcpServers(
  provider: Provider,
  apiKey: string | undefined,
  cwd: string,
): Promise<MCPServerConfig[]> {
  const defaults = getMCPServers(provider, apiKey);
  const defaultNames = new Set(defaults.map((s) => s.name));
  const scoped = await loadServers(cwd);
  const userServers = scoped.map((s) => s.config).filter((c) => !defaultNames.has(c.name));
  return [...defaults, ...userServers];
}
