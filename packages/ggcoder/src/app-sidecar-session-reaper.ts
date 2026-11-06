import type { DisposableSessionContext } from "./app-sidecar-session-router.js";

export interface IdleSessionSnapshot {
  listeners: number;
  busy: boolean;
  waitingOnUser: boolean;
  holdsLease: boolean;
  lastActivityAt: number;
  lastRunSettledAt: number | null;
}

export interface ReapableSessionContext extends DisposableSessionContext {
  idleSnapshot: () => IdleSessionSnapshot;
}

export interface ReapableSessionRouter<TContext extends ReapableSessionContext> {
  entries: () => IterableIterator<[string, TContext]>;
  takeIf: (sessionId: string, predicate: (context: TContext) => boolean) => TContext | undefined;
  disposeTaken: (context: TContext) => Promise<void>;
}

export interface IntervalHandle {
  unref?: () => unknown;
}

export interface SessionReaperOptions<TContext extends ReapableSessionContext, THandle> {
  router: ReapableSessionRouter<TContext>;
  now: () => number;
  setInterval: (callback: () => void, ms: number) => THandle;
  clearInterval: (handle: THandle) => void;
  /** Current timeout in ms; 0 or less turns cleanup off. */
  readTimeoutMs: () => number | Promise<number>;
  /** Returns a release function, or null while the daemon is reloading. */
  tryAcquireMutation: () => (() => void) | null;
  intervalMs?: number;
  graceMs?: number;
  onReaped?: (sessionId: string, idleMs: number) => void;
  onError?: (sessionId: string, error: unknown) => void;
}

export interface SessionReaper {
  start: () => void;
  stop: () => void;
  tick: () => Promise<string[]>;
}

export const DEFAULT_REAP_INTERVAL_MS = 60_000;
export const DEFAULT_REAP_GRACE_MS = 60_000;

export function isSessionReapable(
  snapshot: IdleSessionSnapshot,
  now: number,
  timeoutMs: number,
  graceMs: number,
): boolean {
  if (!(timeoutMs > 0)) return false;
  if (snapshot.listeners > 0 || snapshot.busy || snapshot.waitingOnUser || snapshot.holdsLease) {
    return false;
  }
  if (now - snapshot.lastActivityAt < timeoutMs) return false;
  if (snapshot.lastRunSettledAt !== null && now - snapshot.lastRunSettledAt < graceMs) {
    return false;
  }
  return true;
}

export function createSessionReaper<
  TContext extends ReapableSessionContext,
  THandle extends IntervalHandle,
>(options: SessionReaperOptions<TContext, THandle>): SessionReaper {
  const intervalMs = options.intervalMs ?? DEFAULT_REAP_INTERVAL_MS;
  const graceMs = options.graceMs ?? DEFAULT_REAP_GRACE_MS;
  let handle: THandle | null = null;
  let inFlight: Promise<string[]> | null = null;

  async function runTick(): Promise<string[]> {
    const timeoutMs = await options.readTimeoutMs();
    if (!(timeoutMs > 0)) return [];
    const release = options.tryAcquireMutation();
    if (!release) return [];
    const reaped: string[] = [];
    try {
      const candidates = [...options.router.entries()]
        .filter(([, context]) =>
          isSessionReapable(context.idleSnapshot(), options.now(), timeoutMs, graceMs),
        )
        .map(([sessionId]) => sessionId)
        .sort();
      for (const sessionId of candidates) {
        let idleMs = 0;
        // Re-check at the moment of closing: an earlier disposal may have let this session wake up.
        const context = options.router.takeIf(sessionId, (candidate) => {
          const snapshot = candidate.idleSnapshot();
          const now = options.now();
          idleMs = now - snapshot.lastActivityAt;
          return isSessionReapable(snapshot, now, timeoutMs, graceMs);
        });
        if (!context) continue;
        try {
          await options.router.disposeTaken(context);
        } catch (error) {
          options.onError?.(sessionId, error);
        }
        reaped.push(sessionId);
        options.onReaped?.(sessionId, idleMs);
      }
    } finally {
      release();
    }
    return reaped;
  }

  function tick(): Promise<string[]> {
    if (inFlight) return inFlight;
    const current = runTick().finally(() => {
      inFlight = null;
    });
    inFlight = current;
    return current;
  }

  return {
    start() {
      if (handle !== null) return;
      handle = options.setInterval(() => {
        tick().catch((error: unknown) => options.onError?.("", error));
      }, intervalMs);
      handle.unref?.();
    },
    stop() {
      if (handle === null) return;
      options.clearInterval(handle);
      handle = null;
    },
    tick,
  };
}
