import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  Client,
  OAuthError,
  OAuthErrorCode,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  SSEClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import type { ElicitRequest, ElicitResult } from "@modelcontextprotocol/client";
import type { AgentTool, ToolContext, ToolExecuteResult } from "@kenkaiiii/gg-agent";
import { z } from "zod";
import http from "node:http";
import os from "node:os";
import { log } from "../logger.js";
import type { MCPServerConfig } from "./types.js";
import {
  McpOAuthProvider,
  MCP_OAUTH_CALLBACK_PORT,
  MCP_OAUTH_CALLBACK_PATH,
} from "./oauth-provider.js";
import { McpOAuthStore } from "./oauth-store.js";
import { isLocalhost, alternateLoopback, isNetworkError } from "./loopback.js";
import { toToolResult } from "./content.js";
import { resolveStdioCommand } from "./resolve-stdio.js";
import { McpCatalogCache, type ProtocolEra } from "./catalog-cache.js";
import {
  createMcpToolIdentity,
  dedupeMcpToolDefinitions,
  getMcpToolIdentity,
  withMcpToolIdentity,
} from "./tool-identity.js";
import {
  isShareableServer,
  sharedMcpPool,
  type SharedMcpPool,
  type SharedServerHandle,
} from "./shared-pool.js";

interface ConnectedServer {
  name: string;
  client: Client;
  transport: StreamableHTTPClientTransport | SSEClientTransport | StdioClientTransport;
  lastCallTime: number;
  /** The config this exact connection was built from. Tool wrappers are bound to
   * this object so replacing the connection makes every captured wrapper stale. */
  config: MCPServerConfig;
}

export type MCPServerConnectionStatus = "connected" | "disconnected" | "recovering";

/** Live lifecycle update. Connected updates carry only freshly listed, identity-checked tools. */
export interface MCPServerStateChange {
  name: string;
  status: MCPServerConnectionStatus;
  tools: AgentTool[];
  error?: string;
}

/** Per-server connection outcome for the dashboard / non-interactive list. */
export interface MCPConnectResult {
  name: string;
  ok: boolean;
  toolCount: number;
  tools: AgentTool[];
  error?: string;
  /** True when the server returned 401/Unauthorized and an OAuth login is
   *  required before it can connect. The UI surfaces this as "requires login". */
  requiresAuth?: boolean;
}

/** Outcome of an interactive remote-MCP OAuth login. */
export interface MCPLoginResult {
  ok: boolean;
  toolCount: number;
  error?: string;
}

/** Terminal state of one server's connection attempt, awaited by `whenConnected`. */
type ConnectionOutcome = { ok: true } | { ok: false; error: string };

/**
 * Apply the same fail-closed source-identity and exact-name duplicate rules to
 * every listTools result, including temporary OAuth verification clients.
 */
