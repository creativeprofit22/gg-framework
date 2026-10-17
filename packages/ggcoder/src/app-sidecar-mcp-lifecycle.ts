export interface ReloadableMcpSession {
  reloadMcpServers(): Promise<void>;
}

/**
 * Commit one persisted desktop MCP mutation, then refresh the owning logical
 * session before the route/event reports completion. Resolve the session after
 * persistence so a concurrent pane lifecycle change cannot reload a stale
 * temporary AgentSession.
 */
export async function applyDesktopMcpMutation<T>(
  getSession: () => ReloadableMcpSession,
  mutation: () => Promise<T>,
  shouldReload: (result: T) => boolean = () => true,
): Promise<T> {
  const result = await mutation();
  if (shouldReload(result)) await getSession().reloadMcpServers();
  return result;
}
