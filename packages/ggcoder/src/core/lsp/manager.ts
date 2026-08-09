import path from "node:path";
import { log } from "../logger.js";
import type { LspClient, LspDiagnostic } from "./client.js";
import { formatDiagnostics } from "./format.js";
import { lspClientPool, type LspClientPool } from "./pool.js";
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
  /**
   * Client pool backing this manager. Defaults to the daemon-wide singleton so
   * sessions share servers; injectable so tests get isolation.
   */
  pool?: LspClientPool;
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

/**
 * Per-session view over the process-wide language-server pool (see pool.ts).
 *
 * The manager owns only session-scoped state — per-file outcome snapshots and
 * which keys have gone warm — while the servers themselves are shared by every
 * session in the process and reclaimed when idle. That split is what stops two
 * windows open on one repo from running two full tsserver stacks.
 */
export class LspManager {
  private readonly catalog: readonly LspServerSpec[];
  private readonly warmBudgetMs: number;
  private readonly firstBudgetMs: number;
  private readonly settleMs: number;
  private readonly snapshotLimit: number;
  private readonly pool: LspClientPool;
  /**
   * Keys that have completed a diagnostics pass, mapped to the pool generation
   * that served it.
   *
   * Storing the generation rather than a bare flag is what keeps "warm" honest
   * across idle reclamation: once the pool retires a server, the replacement is
   * genuinely cold again, and treating it as warm would give it the 3s budget
   * instead of 8s AND skip the cold-load settle guard — turning tsserver's
   * premature empty publish into a reported "clean", which is a false all-clear.
   */
  private readonly warmKeys = new Map<string, number>();
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
    this.pool = options?.pool ?? lspClientPool;
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
      const budgetMs = this.isWarm(key, spec, root) ? this.warmBudgetMs : this.firstBudgetMs;
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

  /**
   * Has this session already completed a pass against the server that is live
   * NOW? False once the pool has rebuilt it, because the replacement is cold.
   */
  private isWarm(key: string, spec: LspServerSpec, root: string): boolean {
    const warmedGeneration = this.warmKeys.get(key);
    return (
      warmedGeneration !== undefined && warmedGeneration === this.pool.generationFor(spec, root)
    );
  }

  /**
   * Retained stderr of a language server this session is using, for failure
   * reporting when a server accepts a document and then never answers.
   */
  serverStderrTail(): Promise<string> {
    return this.pool.stderrTail(this);
  }

  /** Newest retained per-file evidence snapshots. */
  getLatestOutcomes(): LspDiagnosticOutcome[] {
    return [...this.latestOutcomes.values()].reverse();
  }

  /**
   * Release this session's claim on every server it used. Safe in process exit
   * handlers.
   *
   * This drops REFERENCES, not processes: a server another session still holds
   * keeps running, and one left with no holders is shut down immediately. The
   * name is kept because every caller wires it into an exit path.
   */
  shutdownAll(): void {
    this.shutDown = true;
    this.pool.release(this);
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
    const resolution = await this.pool.retain(spec, root, this);
    if (resolution.status !== "ready") return this.outcome(resolution.status, filePath);
    const { client } = resolution;
    if (!client.isAlive) {
      this.pool.markDead(spec, root);
      log("WARN", "lsp", `${spec.id} server died`, { root });
      return this.outcome("server_failed", filePath);
    }

    // Hold the entry open for the whole pass: a first-file load can take
    // seconds, and the idle sweep must not reclaim a server that is mid-answer.
    const endCall = this.pool.beginCall(spec, root);
    try {
      return await this.collectFrom(client, key, spec, root, filePath, content, budgetMs, deadline);
    } finally {
      endCall();
    }
  }

  /** The diagnostics exchange itself, against an initialized live client. */
  private async collectFrom(
    client: LspClient,
    key: string,
    spec: LspServerSpec,
    root: string,
    filePath: string,
    content: string,
    budgetMs: number,
    deadline: number,
  ): Promise<LspDiagnosticOutcome> {
    // Sampled BEFORE the collect: a cold client is the one that has to load the
    // project, and therefore the only one that can answer prematurely.
    const wasCold = !this.isWarm(key, spec, root);
    const uri = client.syncDocument(filePath, content);
    let diagnostics = await client.collectDiagnostics(uri, budgetMs);
    // Record WHICH build of the server went warm, so a later reclamation of it
    // is detectable rather than silently inherited as warm.
    this.warmKeys.set(key, this.pool.generationFor(spec, root));
    if (!client.isAlive) {
      this.pool.markDead(spec, root);
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
