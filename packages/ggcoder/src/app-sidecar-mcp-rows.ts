import type { McpServerRow } from "@kenkaiiii/gg-core";
import { loadSavedSettings, projectScopeAllowed } from "./config.js";
import { MCPClientManager } from "./core/mcp/client.js";
import { loadServers } from "./core/mcp/store.js";
import type { MCPServerConfig } from "./core/mcp/types.js";

/** A short transport summary for display (URL or command + arguments). */
function mcpRowSummary(config: MCPServerConfig): string {
  if (config.url) return config.url;
  return [config.command, ...(config.args ?? [])].filter(Boolean).join(" ");
}

/** Join saved configs with live status. Disabled and untrusted project servers
 * are never connected: even a status probe could execute a repo-controlled command. */
export async function buildMcpRows(cwd: string, settingsFile: string): Promise<McpServerRow[]> {
  const scoped = await loadServers(cwd);
  if (scoped.length === 0) return [];

  const settings = loadSavedSettings(settingsFile);
  const allowProject = projectScopeAllowed(
    settings.trustProjectMcpServers,
    settings.trustedProjects,
    cwd,
  );
  const connectable = scoped.filter((s) => allowProject || s.scope !== "project");
  const blocked = scoped.filter((s) => !allowProject && s.scope === "project");

  const manager = new MCPClientManager();
  try {
    const results =
      connectable.length > 0
        ? await manager.connectAllDetailed(connectable.map((s) => s.config))
        : [];
    return [
      ...connectable.map((s): McpServerRow => {
        const result = results.find((r) => r.name === s.config.name);
        return {
          name: s.config.name,
          scope: s.scope,
          enabled: s.config.enabled !== false,
          ok: result?.ok ?? false,
          toolCount: result?.toolCount ?? 0,
          error: result?.error,
          failureReason:
            s.config.enabled !== false && !result?.ok && !result?.requiresAuth
              ? "connection-failed"
              : undefined,
          kind: s.config.url ? "http" : "stdio",
          summary: mcpRowSummary(s.config),
          requiresAuth: result?.requiresAuth,
        };
      }),
      ...blocked.map((s): McpServerRow => ({
        name: s.config.name,
        scope: s.scope,
        enabled: s.config.enabled !== false,
        ok: false,
        toolCount: 0,
        failureReason: s.config.enabled !== false ? "trust-blocked" : undefined,
        error:
          "Project-scope server not connected — this repo's .gg/mcp.json runs " +
          "repo-controlled commands. Add or re-add a server in this project via " +
          "the MCP modal to trust it.",
        kind: s.config.url ? "http" : "stdio",
        summary: mcpRowSummary(s.config),
      })),
    ];
  } finally {
    await manager.dispose();
  }
}
