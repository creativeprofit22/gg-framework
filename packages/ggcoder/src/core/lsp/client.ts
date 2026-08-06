import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { JsonRpcConnection, JsonRpcRequestError, type WireTracer } from "./jsonrpc.js";
import { getSafeToolEnv } from "../../tools/safe-env.js";
import { killProcessTree } from "../../utils/process.js";
import { log } from "../logger.js";
import type { LspServerSpec, ResolvedCommand } from "./servers.js";

/** LSP diagnostic shape (the subset we render). */
export interface LspDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity?: number;
  message: string;
  source?: string;
  code?: string | number;
}

interface PublishDiagnosticsParams {
  uri: string;
  diagnostics: LspDiagnostic[];
}

interface DiagnosticWaiter {
  uri: string;
  resolve: (diagnostics: LspDiagnostic[]) => void;
}

interface ProgressParams {
  token: string | number;
  value?: { kind?: "begin" | "report" | "end" };
}

function progressTokenKey(token: string | number): string {
  return `${typeof token}:${String(token)}`;
}

const SERVER_CANCELLED = -32802;
const METHOD_NOT_FOUND = -32601;
const PULL_POLL_INTERVAL_MS = 300;
/** Bounded stderr retained per server for failure diagnostics. */
const STDERR_TAIL_BYTES = 4000;
const SHUTDOWN_TIMEOUT_MS = 2000;
const KILL_GRACE_MS = 1500;

/**
 * JSON-RPC wire tracer, enabled only by `GG_LSP_TRACE=1`.
 *
 * When a server accepts a document and then never publishes diagnostics, the
 * outcome (`timeout`) looks identical whether our `didOpen` never went out, the
 * server rejected it, or it answered about a URI we weren't watching. Only the
 * wire tells those apart. Opt-in because it is genuinely chatty, and params are
 * SUMMARIZED rather than dumped so a trace can never spill file contents into a
 * log.
 */
