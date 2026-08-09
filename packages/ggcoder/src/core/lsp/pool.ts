import { log } from "../logger.js";
import { LspClient } from "./client.js";
import type { LspServerSpec } from "./servers.js";

/**
 * Process-wide pool of language-server clients, shared by every `LspManager`
 * in the daemon and reclaimed when idle.
 *
 * Two separate costs made LSP the heaviest thing in the app, and each needs a
 * different mechanism:
 *
 *  - **Duplication.** Every `AgentSession` built its own `LspManager`, so two
 *    windows open on one repo ran two complete tsserver stacks over identical
 *    files. Fixed by keying clients on (server, project root) for the whole
 *    process and REFERENCE COUNTING the managers holding them, so one session
 *    closing cannot pull a server out from under another.
 *  - **Pinning.** A manager's map had no expiry, so any root ever touched kept
 *    its server resident for the daemon's lifetime — measured at two roots with
 *    no window open at all, holding ~330 MB between them. Fixed by the idle
 *    sweep: a server unused for `idleTtlMs` is shut down even while sessions
 *    still hold it, because agent edits arrive in bursts and the next burst can
 *    afford a cold start (`firstBudgetMs` already assumes one).
 *
 * Holders are tracked as objects rather than counts so that `retain` is
 * idempotent: a manager calls it on every diagnostics pass and stays exactly
 * one reference, and an idle-evicted entry can be rebuilt without the old
 * bookkeeping leaking into the new one.
 */

/** Outcome of asking for a client: ready, or why it cannot be used. */
export type PooledClient =
  | { status: "ready"; client: LspClient }
  | { status: "unavailable" | "server_failed" };

interface PoolEntry {
  key: string;
  /** Resolves once the spawn+initialize attempt settles. */
  pending: Promise<PooledClient>;
  /** Managers currently holding this entry. Size is the reference count. */
  holders: Set<object>;
  /** Diagnostics passes in flight, so the idle sweep cannot evict mid-call. */
  activeCalls: number;
  lastUsedAt: number;
  /** Which build of this server this entry is; see `generationFor`. */
  generation: number;
}

/**
 * How long a server may sit unused before it is reclaimed. Long enough to cover
 * a normal think-edit-verify rhythm, short enough that a project the user has
 * moved on from stops costing hundreds of megabytes.
 */
const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 30 * 1000;
const INIT_TIMEOUT_MS = 10_000;

export interface LspClientPoolOptions {
  idleTtlMs?: number;
  sweepIntervalMs?: number;
}

/**
 * Stable identity per catalog entry. Two sessions share the module-level
 * catalog, so the same spec object means the same server; a test injecting its
 * own spec gets its own pool entries instead of colliding with another test's
 * fixture on the same id and root.
 */
const specIds = new WeakMap<LspServerSpec, string>();
let nextSpecId = 0;

function specIdentity(spec: LspServerSpec): string {
  let id = specIds.get(spec);
  if (!id) {
    id = `${spec.id}#${nextSpecId++}`;
    specIds.set(spec, id);
  }
  return id;
}

export class LspClientPool {
  private readonly entries = new Map<string, PoolEntry>();
  /**
   * Build counter per key, kept OUTSIDE `entries` so it survives eviction —
   * that is the whole point: it tells a caller its warm server is gone.
   */
  private readonly generations = new Map<string, number>();
  private readonly idleTtlMs: number;
  private readonly sweepIntervalMs: number;
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(options?: LspClientPoolOptions) {
    this.idleTtlMs = Math.max(0, options?.idleTtlMs ?? DEFAULT_IDLE_TTL_MS);
    this.sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
  }

  private keyFor(spec: LspServerSpec, root: string): string {
    return `${specIdentity(spec)}\u0000${root}`;
  }

