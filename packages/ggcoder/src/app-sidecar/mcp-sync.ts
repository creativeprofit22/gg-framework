import { loadSavedSettings, projectScopeAllowed } from "../config.js";
import type { AgentSession, McpServerChange } from "../core/agent-session.js";
import { log } from "../core/logger.js";
import {
  isBuiltinServerName,
  loadServers,
  removeBuiltinServer,
  removeServer,
  withBuiltinServers,
  type BuiltinLookupDeps,
  type MCPScope,
  type MCPServerConfig,
  type ScopedServer,
} from "../core/mcp/index.js";

/**
 * One server's config as a session in `cwd` would load it at startup:
 * project scope wins over global, and project servers count only when the
 * project is trusted, and a built-in counts when no user server uses its name
 * and its program exists (same rules as getAllMcpServers).
 */
export async function effectiveMcpServer(
  name: string,
  cwd: string,
  settingsFile: string,
  builtinDeps?: BuiltinLookupDeps,
): Promise<MCPServerConfig | undefined> {
  const settings = loadSavedSettings(settingsFile);
  const allowProject = projectScopeAllowed(
    settings.trustProjectMcpServers,
    settings.trustedProjects,
    cwd,
  );
  const scoped = withBuiltinServers(await loadServers(cwd), settings.builtinMcpServers ?? {}, {
    allowProjectScope: allowProject,
    deps: builtinDeps,
  });
  return scoped.find(
    (s) =>
      s.config.name === name && !s.unavailableReason && (allowProject || s.scope !== "project"),
  )?.config;
}

/**
 * The built-in server `name` shows in `cwd`, when no saved entry by that name
 * loads there (same rule as `mcp list`). Includes one whose program is missing.
 */
export async function findVisibleBuiltin(
  name: string,
  cwd: string,
  settingsFile: string,
  builtinDeps?: BuiltinLookupDeps,
): Promise<ScopedServer | undefined> {
  if (!isBuiltinServerName(name)) return undefined;
  const settings = loadSavedSettings(settingsFile);
  const allowProject = projectScopeAllowed(
    settings.trustProjectMcpServers,
    settings.trustedProjects,
    cwd,
  );
  const scoped = withBuiltinServers(await loadServers(cwd), settings.builtinMcpServers ?? {}, {
    allowProjectScope: allowProject,
    deps: builtinDeps,
  });
  return scoped.find((s) => s.builtin && s.config.name === name);
}

/**
 * Hide a built-in server when it is what `name` currently shows in `cwd` (no
 * saved entry by that name loads there). True when it was hidden.
 */
export async function hideVisibleBuiltin(
  name: string,
  cwd: string,
  settingsFile: string,
  builtinDeps?: BuiltinLookupDeps,
): Promise<boolean> {
  if (!(await findVisibleBuiltin(name, cwd, settingsFile, builtinDeps))) return false;
  await removeBuiltinServer(name, settingsFile);
  return true;
}

/**
 * Delete `name` from mcp.json, or else hide the built-in it shows as.
 * `hidden` tells the app the server was only hidden, not deleted.
 */
export async function removeOrHideServer(
  name: string,
  scope: MCPScope,
  cwd: string,
  settingsFile: string,
  builtinDeps?: BuiltinLookupDeps,
): Promise<{ removed: boolean; hidden?: true }> {
  if (await removeServer(name, scope, cwd)) return { removed: true };
  if (await hideVisibleBuiltin(name, cwd, settingsFile, builtinDeps)) {
    return { removed: true, hidden: true };
  }
  return { removed: false };
}

/**
 * Bring every open window's session in line with the saved config for one
 * server, so an add/remove takes effect without a restart. Per session id:
 * what changed there, or null when nothing did. Never throws.
 */
export async function syncMcpServerAcross(
  targets: Iterable<{ id: string; cwd: string; session: AgentSession }>,
  name: string,
  settingsFile: string,
): Promise<Map<string, McpServerChange | null>> {
  // Entries keep the targets' order, not the order the sessions finish in.
  const entries = await Promise.all(
    [...targets].map(async (target): Promise<[string, McpServerChange | null]> => {
      try {
        const config = await effectiveMcpServer(name, target.cwd, settingsFile);
        return [target.id, await target.session.applyMcpServerChange(name, config)];
      } catch (err) {
        log("WARN", "app-sidecar", "mcp live sync failed", {
          name,
          message: err instanceof Error ? err.message : String(err),
        });
        return [target.id, null];
      }
    }),
  );
  return new Map(entries);
}