function identifyUsableMcpTools<T extends { name: string }>(
  serverName: string,
  tools: readonly T[],
): Array<{ tool: T; identity: ReturnType<typeof createMcpToolIdentity> }> {
  return dedupeMcpToolDefinitions(tools).flatMap((tool) => {
    try {
      return [{ tool, identity: createMcpToolIdentity(serverName, tool.name) }];
    } catch (err) {
      log("WARN", "mcp", "MCP server declared an invalid tool identity; omitting tool", {
        serverName,
        toolName: tool.name,
        message: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  });
}

/**
 * A server-initiated request for user input, mid tool call. The host resolves
 * it by showing the user a form built from `requestedSchema` and returning
 * their answer — or `decline` / `cancel`.
 */
export interface MCPElicitation {
  /** Which configured server is asking. */
  server: string;
  /** Human-readable prompt from the server. */
  message: string;
  /** JSON Schema object describing the fields to collect. */
  requestedSchema: Record<string, unknown>;
}

export type MCPElicitHandler = (request: MCPElicitation) => Promise<ElicitResult>;

export interface MCPClientManagerOptions {
  catalogCache?: McpCatalogCache;
  modernProtocol?: boolean;
  onElicit?: MCPElicitHandler;
  sharedPool?: SharedMcpPool;
  onServerClosed?: (name: string) => void;
  /** Synchronous lifecycle hook: owners remove tools on disconnected/recovering
   * and publish only the fresh wrappers supplied with connected. */
  onServerStateChange?: (change: MCPServerStateChange) => void;
}

export class MCPClientManager {
  private servers: ConnectedServer[] = [];
  /**
   * Per-server connection settlement, so a caller holding a cached-only tool
   * can wait for the live client instead of failing or hanging forever.
   */
  private connections = new Map<
    string,
    { promise: Promise<ConnectionOutcome>; settle: (outcome: ConnectionOutcome) => void }
  >();

  /**
   * In-flight session rebuilds, keyed by server name. N tool calls to the same
   * server all 404 at once when its session expires; without coalescing each
   * would spawn its own reconnect and they would race to replace each other in
   * `this.servers`. Sharing one promise means exactly one reconnect per outage.
   */
  private reconnecting = new Map<string, Promise<void>>();

  /**
   * Claims on process-wide shared connections, keyed by server name. Held so
   * `dispose` can hand them back: the pooled child only exits once the LAST
   * manager holding it releases, so leaking a claim here would pin the process
   * for the daemon's lifetime — the exact bug sharing is meant to fix.
   */
  private sharedHandles = new Map<string, SharedServerHandle>();

  private readonly catalogCache: McpCatalogCache;
  /**
   * Opt into the 2026-07-28 revision. Off by default: `mode: "auto"` probes with
   * `server/discover` before falling back to `initialize`, and a legacy stdio
   * server that ignores pre-`initialize` requests pays the full probe timeout.
   */
  private readonly modernProtocol: boolean;

  /**
   * Host callback for server-initiated `elicitation/create`. Absent means we
   * declare no elicitation capability at all — which is protocol-legal and is
   * how the CLI runs, since it has nowhere to render the form.
   */
  private readonly onElicit?: MCPElicitHandler;

  /**
   * Pool backing `shared: true` servers. Defaults to the daemon-wide singleton;
   * injectable so tests can exercise sharing without touching global state.
   */
  private readonly pool: SharedMcpPool;

  /**
   * Fired when a connected server's transport closes on its own — a crashed or
   * exited child, not our own `dispose`. The pool uses it to drop a dead
   * connection so the next session rebuilds instead of inheriting a corpse.
   */
  private readonly onServerClosed?: (name: string) => void;
  private readonly onServerStateChange?: (change: MCPServerStateChange) => void;

  /** Set while `dispose` runs, so our own teardown is not reported as a death. */
  private disposing = false;

  constructor(opts: MCPClientManagerOptions = {}) {
    this.catalogCache = opts.catalogCache ?? new McpCatalogCache();
    this.modernProtocol = opts.modernProtocol ?? false;
    this.onElicit = opts.onElicit;
    this.pool = opts.sharedPool ?? sharedMcpPool;
    this.onServerClosed = opts.onServerClosed;
    this.onServerStateChange = opts.onServerStateChange;
  }

  /**
   * Build a `Client` for one server, declaring elicitation support and wiring
   * the handler when the host can actually prompt the user.
   *
   * Form mode only. URL mode would have us open a browser tab in the middle of
   * a tool call with no user gesture behind it — the SDK rejects URL-mode
   * requests for us when the `url` capability is undeclared.
   */
  private createClient(serverName: string, negotiate: NegotiationOptions): Client {
    const handler = this.onElicit;
    if (!handler) return new Client({ name: "ggcoder", version: "1.0.0" }, negotiate);

    const client = new Client(
      { name: "ggcoder", version: "1.0.0" },
      { ...negotiate, capabilities: { elicitation: { form: {} } } },
    );
    client.setRequestHandler("elicitation/create", async (request: ElicitRequest) => {
      const params = request.params;
      if (params.mode === "url") {
        // Unreachable while `url` stays undeclared, but a server that ignores
        // capabilities must get a clean decline rather than a thrown handler.
        return { action: "decline" } satisfies ElicitResult;
      }
      return handler({
        server: serverName,
        message: params.message,
        requestedSchema: params.requestedSchema as Record<string, unknown>,
      });
    });
    return client;
  }

  /**
   * Version-negotiation options for a real (non-probe) connect. `probe()` is
   * spawn-per-invocation and deliberately never negotiates: a legacy stdio
   * server that ignores the discovery request would stall it for the whole
   * probe timeout, turning "validate this server" into a 30s hang.
   *
   * The probe timeout is transport-aware because the SDK's timeout VERDICT is:
   *
   * - **stdio** — silence on a local pipe means a legacy server, and the SDK
   *   falls back to `initialize`. The probe runs on a disposable sibling
   *   process, so the fallback is clean. Waiting the full connect timeout to
   *   reach a conclusion we can draw in seconds is pure dead time, so cap it
   *   short.
   * - **HTTP** — silence means an outage, and the SDK REJECTS the connect
   *   rather than falling back. A short timeout would therefore turn a slow
   *   cold start into a hard connection failure, so inherit the full connect
   *   timeout and let the normal timeout handling deal with a real outage.
   */
  private negotiationOptions(transport: "stdio" | "http"): NegotiationOptions {
    if (!this.modernProtocol) return {};
    return {
      versionNegotiation: {
        mode: "auto",
        ...(transport === "stdio" ? { probe: { timeoutMs: STDIO_PROBE_TIMEOUT_MS } } : {}),
      },
    };
  }

  /**
   * Claim the pooled connection for a shared server and adopt its tools.
   *
   * Shaped like `connectServer` (resolve tools / throw on failure) so the
   * caller's `allSettled` handling is identical for both kinds. The pool
   * reports failure in-band, so it is rethrown here with the message the pool
   * already formatted.
   */
  private async connectShared(config: MCPServerConfig): Promise<AgentTool[]> {
    const handle = await this.pool.acquire(
      config,
      // The pooled connection is just another manager with sharing switched
      // off, so it takes the normal connect path instead of recursing into the
      // pool. Its elicit handler is the pool's dispatcher, NOT this session's:
      // the connection is shared, so each request has to be routed to whichever
      // session actually provoked it.
      (opts) => {
        const manager = new MCPClientManager({
          catalogCache: opts.catalogCache,
          modernProtocol: opts.modernProtocol,
          onElicit: opts.onElicit,
          sharedPool: this.pool,
          // Let the pool retire this connection if its server exits, while every
          // current claimant removes the dead stdio server's tools immediately.
          onServerClosed: opts.onClosed,
          onServerStateChange: opts.onServerStateChange,
        });
        return {
          connect: async (target) => {
            const [result] = await manager.connectAllDetailed([{ ...target, shared: false }]);
            return (
              result ?? {
                name: target.name,
                ok: false,
                toolCount: 0,
                tools: [],
                error: "connection produced no result",
              }
            );
          },
          dispose: () => manager.dispose(),
        };
      },
      {
        catalogCache: this.catalogCache,
        modernProtocol: this.modernProtocol,
        onElicit: this.onElicit,
        onServerStateChange: this.onServerStateChange,
      },
    );
    if (!handle.result.ok) {
      // Nothing was claimed on a failed connect, but releasing is idempotent
      // and keeps this path honest if that ever changes.
      await handle.release();
      throw new Error(handle.result.error ?? "connection failed");
    }
    this.sharedHandles.set(config.name, handle);

    // Wrap each pooled tool so a call from THIS session is attributable while
    // it runs. The pool needs that to answer "which window asked?" when the
    // server elicits mid-call; without it a shared server could only ever
    // cancel its prompts.
    return handle.result.tools.map((tool) => {
      const wrapped: AgentTool = {
        ...tool,
        execute: async (args: unknown, context?: ToolContext) => {
          const endCall = handle.beginCall();
          try {
            return await tool.execute(args, context as ToolContext);
          } finally {
            endCall();
          }
        },
      };
      const identity = getMcpToolIdentity(tool);
      return identity ? withMcpToolIdentity(wrapped, identity) : wrapped;
    });
  }

  /** Get-or-create the settlement record for one server name. */
  private connectionSlot(name: string): {
    promise: Promise<ConnectionOutcome>;
    settle: (outcome: ConnectionOutcome) => void;
  } {
    const existing = this.connections.get(name);
    if (existing) return existing;
    let settle!: (outcome: ConnectionOutcome) => void;
    const promise = new Promise<ConnectionOutcome>((resolve) => {
      settle = resolve;
    });
    const slot = { promise, settle };
    this.connections.set(name, slot);
    return slot;
  }

  /**
   * Resolve once a server's connection attempt has settled. Returns `ok:false`
   * with the failure reason when that server could not connect, and times out
   * rather than hanging when no attempt is ever made (e.g. a server that was
   * removed from the config since the catalog cache was written).
   */
  async whenConnected(name: string, timeoutMs = 30_000): Promise<ConnectionOutcome> {
    if (this.servers.some((server) => server.name === name)) return { ok: true };
    const slot = this.connectionSlot(name);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ConnectionOutcome>((resolve) => {
      timer = setTimeout(
        () => resolve({ ok: false, error: `timed out after ${timeoutMs}ms` }),
        timeoutMs,
      );
      timer.unref?.();
    });
    try {
      return await Promise.race([slot.promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async connectAll(configs: MCPServerConfig[]): Promise<AgentTool[]> {
    const results = await this.connectAllDetailed(configs);
    return results.flatMap((r) => r.tools);
  }

  /**
   * Connect every enabled server and return one result per server (success →
   * ok + toolCount; failure → ok:false with a human-readable error string).
   * Keeps successfully connected servers in `this.servers`.
   *
   * Shareable servers — stdio, unless opted out with `shared: false` — are not
   * connected here at all: they are claimed from the process-wide pool, so every
   * session in the daemon multiplexes over one child process instead of spawning
   * its own. The split is invisible to callers — results and tools come back in
   * the same shape, `whenConnected` settles for both kinds, and `dispose`
   * releases the pooled claims — so sharing applies wherever a manager is used
   * (sessions, CLI, subagents) without each call site opting in.
   */
  async connectAllDetailed(configs: MCPServerConfig[]): Promise<MCPConnectResult[]> {
    const enabled = configs.filter((c) => c.enabled !== false);
    if (enabled.length === 0) return [];

    // Claim a settlement slot for every server up front, so a `whenConnected`
    // caller that arrives before a slow server's turn still waits on the right
    // promise instead of creating a second one.
    for (const config of enabled) this.connectionSlot(config.name);

    const settled = await Promise.allSettled(
      enabled.map((c) => (isShareableServer(c) ? this.connectShared(c) : this.connectServer(c))),
    );

    const results: MCPConnectResult[] = settled.map((result, i) => {
      const name = enabled[i].name;
      if (result.status === "fulfilled") {
        return { name, ok: true, toolCount: result.value.length, tools: result.value };
      }
      const requiresAuth = isUnauthorized(result.reason);
      const error = requiresAuth ? "Requires login." : formatConnectError(result.reason);
      log("WARN", "mcp", `Failed to connect to MCP server "${name}"`, { error });
      return { name, ok: false, toolCount: 0, tools: [], error, requiresAuth };
    });

    // Release anyone waiting on a cached-only tool from these servers.
    for (const result of results) {
      this.connectionSlot(result.name).settle(
        result.ok ? { ok: true } : { ok: false, error: result.error ?? "connection failed" },
      );
    }

    const connected = results.filter((r) => r.ok).length;
    const toolCount = results.reduce((sum, r) => sum + r.toolCount, 0);
    log("INFO", "mcp", `Connected ${connected} MCP server(s), ${toolCount} tool(s)`);
    return results;
  }

  /**
   * Connect a single server, list its tools, then close that client so the
   * probe connection doesn't accumulate in `this.servers`. Used to validate a
   * server before persisting it.
   */
  async probe(config: MCPServerConfig): Promise<MCPConnectResult> {
    try {
      const tools = await this.connectServer(config, { probe: true });
      const server = this.servers.find((s) => s.name === config.name);
      if (server) {
        this.servers = this.servers.filter((s) => s !== server);
        try {
          await server.client.close();
        } catch {
          // Ignore close errors during probe teardown.
        }
      }
      return { name: config.name, ok: true, toolCount: tools.length, tools };
    } catch (err) {
      const requiresAuth = isUnauthorized(err);
      const error = requiresAuth ? "Requires login." : formatConnectError(err);
      return { name: config.name, ok: false, toolCount: 0, tools: [], error, requiresAuth };
    }
  }

  /**
   * Run the interactive OAuth login for one remote MCP server end-to-end:
   * start a loopback callback server, let the SDK open the browser via
   * `onAuthorizationUrl`, capture the redirect, exchange the code, then verify
   * the authorized connection by listing tools. Tokens are persisted by the
   * provider so later (non-interactive) connects succeed silently.
   *
   * `onAuthorizationUrl` is invoked with the authorize URL so the host can open
   * it (the gg-app broadcasts it to the webview, which opens the system
   * browser; the CLI prints it). Never throws — returns `{ ok:false, error }`.
   */
  async login(
    config: MCPServerConfig,
    onAuthorizationUrl: (url: string) => void,
    timeoutMs = 180_000,
  ): Promise<MCPLoginResult> {
    if (!config.url) {
      return { ok: false, toolCount: 0, error: "Login is only supported for HTTP MCP servers." };
    }
    const url = new URL(config.url);
    const store = new McpOAuthStore();
    // Fresh PKCE/state for this attempt so a previous half-finished login can't
    // poison the exchange.
    await store.patch(config.name, { codeVerifier: undefined, state: undefined });

    // The whole callback query string, not just `code`: v2's finishAuth reads
    // `iss` from it and validates the issuer (RFC 9207) before redeeming the
    // code, which is the defense against an authorization-server mix-up.
    let codeResolve: ((params: URLSearchParams) => void) | undefined;
    let codeReject: ((err: Error) => void) | undefined;
    const codePromise = new Promise<URLSearchParams>((resolve, reject) => {
      codeResolve = resolve;
      codeReject = reject;
    });

    const provider = new McpOAuthProvider({
      serverName: config.name,
      store,
      onRedirect: (authUrl) => onAuthorizationUrl(authUrl.toString()),
    });
    const expectedState = await provider.state();

    // Loopback server that receives the OAuth redirect. Bound to the fixed
    // callback port that the registered redirect_uri points at.
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url || "", `http://localhost:${MCP_OAUTH_CALLBACK_PORT}`);
      if (reqUrl.pathname !== MCP_OAUTH_CALLBACK_PATH) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      const err = reqUrl.searchParams.get("error");
      const code = reqUrl.searchParams.get("code");
      const state = reqUrl.searchParams.get("state");
      res.writeHead(200, { "Content-Type": "text/html" });
      if (err) {
        res.end(`<html><body><h1>Login failed</h1><p>${escapeHtml(err)}</p></body></html>`);
        codeReject?.(new Error(`Authorization failed: ${err}`));
        return;
      }
      if (!code) {
        res.end("<html><body><h1>Login failed</h1><p>No authorization code.</p></body></html>");
        codeReject?.(new Error("No authorization code in callback."));
        return;
      }
      if (state !== expectedState) {
        res.end("<html><body><h1>Login failed</h1><p>State mismatch.</p></body></html>");
        codeReject?.(new Error("OAuth state mismatch."));
        return;
      }
      res.end(
        "<html><body><h1>Login successful!</h1><p>You can close this tab and return to GG Coder.</p></body></html>",
      );
      codeResolve?.(reqUrl.searchParams);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(MCP_OAUTH_CALLBACK_PORT, "127.0.0.1", () => resolve());
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const hint =
        msg.includes("EADDRINUSE") || msg.includes("in use")
          ? `Port ${MCP_OAUTH_CALLBACK_PORT} is in use — close whatever is using it and retry.`
          : msg;
      return { ok: false, toolCount: 0, error: `Could not start login callback server: ${hint}` };
    }

    const overallTimeout = setTimeout(() => {
      codeReject?.(new Error("Login timed out waiting for the browser callback."));
    }, timeoutMs);
    overallTimeout.unref();

    try {
      // First connect triggers the redirect (browser opens) then throws
      // UnauthorizedError — that's the expected, not a failure.
      const loginTransport = new StreamableHTTPClientTransport(url, {
        requestInit: config.headers ? { headers: config.headers } : undefined,
        authProvider: provider,
      });
      const loginClient = new Client({ name: "ggcoder", version: "1.0.0" });
      try {
        await loginClient.connect(loginTransport);
        // Already authorized (had valid tokens) — nothing more to do.
        const { tools } = await loginClient.listTools();
        const toolCount = identifyUsableMcpTools(config.name, tools).length;
        await loginClient.close().catch(() => {});
        return { ok: true, toolCount };
      } catch (err) {
        if (!isUnauthorized(err)) throw err;
      }

      const callbackParams = await codePromise;
      // Exchange the code for tokens (persisted via provider.saveTokens).
      await loginTransport.finishAuth(callbackParams);
      await loginClient.close().catch(() => {});

      // Verify the authorized connection on a fresh transport + list tools.
      const verifyTransport = new StreamableHTTPClientTransport(url, {
        requestInit: config.headers ? { headers: config.headers } : undefined,
        authProvider: provider,
      });
      const verifyClient = new Client({ name: "ggcoder", version: "1.0.0" });
      await verifyClient.connect(verifyTransport);
      const { tools } = await verifyClient.listTools();
      const toolCount = identifyUsableMcpTools(config.name, tools).length;
      await verifyClient.close().catch(() => {});
      return { ok: true, toolCount };
    } catch (err) {
      return { ok: false, toolCount: 0, error: formatConnectError(err) };
    } finally {
      clearTimeout(overallTimeout);
      server.close();
      // Clear the now-consumed in-flight PKCE/state so the store only keeps tokens.
      await store.patch(config.name, { codeVerifier: undefined, state: undefined });
    }
  }

  private async connectServer(
    config: MCPServerConfig,
    opts: { probe?: boolean } = {},
  ): Promise<AgentTool[]> {
    const timeout = config.timeout ?? 30_000;
    // `command` is what actually selects the stdio path further down.
    const negotiate: NegotiationOptions = opts.probe
      ? {}
      : this.negotiationOptions(config.command ? "stdio" : "http");
    // A server we already know speaks the 2025 handshake skips the discovery
    // probe entirely. Only the legacy verdict is reusable from an era string:
    // adopting a 'modern' verdict needs the full DiscoverResult, so those still
    // probe (a modern server answers immediately, so that costs nothing).
    const prior =
      "versionNegotiation" in negotiate && (await this.cachedEra(config)) === "legacy"
        ? ({ kind: "legacy" } as const)
        : undefined;
    const connectOptions = { timeout, ...(prior ? { prior } : {}) };
    let client: Client;
    let transport: StreamableHTTPClientTransport | SSEClientTransport | StdioClientTransport;

    if (config.command) {
      // Stdio transport for local processes.
      // cwd is forced to homedir so the user's working directory can't
      // affect resolution. e.g. running ggcoder from a folder whose
      // package.json names the same package as the MCP server makes
      // `npx -y <pkg>` self-resolve to the local source (no built bin
      // shim) and fail with "command not found".
      //
      // For an `npx -y <pkg>` of a package that ships as a ggcoder dependency
      // rewrite to a direct
      // `node <binScript>` invocation. `npx` otherwise spawns a ~100 MB Node
      // wrapper whose only job is to resolve+launch the real server, doubling
      // memory per connection. Non-resolvable / non-npx commands pass through
      // unchanged. Mirrors the LSP `process.execPath`+bin pattern.
      const resolved = resolveStdioCommand(config.command, config.args);
      transport = new StdioClientTransport({
        command: resolved.command,
        args: resolved.args,
        env: { ...process.env, ...config.env } as Record<string, string>,
        cwd: os.homedir(),
        stderr: "pipe",
      });
      // Capture stderr so a crashing server doesn't fail silently — when the
      // child closes the pipe before completing handshake, the SDK throws
      // the opaque "-32000 Connection closed" but the real cause (stack
      // trace, missing dep, port conflict) was just printed to stderr.
      const stderrChunks: string[] = [];
      transport.stderr?.on("data", (chunk: Buffer | string) => {
        stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      });
      client = this.createClient(config.name, negotiate);
      try {
        await client.connect(transport, connectOptions);
      } catch (err) {
        const stderr = stderrChunks.join("").slice(-4000);
        if (stderr.trim()) {
          log("WARN", "mcp", `stdio child stderr for "${config.name}"`, { stderr });
        }
        throw err;
      }
    } else {
      // HTTP transport (Streamable HTTP or SSE). See connectHttp for the
      // transport-selection + auth logic.
      const url = new URL(config.url!);
      const isLocal = isLocalhost(url);

      try {
        const r = await this.connectHttp(url, config, isLocal, negotiate, connectOptions);
        client = r.client;
        transport = r.transport;
      } catch (err) {
        // Windows 11 resolves `localhost` → ::1 (IPv6) first; if the server
        // binds IPv4-only (127.0.0.1) the first fetch gets ECONNREFUSED.
        // Retry once with the alternate loopback hostname. macOS resolves
        // both stacks so this only bites Windows/Linux in practice.
        const alt = isLocal ? alternateLoopback(url.hostname) : undefined;
        if (!alt || !isNetworkError(err)) throw err;
        log("INFO", "mcp", `localhost connect failed for "${config.name}", retrying as ${alt}`, {
          error: String(err),
        });
        const altUrl = new URL(url);
        altUrl.hostname = alt;
        const r = await this.connectHttp(altUrl, config, isLocal, negotiate, connectOptions);
        client = r.client;
        transport = r.transport;
      }
    }

    const connectedServer: ConnectedServer = {
      name: config.name,
      client,
      transport,
      lastCallTime: 0,
      config,
    };
    this.servers.push(connectedServer);

    // A close retires this exact generation synchronously. HTTP connections then
    // recover in the background; stdio stays failed closed and is never respawned.
    client.onclose = () => this.handleUnexpectedClose(connectedServer);

    let listedTools: Awaited<ReturnType<Client["listTools"]>>["tools"];
    try {
      ({ tools: listedTools } = await client.listTools(undefined, { timeout }));
    } catch (err) {
      this.removeServer(connectedServer);
      try {
        await client.close();
      } catch {
        // The failed handshake/list may already have closed the transport.
      }
      throw err;
    }
    const identifiedTools = identifyUsableMcpTools(config.name, listedTools);

    // Persist the live tool list so the NEXT cold start can answer tool_search
    // before this server has finished connecting. A cache failure cannot fail a
    // healthy live connection.
    try {
      await this.catalogCache.save(
        config,
        identifiedTools.map(({ tool, identity }) => ({
          toolName: identity.toolName,
          description: tool.description ?? "",
          rawInputSchema: tool.inputSchema as Record<string, unknown> | undefined,
        })),
        this.negotiatedEra(client),
      );
    } catch {
      // Cache is an optimization; a connected server is still fully usable.
    }

    const freshTools = identifiedTools.map(({ tool, identity }): AgentTool => {
      const agentTool: AgentTool = {
        name: identity.providerName,
        description: tool.description ?? "",
        parameters: z.record(z.string(), z.unknown()),
        rawInputSchema: tool.inputSchema as Record<string, unknown>,
        execute: async (args, context) => {
          // Never redirect an old wrapper to a replacement client. Tool schemas
          // and source identity belong to one listed connection generation.
          if (!this.servers.includes(connectedServer)) {
            throw new Error(
              `MCP tool error: stale tool wrapper for disconnected server "${config.name}"`,
            );
          }

          const elapsed = Date.now() - connectedServer.lastCallTime;
          const minGap = 2_000;
          if (elapsed < minGap) {
            await new Promise((resolve) => setTimeout(resolve, minGap - elapsed));
          }
          if (!this.servers.includes(connectedServer)) {
            throw new Error(
              `MCP tool error: stale tool wrapper for disconnected server "${config.name}"`,
            );
          }
          connectedServer.lastCallTime = Date.now();

          try {
            const result = await connectedServer.client.callTool(
              { name: identity.toolName, arguments: args as Record<string, unknown> },
              { timeout: config.timeout ?? 60_000 },
            );
            if (!("content" in result) || !Array.isArray(result.content)) {
              return result.isError
                ? ({ content: "(empty response)", isError: true } as ToolExecuteResult)
                : "(empty response)";
            }
            const toolResult = await toToolResult(result.content, identity.providerName);
            if (!result.isError) return toolResult;
            return typeof toolResult === "string"
              ? ({ content: toolResult, isError: true } as ToolExecuteResult)
              : ({ ...toolResult, isError: true } as ToolExecuteResult);
          } catch (err) {
            // HTTP session expiry/closure starts a fresh publication cycle, but
            // this active call is never replayed: doing so could duplicate work.
            if (this.canRecoverSession(config, err, context?.signal)) {
              this.disconnectServer(connectedServer, err);
            }
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("Too Many R") || msg.includes("429")) {
              throw new Error(
                "Rate limited — too many requests. Wait a moment before searching again.",
                {
                  cause: err,
                },
              );
            }
            throw new Error(`MCP tool error: ${msg}`, { cause: err });
          }
        },
      };
      return withMcpToolIdentity(agentTool, identity);
    });

    if (!opts.probe && this.servers.includes(connectedServer)) {
      this.onServerStateChange?.({
        name: config.name,
        status: "connected",
        tools: freshTools,
      });
    }
    return freshTools;
  }

  /** Is this failure a recoverable HTTP session loss? Never recover cancelled work or stdio. */
  private canRecoverSession(
    config: MCPServerConfig,
    err: unknown,
    signal: AbortSignal | undefined,
  ): boolean {
    if (config.command || signal?.aborted) return false;
    return isSessionExpired(err) || this.isConnectionClosed(err);
  }

  /** A local "the transport went away mid-request" failure, as the SDK reports it. */
  private isConnectionClosed(reason: unknown): boolean {
    return SdkError.isInstance(reason) && reason.code === SdkErrorCode.ConnectionClosed;
  }

  private removeServer(server: ConnectedServer): boolean {
    if (!this.servers.includes(server)) return false;
    this.servers = this.servers.filter((candidate) => candidate !== server);
    return true;
  }

  private handleUnexpectedClose(server: ConnectedServer): void {
    if (this.disposing || !this.servers.includes(server)) return;
    log("WARN", "mcp", `MCP server "${server.name}" closed unexpectedly`);
    this.disconnectServer(server, new Error("Connection closed"));
  }

  /** Retire one exact connection before any await, then recover HTTP only. */
  private disconnectServer(server: ConnectedServer, reason: unknown): void {
    if (!this.removeServer(server)) return;
    const error = formatConnectError(reason);
    this.onServerStateChange?.({ name: server.name, status: "disconnected", tools: [], error });
    this.onServerClosed?.(server.name);

    if (server.config.command || this.disposing) return;
    this.onServerStateChange?.({ name: server.name, status: "recovering", tools: [] });
    void server.client.close().catch(() => {});
    void this.recoverServer(server.config);
  }

  /** Coalesce recovery, publishing only wrappers listed from the replacement client. */
  private recoverServer(config: MCPServerConfig): Promise<void> {
    const inFlight = this.reconnecting.get(config.name);
    if (inFlight) return inFlight;

    const attempt = Promise.resolve()
      .then(async () => {
        log("INFO", "mcp", `Recovering MCP server "${config.name}"`);
        await this.connectServer(config);
      })
      .catch((err) => {
        const error = formatConnectError(err);
        log("WARN", "mcp", `MCP recovery failed for "${config.name}"`, { error });
        this.onServerStateChange?.({
          name: config.name,
          status: "disconnected",
          tools: [],
          error,
        });
      })
      .finally(() => {
        this.reconnecting.delete(config.name);
      });
    this.reconnecting.set(config.name, attempt);
    return attempt;
  }

  /**
   * Connect a single HTTP (Streamable HTTP or SSE) server and return the live
   * client + transport. Transport selection:
   * - `transport === "sse"` → legacy SSE directly (Playwright MCP `--port`).
   * - otherwise → Streamable HTTP first, SSE fallback for older servers.
   *
   * An OAuth provider is attached only for REMOTE servers — localhost never
   * needs OAuth and attaching it there is dead weight that can misdiagnose a
   * protocol mismatch as a login requirement.
   */
  private async connectHttp(
    url: URL,
    config: MCPServerConfig,
    isLocal: boolean,
    negotiate: NegotiationOptions,
    connectOptions: { timeout: number; prior?: { kind: "legacy" } },
  ): Promise<{
    client: Client;
    transport: StreamableHTTPClientTransport | SSEClientTransport;
  }> {
    const reqInit = config.headers ? { headers: config.headers } : undefined;
    const authProvider = isLocal ? undefined : new McpOAuthProvider({ serverName: config.name });
    const sseTransport = (): SSEClientTransport =>
      new SSEClientTransport(url, {
        eventSourceInit: config.headers ? { fetch: createHeaderFetch(config.headers) } : undefined,
        requestInit: reqInit,
        authProvider,
      });

    if (config.transport === "sse") {
      const transport = sseTransport();
      const client = this.createClient(config.name, negotiate);
      await client.connect(transport, connectOptions);
      return { client, transport };
    }

    try {
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: reqInit,
        authProvider,
      });
      const client = this.createClient(config.name, negotiate);
      await client.connect(transport, connectOptions);
      return { client, transport };
    } catch (streamableErr) {
      // For localhost, always try the SSE fallback — a 401 from localhost is
      // almost certainly a protocol mismatch (e.g. Playwright MCP serves SSE),
      // not an auth requirement. For remote servers, a 401 means OAuth is needed
      // so skip the fallback and surface "requires login".
      if (!isLocal && isUnauthorized(streamableErr)) throw streamableErr;
      log("INFO", "mcp", `StreamableHTTP failed for "${config.name}", trying SSE fallback`, {
        error: String(streamableErr),
      });
      const transport = sseTransport();
      const client = this.createClient(config.name, negotiate);
      await client.connect(transport, connectOptions);
      return { client, transport };
    }
  }

  /**
   * Protocol era actually negotiated with a server, as the SDK reports it.
   * Undefined before a connect completes; with negotiation off the SDK always
   * settles on `legacy` (the 2025 `initialize` handshake).
   */
  private negotiatedEra(client: Client): ProtocolEra {
    return client.getProtocolEra() ?? "legacy";
  }

  /** Previously negotiated era for this exact server config, if still cached. */
  private async cachedEra(config: MCPServerConfig): Promise<ProtocolEra | undefined> {
    try {
      return await this.catalogCache.protocolEraFor(config);
    } catch {
      return undefined;
    }
  }

  async dispose(): Promise<void> {
    // Our own teardown closes transports too; flag it so those closes are not
    // reported as unexpected deaths.
    this.disposing = true;
    this.connections.clear();
    this.reconnecting.clear();
    // Hand back pooled claims first. These are references, not connections —
    // the shared child survives if another session still holds it, and exits
    // when this was the last claim.
    const handles = [...this.sharedHandles.values()];
    this.sharedHandles.clear();
    await Promise.all(handles.map((handle) => handle.release()));
    for (const server of this.servers) {
      try {
        await server.client.close();
      } catch {
        // Ignore close errors
      }
    }
    this.servers = [];
  }
}

/**
 * Turn a thrown connection error into a short human-readable string.
 *
 * v2 splits the old `McpError` into `ProtocolError` (a JSON-RPC error that
 * crossed the wire) and `SdkError` (a purely local failure: timeout, closed
 * connection, HTTP status). Matching the typed classes gives far better wording
 * than sniffing message text, which survives only as the fallback for errors
 * thrown before the SDK's machinery engages (raw fetch failures).
 */
function formatConnectError(reason: unknown): string {
  if (SdkHttpError.isInstance(reason)) {
    if (reason.status === 429) return "Rate limited (429) — try again in a moment.";
    const statusText = reason.statusText ? ` ${reason.statusText}` : "";
    return `Server responded with HTTP ${reason.status}${statusText}.`;
  }
  if (SdkError.isInstance(reason)) {
    if (reason.code === SdkErrorCode.RequestTimeout) {
      return "Timed out waiting for the server to respond.";
    }
    if (reason.code === SdkErrorCode.ConnectionClosed) {
      return "Connection closed before the server finished starting up.";
    }
    return reason.message;
  }
  if (OAuthError.isInstance(reason)) return `OAuth error (${reason.code}): ${reason.message}`;
  if (ProtocolError.isInstance(reason)) return reason.message;

  const msg = reason instanceof Error ? reason.message : String(reason);
  if (msg.includes("Too Many R") || msg.includes("429")) {
    return "Rate limited (429) — try again in a moment.";
  }
  return msg;
}

/**
 * How long to wait for a stdio server to answer `server/discover` before
 * concluding it is a 2025-era server. A local child that has not replied in
 * this window is not going to; the SDK then falls back to `initialize`.
 */
const STDIO_PROBE_TIMEOUT_MS = 2_500;

/** Client-side version-negotiation options, as passed to the SDK `Client`. */
type NegotiationOptions = {
  versionNegotiation?: {
    mode: "auto";
    probe?: { timeoutMs: number };
  };
};

/** OAuth failures that mean the saved credentials can no longer be used. */
const REAUTH_OAUTH_CODES: readonly (OAuthErrorCode | string)[] = [
  OAuthErrorCode.InvalidToken,
  OAuthErrorCode.InvalidGrant,
  OAuthErrorCode.InvalidClient,
  OAuthErrorCode.AccessDenied,
];

/**
 * Whether an error means the remote server has dropped our HTTP session.
 *
 * `StreamableHTTPClientTransport.send` handles 401/403 (it re-runs auth) but
 * returns a bare `SdkHttpError{status:404}` when the `Mcp-Session-Id` we are
 * carrying is no longer known to the server — which is exactly what happens
 * after a server restart or an idle-session sweep on a long desktop session.
 * The SDK has no recovery for it, so we rebuild the connection ourselves.
 */
function isSessionExpired(reason: unknown): boolean {
  return SdkHttpError.isInstance(reason) && reason.status === 404;
}

/**
 * Whether a connect error means the server needs OAuth login. The SDK throws
 * its typed `UnauthorizedError` when auth is required, a `SdkHttpError` for a
 * bare 401, and an `OAuthError` when the token endpoint rejects the saved
 * credentials. A raw 401 from before the auth machinery engages can still
 * surface as a plain message — so the string check remains as a fallback.
 */
function isUnauthorized(reason: unknown): boolean {
  if (UnauthorizedError.isInstance(reason)) return true;
  if (SdkHttpError.isInstance(reason)) return reason.status === 401;
  // Token/grant/client codes mean "log in again"; the rest (server_error,
  // temporarily_unavailable, …) are transient, not an auth gap.
  if (OAuthError.isInstance(reason)) return REAUTH_OAUTH_CODES.includes(reason.code);
  const msg = reason instanceof Error ? reason.message : String(reason);
  return (
    msg.includes("Unauthorized") ||
    msg.includes("401") ||
    msg.toLowerCase().includes("invalid_token")
  );
}

/** Minimal HTML-escape for echoing an OAuth error string into the callback page. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Create a custom fetch wrapper that injects extra headers into every request.
 * Used for SSEClientTransport's eventSourceInit to pass auth headers
 * on the initial SSE GET connection (which doesn't use requestInit).
 *
 * The incoming headers may be a Web Standard `Headers` instance (v2 uses it
 * throughout) or a plain object. Spreading a `Headers` yields `{}`, silently
 * dropping the SDK's own auth header — so normalize through `Headers`, which
 * accepts both shapes, and merge with `set()` rather than bracket access.
 */
function createHeaderFetch(extraHeaders: Record<string, string>) {
  return (url: string | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
    return fetch(url, { ...init, headers });
  };
}