function wireTracer(serverId: string): WireTracer | undefined {
  if (process.env.GG_LSP_TRACE !== "1") return undefined;
  return (direction, message) => {
    const params = message.params as
      | {
          textDocument?: { uri?: string };
          uri?: string;
          diagnostics?: unknown[];
          message?: string;
        }
      | undefined;
    // `window/logMessage` / `window/showMessage` are the server's own
    // human-readable complaints ("cannot find tsserver", bad option, …) and are
    // frequently the only statement of what actually went wrong. Everything
    // else is summarized — never file contents.
    const isServerMessage =
      message.method === "window/logMessage" || message.method === "window/showMessage";
    log("DEBUG", "lsp", `${serverId} rpc ${direction}`, {
      method: message.method ?? `(response id=${String(message.id)})`,
      uri: params?.textDocument?.uri ?? params?.uri,
      // Counts only, never the diagnostics themselves.
      diagnostics: Array.isArray(params?.diagnostics) ? params.diagnostics.length : undefined,
      text: isServerMessage ? params?.message?.slice(0, 300) : undefined,
      error: message.error?.message,
    });
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/**
 * Canonical cache key for a `file://` URI.
 *
 * Diagnostics live in a Map keyed by URI: we `set` what the server sends and
 * `get` what we built from the edited path, so the two must be the SAME STRING.
 * There is no single canonical spelling of a file URI, and on Windows we and
 * tsserver disagreed in two independent ways at once. Measured on CI:
 *
 *   we sent:      file:///c:/Users/RUNNER%7E1/…/main.ts
 *   server sent:  file:///c%3A/Users/RUNNER~1/…/main.ts
 *
 * `~` is an RFC 3986 unreserved character that `pathToFileURL` percent-encodes
 * and tsserver leaves literal; the drive colon is the reverse. Every lookup
 * missed, so the diagnostics arrived (the wire trace shows `diagnostics=1`)
 * and were then dropped on the floor — reported to the user as a clean file,
 * because LSP degrades silently by design. 8.3 short names like `RUNNER~1` are
 * not exotic: that IS the Windows temp path on GitHub runners, and `PROGRA~1`
 * and friends show up in real user paths.
 *
 * Fix: decode percent-escapes and lower-case the drive letter, so both
 * spellings collapse to one key. Used ONLY as a Map key — the URI actually put
 * on the wire is still the properly encoded one from `pathToFileURL`.
 *
 * Windows paths are also case-insensitive, but case is deliberately NOT folded:
 * both sides derive from the same path string, and folding would break the
 * genuinely case-sensitive POSIX servers that share this code.
 */
export function normalizeUri(uri: string): string {
  let decoded = uri;
  try {
    decoded = decodeURI(uri);
    // decodeURI leaves %3A alone (`:` is reserved), so unescape it explicitly
    // rather than reaching for decodeURIComponent, which would also mangle any
    // literal `#`/`?` a filename is allowed to contain.
    decoded = decoded.replace(/%3A/gi, ":");
  } catch {
    // Malformed escape sequence — fall back to the raw URI rather than throwing
    // inside a notification handler.
  }
  return decoded.replace(
    /^(file:\/\/\/)([A-Za-z])(:)/,
    (_m, prefix: string, drive: string) => `${prefix}${drive.toLowerCase()}:`,
  );
}

/**
 * One language-server process bound to one project root. Owns document sync
 * (didOpen / didChange / didSave with per-uri version counters), the
 * push-diagnostics cache, and LSP 3.17 pull diagnostics with the
 * push-vs-pull race that the POC proved necessary for rust-analyzer.
 */
export class LspClient {
  private readonly proc: ChildProcess;
  private readonly conn: JsonRpcConnection;
  private readonly versions = new Map<string, number>();
  private readonly published = new Map<string, LspDiagnostic[]>();
  private waiters: DiagnosticWaiter[] = [];
  private hasPullDiagnostics = false;
  private readonly activeProgressTokens = new Set<string>();
  private sawProgress = false;
  private alive = true;

  private readonly initializationOptions: unknown;
  private stderrBuffer = "";

  constructor(
    private readonly spec: LspServerSpec,
    private readonly rootPath: string,
    command: ResolvedCommand,
  ) {
    this.initializationOptions = command.initializationOptions ?? {};
    this.proc = spawn(command.command, command.args, {
      cwd: rootPath,
      // stderr was "ignore" — which made every server-side failure completely
      // unattributable. LSP degrades silently by design, so a server that boots
      // and then errors (a tsserver that can't start, a bad
      // initializationOptions path, an unsupported flag) produced exactly the
      // same empty output as a clean file, with nothing anywhere saying why.
      // Diagnosing the Windows timeout was blind for precisely this reason.
      // Pipe it and log it; the pipe MUST be drained either way, or a chatty
      // server eventually blocks on a full stderr buffer.
      stdio: ["pipe", "pipe", "pipe"],
      env: getSafeToolEnv(),
    });
    this.captureStderr();
    this.proc.on("error", () => this.markDead());
    this.proc.on("exit", (code, signal) => {
      if (code !== 0 && code !== null) {
        log("WARN", "lsp", `${spec.id} language server exited`, {
          code,
          signal,
          stderr: this.stderrTail(),
        });
      }
      this.markDead();
    });
    const { stdout, stdin } = this.proc;
    if (!stdout || !stdin) {
      // Cannot happen with "pipe" stdio, but guard instead of asserting.
      this.proc.kill("SIGKILL");
      throw new Error(`failed to open stdio pipes for ${spec.id} language server`);
    }
    this.conn = new JsonRpcConnection(stdout, stdin, wireTracer(spec.id));
    this.conn.onNotification("textDocument/publishDiagnostics", (params) => {
      const publish = params as PublishDiagnosticsParams;
      const uri = normalizeUri(publish.uri);
      this.published.set(uri, publish.diagnostics);
      this.waiters = this.waiters.filter((waiter) => {
        if (waiter.uri !== uri) return true;
        waiter.resolve(publish.diagnostics);
        return false;
      });
    });
    this.conn.onNotification("$/progress", (params) => {
      const progress = params as ProgressParams;
      if (progress?.token === undefined) return;
      const key = progressTokenKey(progress.token);
      if (progress.value?.kind === "begin") {
        this.activeProgressTokens.add(key);
        this.sawProgress = true;
      } else if (progress.value?.kind === "end") this.activeProgressTokens.delete(key);
    });
  }

  get isAlive(): boolean {
    return this.alive;
  }

  /** True while the server reports indexing/analysis through LSP work progress. */
  get hasActiveProgress(): boolean {
    return this.activeProgressTokens.size > 0;
  }

  /**
   * True once the server has reported ANY work progress, even if it has since
   * ended. A server that loads a project this way can publish an empty
   * diagnostic set the instant loading finishes but before the open file has
   * actually been analysed, so an empty FIRST result from one is not yet
   * trustworthy. Servers that never report progress never pay for this.
   */
  get hasReportedProgress(): boolean {
    return this.sawProgress;
  }

  /**
   * Wait for the NEXT publishDiagnostics for `uri`, deliberately ignoring what
   * is already cached. Resolves null when none arrives inside `timeoutMs`,
   * which means "no correction came", not a failure.
   */
  awaitNextPublish(uri: string, timeoutMs: number): Promise<LspDiagnostic[] | null> {
    const key = normalizeUri(uri);
    if (!this.alive) return Promise.resolve(null);
    return new Promise<LspDiagnostic[] | null>((resolve) => {
      const waiter: DiagnosticWaiter = {
        uri: key,
        resolve: (diagnostics) => {
          clearTimeout(timer);
          resolve(diagnostics);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(null);
      }, timeoutMs);
      timer.unref();
      this.waiters.push(waiter);
    });
  }

  /**
   * Drain the server's stderr into a bounded ring, and mirror it to the debug
   * log so a misbehaving server is diagnosable from `~/.gg/*.log` alone.
   * Bounded because a looping server can emit stderr without limit.
   */
  private captureStderr(): void {
    this.proc.stderr?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      this.stderrBuffer = (this.stderrBuffer + text).slice(-STDERR_TAIL_BYTES);
      const trimmed = text.trim();
      if (trimmed) log("DEBUG", "lsp", `${this.spec.id} stderr`, { text: trimmed.slice(0, 500) });
    });
    // A read error must not take the process down; the server is still usable.
    this.proc.stderr?.on("error", () => {});
  }

  /** Most recent server stderr, for failure diagnostics. */
  stderrTail(): string {
    return this.stderrBuffer.trim().slice(-STDERR_TAIL_BYTES);
  }

  async initialize(timeoutMs: number): Promise<void> {
    // Wire value: keep it properly percent-encoded. `normalizeUri` is a cache
    // key helper, and a decoded root (`C:\Program Files\…` → a literal space)
    // is not a valid URI to hand a server at initialize.
    const rootUri = pathToFileURL(this.rootPath).href;
    const result = (await this.conn.request(
      "initialize",
      {
        processId: process.pid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: "ggcoder" }],
        initializationOptions: this.initializationOptions,
        capabilities: {
          textDocument: {
            synchronization: { didSave: true },
            publishDiagnostics: { relatedInformation: false },
            diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
          },
          workspace: { configuration: true, workspaceFolders: true },
          window: { workDoneProgress: true },
        },
      },
      timeoutMs,
    )) as { capabilities?: { diagnosticProvider?: unknown } } | null;
    this.hasPullDiagnostics = Boolean(result?.capabilities?.diagnosticProvider);
    this.conn.notify("initialized", {});
  }

  /**
   * Sync `content` into the server's overlay for `filePath` — didOpen the
   * first time, didChange (full text) + didSave afterwards. Clears the
   * push-diagnostics cache for the uri so a subsequent collect waits for a
   * report computed against THIS content rather than a stale one.
   */
  syncDocument(filePath: string, content: string): string {
    // Two different strings on purpose: `uri` is the properly percent-encoded
    // form that goes ON THE WIRE (a literal space or `~` there would be an
    // invalid URI), while `key` is the decoded form used for our own bookkeeping
    // so it matches whatever spelling the server replies with.
    const uri = pathToFileURL(filePath).href;
    const key = normalizeUri(uri);
    this.published.delete(key);
    const previousVersion = this.versions.get(key);
    if (previousVersion === undefined) {
      this.versions.set(key, 1);
      this.conn.notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: this.spec.languageIdFor(extensionOf(filePath)),
          version: 1,
          text: content,
        },
      });
    } else {
      const version = previousVersion + 1;
      this.versions.set(key, version);
      this.conn.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text: content }],
      });
      this.conn.notify("textDocument/didSave", { textDocument: { uri }, text: content });
    }
    return uri;
  }

  /**
   * Current diagnostics for `uri`, racing the push channel (next
   * publishDiagnostics after the last sync) against a pull-diagnostics poll
   * loop when the server supports LSP 3.17 pull. Returns null on timeout.
   */
  async collectDiagnostics(uri: string, timeoutMs: number): Promise<LspDiagnostic[] | null> {
    const push = this.waitForPublish(uri, timeoutMs);
    if (!this.hasPullDiagnostics) return push;

    let stopped = false;
    const pull = (async (): Promise<LspDiagnostic[] | null> => {
      const deadline = Date.now() + timeoutMs;
      while (!stopped && this.alive && Date.now() < deadline) {
        const items = await this.pullDiagnostics(uri, Math.max(1, deadline - Date.now()));
        if (items === "unsupported") return push;
        if (items !== "retry") return items;
        await sleep(PULL_POLL_INTERVAL_MS);
      }
      return push;
    })();

    try {
      return await Promise.race([push, pull]);
    } finally {
      stopped = true;
    }
  }

  /**
   * Graceful shutdown/exit handshake with SIGKILL fallback. Synchronous so it
   * is safe inside `process.on("exit")` handlers: the shutdown request and
   * exit notification are written immediately; the SIGKILL timer covers
   * servers that ignore them (and stdin EOF reaps them when we die first).
   */
  shutdown(): void {
    if (!this.alive) return;
    void this.conn.request("shutdown", null, SHUTDOWN_TIMEOUT_MS).catch(() => {});
    this.conn.notify("exit");
    const killTimer = setTimeout(() => {
      if (this.alive) this.terminate();
    }, KILL_GRACE_MS);
    killTimer.unref();
  }

  /**
   * Force-kill the server and everything it spawned, immediately.
   *
   * For a server that never completed the handshake, the polite
   * `shutdown`/`exit` sequence is pointless — it has already proven it isn't
   * answering — so skip straight to the kill.
   *
   * Uses `killProcessTree`, not `proc.kill()`: language servers spawn children
   * (typescript-language-server runs tsserver), Windows has no process groups,
   * and killing only the parent leaves those children alive holding file
   * handles in the project directory.
   */
  terminate(): void {
    this.conn.dispose();
    if (this.proc.pid !== undefined) killProcessTree(this.proc.pid);
    this.markDead();
  }

  private markDead(): void {
    this.alive = false;
    this.activeProgressTokens.clear();
    this.conn.dispose();
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter.resolve([]);
  }

  private waitForPublish(uri: string, timeoutMs: number): Promise<LspDiagnostic[] | null> {
    // Both the cache and the waiter list are keyed by the normalized form, which
    // is what the publishDiagnostics handler stores under.
    const key = normalizeUri(uri);
    const cached = this.published.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    if (!this.alive) return Promise.resolve(null);
    return new Promise<LspDiagnostic[] | null>((resolve) => {
      const waiter: DiagnosticWaiter = {
        uri: key,
        resolve: (diagnostics) => {
          clearTimeout(timer);
          resolve(diagnostics);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(null);
      }, timeoutMs);
      timer.unref();
      this.waiters.push(waiter);
    });
  }

  private async pullDiagnostics(
    uri: string,
    timeoutMs: number,
  ): Promise<LspDiagnostic[] | "retry" | "unsupported"> {
    try {
      const report = (await this.conn.request(
        "textDocument/diagnostic",
        { textDocument: { uri } },
        timeoutMs,
      )) as { kind?: string; items?: LspDiagnostic[] } | null;
      if (report?.kind === "full") return report.items ?? [];
      if (report?.kind === "unchanged") return this.published.get(normalizeUri(uri)) ?? [];
      return "unsupported";
    } catch (error) {
      if (error instanceof JsonRpcRequestError) {
        if (error.code === SERVER_CANCELLED) return "retry";
        if (error.code === METHOD_NOT_FOUND) return "unsupported";
      }
      return "unsupported";
    }
  }
}

function extensionOf(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  return dot === -1 ? "" : filePath.slice(dot).toLowerCase();
}
