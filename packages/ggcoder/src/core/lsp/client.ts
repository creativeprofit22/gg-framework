import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { JsonRpcConnection, JsonRpcRequestError } from "./jsonrpc.js";
import { getSafeToolEnv } from "../../tools/safe-env.js";
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
const SHUTDOWN_TIMEOUT_MS = 2000;
const KILL_GRACE_MS = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
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
  private readonly exited: Promise<void>;
  private readonly versions = new Map<string, number>();
  private readonly published = new Map<string, LspDiagnostic[]>();
  private waiters: DiagnosticWaiter[] = [];
  private hasPullDiagnostics = false;
  private readonly activeProgressTokens = new Set<string>();
  private alive = true;

  private readonly initializationOptions: unknown;

  constructor(
    private readonly spec: LspServerSpec,
    private readonly rootPath: string,
    command: ResolvedCommand,
  ) {
    this.initializationOptions = command.initializationOptions ?? {};
    this.proc = spawn(command.command, command.args, {
      cwd: rootPath,
      stdio: ["pipe", "pipe", "ignore"],
      env: getSafeToolEnv(),
    });
    this.exited = new Promise((resolve) => this.proc.once("exit", () => resolve()));
    this.proc.on("error", () => this.markDead());
    this.proc.on("exit", () => this.markDead());
    const { stdout, stdin } = this.proc;
    if (!stdout || !stdin) {
      // Cannot happen with "pipe" stdio, but guard instead of asserting.
      this.proc.kill("SIGKILL");
      throw new Error(`failed to open stdio pipes for ${spec.id} language server`);
    }
    this.conn = new JsonRpcConnection(stdout, stdin);
    this.conn.onNotification("textDocument/publishDiagnostics", (params) => {
      const publish = params as PublishDiagnosticsParams;
      this.published.set(publish.uri, publish.diagnostics);
      this.waiters = this.waiters.filter((waiter) => {
        if (waiter.uri !== publish.uri) return true;
        waiter.resolve(publish.diagnostics);
        return false;
      });
    });
    this.conn.onNotification("$/progress", (params) => {
      const progress = params as ProgressParams;
      if (progress?.token === undefined) return;
      const key = progressTokenKey(progress.token);
      if (progress.value?.kind === "begin") this.activeProgressTokens.add(key);
      else if (progress.value?.kind === "end") this.activeProgressTokens.delete(key);
    });
  }

  get isAlive(): boolean {
    return this.alive;
  }

  /** True while the server reports indexing/analysis through LSP work progress. */
  get hasActiveProgress(): boolean {
    return this.activeProgressTokens.size > 0;
  }

  async initialize(timeoutMs: number): Promise<void> {
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
    const uri = pathToFileURL(filePath).href;
    this.published.delete(uri);
    const previousVersion = this.versions.get(uri);
    if (previousVersion === undefined) {
      this.versions.set(uri, 1);
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
      this.versions.set(uri, version);
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
   * Start graceful shutdown immediately. `waitForExit` lets async cleanup
   * paths wait for Windows to release the server's working directory.
   */
  shutdown(): void {
    if (!this.alive) return;
    void this.conn.request("shutdown", null, SHUTDOWN_TIMEOUT_MS).catch(() => {});
    this.conn.notify("exit");
    const killTimer = setTimeout(() => {
      if (this.alive) this.proc.kill("SIGKILL");
    }, KILL_GRACE_MS);
    killTimer.unref();
  }

  async waitForExit(timeoutMs = SHUTDOWN_TIMEOUT_MS + KILL_GRACE_MS): Promise<void> {
    if (!this.alive) return;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      this.exited.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!timedOut || !this.alive) return;
    this.proc.kill("SIGKILL");
    await Promise.race([this.exited, new Promise<void>((resolve) => setTimeout(resolve, 500))]);
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
    const cached = this.published.get(uri);
    if (cached !== undefined) return Promise.resolve(cached);
    if (!this.alive) return Promise.resolve(null);
    return new Promise<LspDiagnostic[] | null>((resolve) => {
      const waiter: DiagnosticWaiter = {
        uri,
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
      if (report?.kind === "unchanged") return this.published.get(uri) ?? [];
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
