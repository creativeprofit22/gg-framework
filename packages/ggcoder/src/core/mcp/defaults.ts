import type { Provider } from "@kenkaiiii/gg-ai";
import type { MCPServerConfig } from "./types.js";
import { loadServers } from "./store.js";
import { getAppPaths } from "../../config.js";
import { log } from "../logger.js";

/** Servers every provider gets. Real-code research is the native `steroids`
 *  tool now, so nothing ships here by default; provider-specific servers are
 *  added in `getMCPServers`. */
export const DEFAULT_MCP_SERVERS: MCPServerConfig[] = [];

/**
 * Get MCP servers for a specific provider.
 * GLM models get Z.AI MCP servers for vision, web search, web reading, and GitHub exploration.
 */
export function getMCPServers(provider: Provider, apiKey?: string): MCPServerConfig[] {
  const servers = [...DEFAULT_MCP_SERVERS];

  if (provider === "glm" && apiKey) {
    const zaiAuth = { Authorization: `Bearer ${apiKey}` };

    // Vision (image support via stdio MCP server). Timeout is 180s, not the
    // 60s the quick HTTP zai calls use: GLM-4.6V analysis of a large screenshot
    // legitimately runs 20-60s+ (observed 52s successes and 60s-cap kills in
    // the sidecar logs), and client.ts applies this per tool CALL.
    servers.push({
      name: "zai_vision",
      command: "npx",
      args: ["-y", "@z_ai/mcp-server"],
      env: {
        Z_AI_API_KEY: apiKey,
        Z_AI_MODE: "ZAI",
      },
      timeout: 180_000,
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

export interface McpServerSelectionOptions {
  allowProjectScope?: boolean;
  /**
   * Caller-owned record of untrusted-project skips already reported. Pass one
   * Set per session so reconnects don't repeat the warning; omit it to warn on
   * every call.
   */
  reportedProjectSkips?: Set<string>;
}

/** Repo-controlled names go into a log line; keep them on one line. */
function printableServerName(name: string): string {
  return name.replace(/\p{Cc}/gu, "?");
}

/**
 * Full startup set: provider defaults + user-configured servers from
 * ~/.gg/mcp.json and ./.gg/mcp.json. Provider defaults stay authoritative —
 * a user server can only ADD a new name, never override a default.
 */
export async function getAllMcpServers(
  provider: Provider,
  apiKey: string | undefined,
  cwd: string,
  opts?: McpServerSelectionOptions,
): Promise<MCPServerConfig[]> {
  const defaults = getMCPServers(provider, apiKey);
  const defaultNames = new Set(defaults.map((s) => s.name));
  const scoped = await loadServers(cwd);
  const allowProjectScope = opts?.allowProjectScope === true;
  // Project scope (<repo>/.gg/mcp.json) is repo-controlled: a malicious repo
  // can declare a stdio `command` that would execute the moment the project
  // opens. Only include those when explicitly trusted (trustProjectMcpServers);
  // global ~/.gg/mcp.json is the user's own file and always connects.
  const userServers = scoped
    .filter((s) => allowProjectScope || s.scope !== "project")
    .map((s) => s.config)
    .filter((c) => !defaultNames.has(c.name));

  if (!allowProjectScope) {
    // Only servers that trusting the project would actually start.
    const skipped = scoped
      .filter((s) => s.scope === "project" && s.config.enabled !== false)
      .filter((s) => !defaultNames.has(s.config.name))
      .map((s) => printableServerName(s.config.name))
      .sort();
    if (skipped.length > 0) {
      const key = `${cwd}\u0000${skipped.join("\u0000")}`;
      if (!opts?.reportedProjectSkips?.has(key)) {
        opts?.reportedProjectSkips?.add(key);
        // Names and paths only: configs may carry env values or tokens.
        const settingsFile = getAppPaths().settingsFile;
        log(
          "WARN",
          "mcp",
          `Skipped untrusted project-scope MCP server(s) [${skipped.join(", ")}] for ${cwd}; ` +
            `trust it in ${settingsFile} (trustedProjects) or via the MCP panel`,
        );
      }
    }
  }

  return [...defaults, ...userServers];
}