  /**
   * Get-or-spawn the client for (spec, root) and record `holder` as retaining
   * it. Concurrent callers share one spawn: the entry and its pending promise
   * are registered synchronously before the first `await`.
   */
  async retain(spec: LspServerSpec, root: string, holder: object): Promise<PooledClient> {
    const key = this.keyFor(spec, root);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        key,
        pending: this.spawn(spec, root),
        holders: new Set(),
        activeCalls: 0,
        lastUsedAt: Date.now(),
        generation: (this.generations.get(key) ?? 0) + 1,
      };
      this.generations.set(key, entry.generation);
      this.entries.set(key, entry);
      this.startSweep();
    }
    entry.holders.add(holder);

    const resolved = await entry.pending;
    // Only a WORKING server counts as use. A failure stays cached so a broken
    // toolchain is not respawned on every write — the long-standing contract —
    // but its timestamp is left alone so the idle sweep can retire it like any
    // other stale entry. Without that, a pooled failure would outlive every
    // session in the daemon and disable diagnostics for that root permanently,
    // where pre-pool a new session simply got a fresh manager and retried.
    if (resolved.status === "ready") entry.lastUsedAt = Date.now();
    return resolved;
  }

  /**
   * Identity of the server currently live for (spec, root), or 0 when none is.
   *
   * A caller records this alongside its own "I have warmed this server" state,
   * and a later mismatch means the server it warmed is gone. Reporting the LIVE
   * entry rather than the next build number is essential: callers ask before
   * `retain`, when a reclaimed server has not been rebuilt yet, and a stale
   * number there would look like a match and hand a cold server a warm budget.
   */
  generationFor(spec: LspServerSpec, root: string): number {
    return this.entries.get(this.keyFor(spec, root))?.generation ?? 0;
  }

  /**
   * Mark a diagnostics pass as in flight against (spec, root), returning the
   * function that ends it. A first-file pass can take seconds; without this the
   * sweep could shut the server down while it was still answering.
   */
  beginCall(spec: LspServerSpec, root: string): () => void {
    const entry = this.entries.get(this.keyFor(spec, root));
    if (!entry) return () => {};
    entry.activeCalls += 1;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      entry.activeCalls = Math.max(0, entry.activeCalls - 1);
      entry.lastUsedAt = Date.now();
    };
  }

  /**
   * Record that this client died after starting, so later passes report
   * `server_failed` instead of talking to a corpse.
   *
   * The failure is CACHED rather than cleared, preserving the pre-pool
   * contract: a server that dies on a document is not respawned on every
   * following write. The dead process is reaped either way.
   */
  markDead(spec: LspServerSpec, root: string): void {
    const key = this.keyFor(spec, root);
    const entry = this.entries.get(key);
    if (!entry) return;
    const dead = entry.pending;
    entry.pending = Promise.resolve({ status: "server_failed" });
    void dead
      .then((resolved) => {
        if (resolved.status === "ready") resolved.client.terminate();
      })
      .catch(() => {});
  }

  /**
   * Drop `holder`'s claim on every entry it retained. Servers still held by
   * another manager keep running; those left with no holders shut down now
   * rather than waiting for the idle sweep, because a disposed session is
   * proof the work is over.
   */
  release(holder: object): void {
    for (const entry of [...this.entries.values()]) {
      if (!entry.holders.delete(holder)) continue;
      if (entry.holders.size === 0) this.evict(entry, "last holder released");
    }
    if (this.entries.size === 0) this.stopSweep();
  }

  /** Shut every pooled server down regardless of holders (process exit). */
  shutdownAll(): void {
    for (const entry of [...this.entries.values()]) this.evict(entry, "pool shutdown");
    this.stopSweep();
  }

  /** Live pooled servers. Test/diagnostic use. */
  get size(): number {
    return this.entries.size;
  }

  /** Reference count for one (spec, root), or 0 when nothing is pooled. */
  refCount(spec: LspServerSpec, root: string): number {
    return this.entries.get(this.keyFor(spec, root))?.holders.size ?? 0;
  }

  /**
   * Retained stderr of a server `holder` is using. Diagnostic probe for tests
   * and failure reporting — a server's own last words are usually the only
   * explanation of why it went quiet.
   */
  async stderrTail(holder: object): Promise<string> {
    for (const entry of [...this.entries.values()]) {
      if (!entry.holders.has(holder)) continue;
      const resolved = await entry.pending.catch(() => undefined);
      if (resolved?.status === "ready") return resolved.client.stderrTail();
    }
    return "";
  }

  /** Force one idle sweep. Exposed so tests need not wait on the interval. */
  sweepNow(now = Date.now()): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.activeCalls > 0) continue;
      if (now - entry.lastUsedAt < this.idleTtlMs) continue;
      this.evict(entry, `idle for ${Math.round((now - entry.lastUsedAt) / 1000)}s`);
    }
    if (this.entries.size === 0) this.stopSweep();
  }

  private evict(entry: PoolEntry, reason: string): void {
    // Only remove the entry if it is still the live one for its key, so a
    // rebuild that raced this eviction is not torn down by it.
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    log("INFO", "lsp", "releasing pooled language server", { key: entry.key, reason });
    void entry.pending
      .then((resolved) => {
        if (resolved.status === "ready") resolved.client.shutdown();
      })
      .catch(() => {});
  }

  /**
   * The sweep only runs while something is pooled, and is unref'd so it can
   * never hold the CLI (or a test worker) open on its own.
   */
  private startSweep(): void {
    if (this.sweepTimer || this.idleTtlMs === 0) return;
    this.sweepTimer = setInterval(() => this.sweepNow(), this.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  private stopSweep(): void {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  private async spawn(spec: LspServerSpec, root: string): Promise<PooledClient> {
    const command = spec.resolveCommand(root);
    if (!command) {
      log("INFO", "lsp", `${spec.id} language server not available`, { root });
      return { status: "unavailable" };
    }
    // `client` is declared outside the try so one that fails to initialize can
    // still be killed. `new LspClient` SPAWNS the process, so discarding the
    // reference on a throw leaked the server forever — one orphan per
    // (server, root) every time initialize timed out. Invisible on POSIX; on
    // Windows the orphan keeps handles open in the project directory.
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
        // The server's own last words — usually the only explanation of why the
        // handshake never completed.
        stderr: client?.stderrTail() || "(none)",
      });
      client?.terminate();
      return { status: "server_failed" };
    }
  }
}

/** The daemon-wide pool. One per process, which is exactly the sharing scope. */
export const lspClientPool = new LspClientPool();
