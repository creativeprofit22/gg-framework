import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CheckCircle2, XCircle, Lock } from "lucide-react";
import { theme } from "./theme";
import { Modal } from "./Modal";
import { ListSkeleton } from "./Skeleton";
import {
  listMcpServers,
  addMcpServer,
  removeMcpServer,
  loginMcpServer,
  listProjects,
  subscribe,
  isMcpAuthDoneEvent,
  type McpServerRow,
  type DiscoveredProject,
  type PaneAgentClient,
  type SidecarEvent,
} from "./agent";
import { toast } from "./toast";

type McpPaneClient = Pick<
  PaneAgentClient,
  "listMcpServers" | "addMcpServer" | "loginMcpServer" | "removeMcpServer" | "subscribe"
>;

interface Props {
  onClose: () => void;
  client?: McpPaneClient;
}

const primaryMcpClient: McpPaneClient = {
  listMcpServers,
  addMcpServer,
  loginMcpServer,
  removeMcpServer,
  subscribe,
};

interface McpManagementError {
  message: string;
  retry: () => Promise<void>;
}

/**
 * MCP server manager — mirrors `ggcoder mcp`. Lists configured servers with live
 * connection status + tool counts, adds them via the same paste-a-`claude mcp
 * add …` grammar (the sidecar reuses the CLI parser verbatim), and removes them.
 *
 * Scope: Global writes to ~/.gg/mcp.json (all sessions). Project writes to a
 * chosen project's `.gg/mcp.json` — a project picker appears when Project is
 * selected, since the modal has no inherent project context. Successful changes
 * reload the pane-scoped AgentSession before the management action completes.
 */
