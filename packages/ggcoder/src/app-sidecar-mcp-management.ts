/** Fixed, user-facing MCP management route failures. Keep raw errors in sidecar logs;
 * never turn them into successful empty/false responses or expose provider details. */
export type McpManagementRouteAction = "list" | "add" | "remove" | "login";

export interface McpManagementRouteFailure {
  status: 500;
  error: string;
}

export function mcpManagementRouteFailure(
  action: McpManagementRouteAction,
  cause: unknown,
): McpManagementRouteFailure {
  const raw = cause instanceof Error ? cause.message : String(cause);
  if (/MCP config.+malformed/i.test(raw)) {
    return {
      status: 500,
      error: "An MCP config file is malformed. Fix it, then retry.",
    };
  }
  const errors: Record<McpManagementRouteAction, string> = {
    list: "Could not load MCP servers. Try again.",
    add: "Could not add the MCP server. Check the command and try again.",
    remove: "Could not remove the MCP server. Try again.",
    login: "Could not start MCP sign-in. Try again.",
  };
  return { status: 500, error: errors[action] };
}
