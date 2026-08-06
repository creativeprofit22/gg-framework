import path from "node:path";
import { log } from "../logger.js";
import { LspClient, type LspDiagnostic } from "./client.js";
import { formatDiagnostics } from "./format.js";
import {
  LSP_SERVER_CATALOG,
  findProjectRoot,
  serverForFile,
  type LspServerSpec,
} from "./servers.js";

export interface LspManagerOptions {
  /** Server catalog override — tests inject a fake-server spec here. */
  catalog?: readonly LspServerSpec[];
  /** Hard diagnostics budget once a client has served at least one file. */
  warmBudgetMs?: number;
  /** Hard budget for a client's very first file (spawn + init + indexing). */
  firstBudgetMs?: number;
  /** Grace period for a corrected publish after an empty cold-load result. */
  settleMs?: number;
  /** Maximum number of per-file latest outcomes retained. */
  snapshotLimit?: number;
}

export type LspOutcomeKind =
  | "diagnostics"
  | "clean"
  | "low_confidence"
  | "timeout"
  | "unsupported"
  | "unavailable"
  | "server_failed";

interface LspOutcomeBase {
  kind: LspOutcomeKind;
  filePath: string;
  updatedAt: number;
}

export type LspDiagnosticOutcome =
  | (LspOutcomeBase & {
      kind: "diagnostics";
      diagnostics: LspDiagnostic[];
      formatted: string;
    })
  | (LspOutcomeBase & {
      kind: Exclude<LspOutcomeKind, "diagnostics">;
    });

type ClientResolution =
  | { status: "ready"; client: LspClient }
  | { status: "unavailable" | "server_failed" };

const DEFAULT_WARM_BUDGET_MS = 3000;
const DEFAULT_FIRST_BUDGET_MS = 8000;
/**
 * How long to wait for a corrected publish after a server's FIRST result for a
 * project comes back empty. tsserver ends its project-load progress, publishes
 * an empty set for the open file, and only then type-checks and publishes for
 * real, so that first empty publish means "not analysed yet" rather than
 * "clean". Only paid on a cold client that reported progress, and only when the
 * answer would otherwise have been `clean`.
 */
const DEFAULT_SETTLE_MS = 1500;
const DEFAULT_SNAPSHOT_LIMIT = 100;
const INIT_TIMEOUT_MS = 10_000;

/**
 * Lazily spawns and pools language servers keyed by (serverId, projectRoot).
 * The detailed outcome path preserves confidence and failure evidence while the
 * compatibility wrapper keeps edit/write output byte-identical on degradation.
 */
export class LspManager {
  private readonly catalog: readonly LspServerSpec[];
  private readonly warmBudgetMs: number;
  private readonly firstBudgetMs: number;
  private readonly settleMs: number;
  private readonly snapshotLimit: number;
  /** (serverId\0root) → in-flight or settled client resolution. */
  private readonly clients = new Map<string, Promise<ClientResolution>>();
  /** Keys that have completed at least one diagnostics pass (warm). */
  private readonly warmKeys = new Set<string>();
  private readonly latestOutcomes = new Map<string, LspDiagnosticOutcome>();
  private shutDown = false;

  constructor(
    private readonly cwd: string,
    options?: LspManagerOptions,
  ) {
    this.catalog = options?.catalog ?? LSP_SERVER_CATALOG;
    this.warmBudgetMs = options?.warmBudgetMs ?? DEFAULT_WARM_BUDGET_MS;
    this.firstBudgetMs = options?.firstBudgetMs ?? DEFAULT_FIRST_BUDGET_MS;
    this.settleMs = Math.max(0, options?.settleMs ?? DEFAULT_SETTLE_MS);
    this.snapshotLimit = Math.max(1, options?.snapshotLimit ?? DEFAULT_SNAPSHOT_LIMIT);
  }