export function McpModal({ onClose, client = primaryMcpClient }: Props): React.ReactElement {
  const [servers, setServers] = useState<McpServerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [line, setLine] = useState("");
  const [scope, setScope] = useState<"global" | "project">("global");
  const [projects, setProjects] = useState<DiscoveredProject[]>([]);
  const [projectPath, setProjectPath] = useState<string>("");
  const [busy, setBusy] = useState(false);
  // The cwd the current `servers` list was loaded with, so project-scoped rows
  // are removed from the project they were listed under.
  const [listCwd, setListCwd] = useState<string | undefined>(undefined);
  // Name of the server currently mid-login (disables its button + shows status).
  const [loggingIn, setLoggingIn] = useState<string | null>(null);
  const [managementError, setManagementError] = useState<McpManagementError | null>(null);
  const [retrying, setRetrying] = useState(false);
  const loginTargetRef = useRef<{ name: string; scope: "global" | "project" } | null>(null);

  const refresh = useCallback(
    async (cwd?: string): Promise<void> => {
      setLoading(true);
      setListCwd(cwd);
      try {
        const nextServers = await client.listMcpServers(cwd);
        setServers(nextServers);
        setManagementError(null);
      } catch (error) {
        setManagementError({
          message: error instanceof Error ? error.message : "Could not load MCP servers.",
          retry: () => refresh(cwd),
        });
      } finally {
        setLoading(false);
      }
    },
    [client],
  );

  // Stream OAuth login progress for remote MCP servers. `mcp_auth_url` opens the
  // system browser; done/error give the user clear feedback and refresh the list
  // so a freshly-authorized server flips to connected.
  useEffect(() => {
    const unsub = client.subscribe((e: SidecarEvent) => {
      const d = e.data as Record<string, unknown>;
      const name = String(d.name ?? "");
      switch (e.type) {
        case "mcp_auth_url":
          toast(`Opening your browser to sign in to "${name}"\u2026`, "info");
          void openUrl(String(d.url ?? ""));
          break;
        case "mcp_auth_done": {
          if (!isMcpAuthDoneEvent(e)) break;
          setLoggingIn(null);
          toast(`Signed in to "${e.data.name}" \u2014 ${e.data.toolCount} tools.`, "success");
          void refresh(listCwd);
          break;
        }
        case "mcp_auth_error":
          setLoggingIn(null);
          setManagementError({
            message: `Sign-in failed for "${name}". The OAuth flow did not complete. Retry sign-in.`,
            retry: () =>
              signIn(
                name,
                loginTargetRef.current?.name === name ? loginTargetRef.current.scope : "global",
              ),
          });
          break;
      }
    });
    return () => unsub();
  }, [client, refresh, listCwd]);

  // Load discovered projects (for the Project-scope picker). Done once on mount
  // so switching to Project scope shows the list instantly.
  useEffect(() => {
    void listProjects()
      .then(setProjects)
      .catch(() => {});
  }, []);

  // Re-list when the selected project changes (project servers differ per project).
  useEffect(() => {
    if (scope === "project" && projectPath) void refresh(projectPath).catch(() => {});
    if (scope === "global") void refresh().catch(() => {});
  }, [scope, projectPath, refresh]);

  async function add(): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed || busy) return;
    if (scope === "project" && !projectPath) {
      toast("Enter or pick a project path first.", "warning");
      return;
    }
    setBusy(true);
    try {
      const result = await client.addMcpServer(
        trimmed,
        scope,
        scope === "project" ? projectPath : undefined,
      );
      setLine("");
      if (result.connected) {
        toast(`Added "${result.name}" — ${result.toolCount} tools.`, "success");
      } else if (result.requiresAuth) {
        toast(`Added "${result.name}". Click "Sign in" to connect.`, "info");
      } else {
        toast(
          `Saved "${result.name}" (not connected${result.error ? `: ${result.error}` : ""}).`,
          "warning",
        );
      }
      await refresh(scope === "project" ? projectPath : undefined);
    } catch (e) {
      setManagementError({
        message: e instanceof Error ? e.message : "Could not add the MCP server.",
        retry: add,
      });
    } finally {
      setBusy(false);
    }
  }

  async function signIn(name: string, rowScope: "global" | "project"): Promise<void> {
    if (loggingIn) return;
    setLoggingIn(name);
    loginTargetRef.current = { name, scope: rowScope };
    try {
      await client.loginMcpServer(name, rowScope, rowScope === "project" ? listCwd : undefined);
      // Outcome arrives via the mcp_auth_* events above.
    } catch (e) {
      setLoggingIn(null);
      setManagementError({
        message: e instanceof Error ? e.message : "Could not start MCP sign-in.",
        retry: () => signIn(name, rowScope),
      });
    }
  }

  async function remove(name: string, rowScope: "global" | "project"): Promise<void> {
    try {
      const { removed } = await client.removeMcpServer(
        name,
        rowScope,
        rowScope === "project" ? listCwd : undefined,
      );
      if (removed) {
        toast(`Removed "${name}".`, "success");
        await refresh(listCwd);
      } else {
        toast(`No "${name}" found.`, "warning");
        setManagementError(null);
      }
    } catch (e) {
      setManagementError({
        message: e instanceof Error ? e.message : "Could not remove the MCP server.",
        retry: () => remove(name, rowScope),
      });
    }
  }

  async function retryManagementAction(): Promise<void> {
    if (!managementError || retrying) return;
    setRetrying(true);
    try {
      await managementError.retry();
    } finally {
      setRetrying(false);
    }
  }

  // Only show servers for the selected scope — loadServers merges global +
  // project, so without this a project-scoped row could surface in the Global
  // view and its delete would have no project cwd to target. The toggle selects
  // which scope you're managing.
  const visible = servers.filter((s) => s.scope === scope);

  return (
    <Modal title="MCP servers" onClose={onClose}>
      {managementError && (
        <div
          className="login-status"
          role="alert"
          aria-live="assertive"
          style={{
            color: theme.error,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            marginBottom: 12,
          }}
        >
          <span>{managementError.message}</span>
          <button
            className="modal-btn"
            style={{ flexShrink: 0, whiteSpace: "nowrap", wordBreak: "normal" }}
            disabled={retrying}
            onClick={() => void retryManagementAction()}
          >
            {retrying ? "Retrying…" : "Retry"}
          </button>
        </div>
      )}

      {loading && servers.length === 0 ? (
        <ListSkeleton rows={3} />
      ) : visible.length === 0 ? (
        !managementError && (
          <div className="mcp-empty" style={{ color: theme.textMuted }}>
            No MCP’s configured.
          </div>
        )
      ) : (
        <div className="mcp-list" aria-busy={loading}>
          {visible.map((s) => (
            <div className="mcp-item" key={`${s.scope}:${s.name}`}>
              <span
                className="mcp-dot"
                style={{
                  color: s.ok ? theme.success : s.requiresAuth ? theme.warning : theme.error,
                }}
              >
                {s.ok ? (
                  <CheckCircle2 size={15} />
                ) : s.requiresAuth ? (
                  <Lock size={14} />
                ) : (
                  <XCircle size={15} />
                )}
              </span>
              <span className="mcp-name" style={{ color: theme.text }} title={s.summary}>
                {s.name}
              </span>
              {s.ok ? (
                <span className="mcp-meta" style={{ color: theme.textDim }}>
                  {`${s.toolCount} tool${s.toolCount === 1 ? "" : "s"}`}
                </span>
              ) : s.requiresAuth ? (
                <span className="mcp-meta" style={{ color: theme.warning }}>
                  Requires login
                </span>
              ) : null}
              {s.requiresAuth && !s.ok && (
                <button
                  className="modal-btn primary"
                  style={{ padding: "2px 12px", fontSize: 12 }}
                  disabled={loggingIn === s.name}
                  title={`Sign in to "${s.name}"`}
                  onClick={() => void signIn(s.name, s.scope)}
                >
                  {loggingIn === s.name ? "Signing in\u2026" : "Sign in"}
                </button>
              )}
              <button
                className="mcp-delete"
                style={{ color: theme.textDim }}
                title={`Remove "${s.name}"`}
                onClick={() => void remove(s.name, s.scope)}
              >
                {"\u00d7"}
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="modal-label" style={{ color: theme.textMuted, marginTop: 4 }}>
        Add an MCP
      </div>
      <input
        className="modal-input"
        style={{ color: theme.text, background: theme.inputBackground, width: "100%" }}
        value={line}
        placeholder="claude mcp add --transport http notion https://mcp.notion.com/mcp"
        autoFocus
        onChange={(e) => setLine(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void add();
        }}
      />
      <div className="mcp-scope-toggle">
        <button
          className={`modal-btn${scope === "global" ? " primary" : ""}`}
          onClick={() => setScope("global")}
        >
          Global
        </button>
        <button
          className={`modal-btn${scope === "project" ? " primary" : ""}`}
          onClick={() => setScope("project")}
        >
          Project
        </button>
      </div>
      {scope === "project" && (
        <>
          <input
            className="modal-input"
            style={{
              color: projectPath ? theme.text : theme.textMuted,
              background: theme.inputBackground,
              width: "100%",
              marginTop: 10,
            }}
            value={projectPath}
            placeholder="Type a project path or pick below…"
            list="mcp-project-paths"
            onChange={(e) => setProjectPath(e.target.value)}
          />
          <datalist id="mcp-project-paths">
            {projects.map((p) => (
              <option key={p.path} value={p.path}>
                {p.name}
              </option>
            ))}
          </datalist>
        </>
      )}

      <div className="modal-hint" style={{ color: theme.textDim, marginTop: 12 }}>
        New servers load on next app restart.
      </div>

      <div className="modal-actions">
        <button className="modal-btn" onClick={onClose}>
          Close
        </button>
        <button
          className="modal-btn primary"
          disabled={!line.trim() || busy}
          onClick={() => void add()}
        >
          {busy ? "Adding\u2026" : "Add"}
        </button>
      </div>
    </Modal>
  );
}
