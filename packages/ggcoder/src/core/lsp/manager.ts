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
  private readonly snapshotLimit: number;
  /** (serverId\0root) → in-flight or settled client resolution. */
  private readonly clients = new Map<string, Promise<ClientResolution>>();
  /** Keys that have completed at least one diagnostics pass (warm). */
  private readonly warmKeys = new Set<string>();
  private readonly latestOutcomes = new Map<string, LspDiagnosticOutcome>();
  private shutDown = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    private readonly cwd: string,
    options?: LspManagerOptions,
  ) {
    this.catalog = options?.catalog ?? LSP_SERVER_CATALOG;
    this.warmBudgetMs = options?.warmBudgetMs ?? DEFAULT_WARM_BUDGET_MS;
    this.firstBudgetMs = options?.firstBudgetMs ?? DEFAULT_FIRST_BUDGET_MS;
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

  /** Shut down every pooled server and wait for native handles to be released. */
  async shutdownAll(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutDown = true;
    const pendingClients = [...this.clients.values()];
    this.clients.clear();
    this.warmKeys.clear();
    this.shutdownPromise = Promise.all(
      pendingClients.map(async (pending) => {
        const resolution = await pending.catch(() => null);
        if (resolution?.status !== "ready") return;
        resolution.client.shutdown();
        await resolution.client.waitForExit();
      }),
    ).then(() => undefined);
    return this.shutdownPromise;
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
    const resolution = await this.ensureClient(key, spec, root);
    if (resolution.status !== "ready") return this.outcome(resolution.status, filePath);
    const { client } = resolution;
    if (!client.isAlive) {
      this.clients.set(key, Promise.resolve({ status: "server_failed" }));
      log("WARN", "lsp", `${spec.id} server died`, { root });
      return this.outcome("server_failed", filePath);
    }

    const uri = client.syncDocument(filePath, content);
    const diagnostics = await client.collectDiagnostics(uri, budgetMs);
    this.warmKeys.add(key);
    if (!client.isAlive) {
      this.clients.set(key, Promise.resolve({ status: "server_failed" }));
      return this.outcome("server_failed", filePath);
    }
    if (diagnostics === null) return this.outcome("timeout", filePath);

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
      let client: LspClient | null = null;
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
        if (client) {
          client.shutdown();
          await client.waitForExit();
        }
        log("WARN", "lsp", `${spec.id} server failed to start`, {
          root,
          error: error instanceof Error ? error.message : String(error),
        });
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