  /**
   * Compatibility surface used by edit/write tools. Diagnostics remain visible;
   * every clean/degraded outcome remains the exact historical empty string.
   */
  async diagnosticsAfterWrite(filePath: string, content: string): Promise<string> {
    const outcome = await this.diagnosticsAfterWriteDetailed(filePath, content);
    return outcome.kind === "diagnostics" ? outcome.formatted : "";
  }

  /** Collect diagnostics with explicit confidence/failure evidence. */
  async diagnosticsAfterWriteDetailed(
    filePath: string,
    content: string,
  ): Promise<LspDiagnosticOutcome> {
    const normalizedFilePath = path.resolve(this.cwd, filePath);
    if (this.shutDown) return this.record(this.outcome("unavailable", normalizedFilePath));

    try {
      const spec = serverForFile(normalizedFilePath, this.catalog);
      if (!spec) return this.record(this.outcome("unsupported", normalizedFilePath));
      const root = findProjectRoot(normalizedFilePath, spec.rootMarkers, this.cwd);
      const key = `${spec.id}\u0000${root}`;
      const budgetMs = this.warmKeys.has(key) ? this.warmBudgetMs : this.firstBudgetMs;
      const work = this.collect(key, spec, root, normalizedFilePath, content, budgetMs);

      // Leave slow initialization/indexing alive to warm the next edit. Record
      // its eventual evidence too, but report this call honestly as timed out.
      const outcome = await withBudget(work, budgetMs, () =>
        this.outcome("timeout", normalizedFilePath),
      );
      if (outcome.kind === "timeout") {
        void work.then((eventual) => this.record(eventual)).catch(() => {});
      }
      return this.record(outcome);
    } catch (error) {
      log("WARN", "lsp", `diagnostics failed for ${normalizedFilePath}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.record(this.outcome("server_failed", normalizedFilePath));
    }
  }

  /** Latest bounded evidence for one normalized absolute/relative file path. */
  getLatestOutcome(filePath: string): LspDiagnosticOutcome | undefined {
    return this.latestOutcomes.get(path.resolve(this.cwd, filePath));
  }

  /** Newest retained per-file evidence snapshots. */
  getLatestOutcomes(): LspDiagnosticOutcome[] {
    return [...this.latestOutcomes.values()].reverse();
  }

  /** Shut down every pooled server. Safe in process exit handlers. */
  shutdownAll(): void {
    this.shutDown = true;
    for (const pending of this.clients.values()) {
      void pending
        .then((resolution) => {
          if (resolution.status === "ready") resolution.client.shutdown();
        })
        .catch(() => {});
    }
    this.clients.clear();
    this.warmKeys.clear();
  }

  private outcome(
    kind: Exclude<LspOutcomeKind, "diagnostics">,
    filePath: string,
  ): LspDiagnosticOutcome {
    return { kind, filePath, updatedAt: Date.now() };
  }

  private record(outcome: LspDiagnosticOutcome): LspDiagnosticOutcome {
    this.latestOutcomes.delete(outcome.filePath);
    this.latestOutcomes.set(outcome.filePath, outcome);
    while (this.latestOutcomes.size > this.snapshotLimit) {
      const oldest = this.latestOutcomes.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.latestOutcomes.delete(oldest);
    }
    return outcome;
  }

  private async collect(
    key: string,
    spec: LspServerSpec,
    root: string,
    filePath: string,
    content: string,
    budgetMs: number,
  ): Promise<LspDiagnosticOutcome> {
    // The caller races this whole function against `budgetMs`, so every wait in
    // here has to fit inside the same deadline or a good answer arrives after
    // the caller has already given up and reported a timeout.
    const deadline = Date.now() + budgetMs;
    const resolution = await this.ensureClient(key, spec, root);
    if (resolution.status !== "ready") return this.outcome(resolution.status, filePath);
    const { client } = resolution;
    if (!client.isAlive) {
      this.clients.set(key, Promise.resolve({ status: "server_failed" }));
      log("WARN", "lsp", `${spec.id} server died`, { root });
      return this.outcome("server_failed", filePath);
    }

    // Sampled BEFORE the collect: a cold client is the one that has to load the
    // project, and therefore the only one that can answer prematurely.
    const wasCold = !this.warmKeys.has(key);
    const uri = client.syncDocument(filePath, content);
    let diagnostics = await client.collectDiagnostics(uri, budgetMs);
    this.warmKeys.add(key);
    if (!client.isAlive) {
      this.clients.set(key, Promise.resolve({ status: "server_failed" }));
      return this.outcome("server_failed", filePath);
    }
    if (diagnostics === null) {
      // A timeout carries no other evidence and is indistinguishable from
      // "clean" in the tool output. Log the server's own stderr alongside it —
      // usually the only thing that explains why a server accepted the document
      // and then never reported on it.
      log("WARN", "lsp", `${spec.id} diagnostics timed out`, {
        file: filePath,
        budgetMs,
        stderr: client.stderrTail() || "(none)",
      });
      return this.outcome("timeout", filePath);
    }

    // An empty FIRST answer from a server that was loading the project is not a
    // verdict yet: tsserver ends its load progress and publishes an empty set
    // before it type-checks, so this used to report a broken file as clean and
    // inline diagnostics silently did nothing on the first edit in a project.
    // Give it a bounded moment to correct itself. A follow-up that is ALSO empty
    // changes nothing, so a genuinely clean file still lands on `clean`.
    if (diagnostics.length === 0 && wasCold && client.hasReportedProgress && client.isAlive) {
      const settleMs = Math.min(this.settleMs, deadline - Date.now());
      if (settleMs > 0) {
        const corrected = await client.awaitNextPublish(uri, settleMs);
        if (corrected !== null && corrected.length > 0) diagnostics = corrected;
      }
    }

    if (diagnostics.length > 0) {
      const relPath = path.relative(this.cwd, filePath);
      return {
        kind: "diagnostics",
        filePath,
        updatedAt: Date.now(),
        diagnostics,
        formatted: formatDiagnostics(relPath, diagnostics),
      };
    }
    return this.outcome(client.hasActiveProgress ? "low_confidence" : "clean", filePath);
  }

  private ensureClient(key: string, spec: LspServerSpec, root: string): Promise<ClientResolution> {
    const existing = this.clients.get(key);
    if (existing) return existing;

    const pending = (async (): Promise<ClientResolution> => {
      const command = spec.resolveCommand(root);
      if (!command) {
        log("INFO", "lsp", `${spec.id} language server not available`, { root });
        return { status: "unavailable" };
      }
      // `client` is declared outside the try so one that fails to initialize
      // can still be killed. `new LspClient` SPAWNS the process, so discarding
      // the reference on a throw leaked the server forever — one orphan per
      // (server, root) every time initialize timed out, for the life of the
      // session. Invisible on POSIX; on Windows the orphan keeps handles open
      // in the project directory.
      let client: LspClient | undefined;
      try {
        const startedAt = Date.now();
        client = new LspClient(spec, root, command);
        await client.initialize(INIT_TIMEOUT_MS);
        if (!client.isAlive) return { status: "server_failed" };
        log("INFO", "lsp", `${spec.id} server initialized`, {
          root,
          ms: String(Date.now() - startedAt),
        });
        return { status: "ready", client };
      } catch (error) {
        log("WARN", "lsp", `${spec.id} server failed to start`, {
          root,
          error: error instanceof Error ? error.message : String(error),
          // The server's own last words — usually the only explanation of why
          // the handshake never completed.
          stderr: client?.stderrTail() || "(none)",
        });
        client?.terminate();
        return { status: "server_failed" };
      }
    })();

    this.clients.set(key, pending);
    return pending;
  }
}

/** Race work against a hard budget while allowing it to settle in background. */
function withBudget<T>(work: Promise<T>, budgetMs: number, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(onTimeout()), budgetMs);
    timer.unref();
    work
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(onTimeout());
      });
  });
}
