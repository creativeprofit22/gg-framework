/**
 * One background poller per key, shared by every subscriber.
 *
 * The app's daemon runs one session per window, and each window used to poll
 * its repo on its own: git status every 5s, GitHub issue/PR counts every 60s,
 * CI every 15–60s. Two windows on the same repo did all of it twice. Here the
 * first subscriber for a key starts the poller, later ones join it (and get
 * the last value at once), and the last one to leave stops it.
 */

/** A running poller: `refresh` asks for a check now, `stop` ends it for good. */
export interface Poller {
  refresh(): void | Promise<void>;
  stop(): void;
}

export interface SharedSubscription {
  /** Check now (e.g. after an agent run). Shared: one check serves every subscriber. */
  refresh(): void;
  /** Leave. The poller stops when its last subscriber leaves. */
  unsubscribe(): void;
}

export interface SharedPolls<T> {
  subscribe(key: string, listener: (value: T) => void): SharedSubscription;
  /** Number of running pollers. */
  size(): number;
}

interface Listener<T> {
  readonly fn: (value: T) => void;
}

interface Entry<T> {
  readonly listeners: Set<Listener<T>>;
  latest: { value: T } | undefined;
  poller: Poller | undefined;
}

export function createSharedPolls<T>(
  start: (key: string, publish: (value: T) => void) => Poller,
): SharedPolls<T> {
  const entries = new Map<string, Entry<T>>();

  function entryFor(key: string): Entry<T> {
    const existing = entries.get(key);
    if (existing) return existing;
    const entry: Entry<T> = { listeners: new Set(), latest: undefined, poller: undefined };
    entries.set(key, entry);
    entry.poller = start(key, (value) => {
      // A poller that was stopped mid-request must not publish into a new one.
      if (entries.get(key) !== entry) return;
      entry.latest = { value };
      for (const listener of [...entry.listeners]) listener.fn(value);
    });
    return entry;
  }

  return {
    subscribe(key, fn) {
      const entry = entryFor(key);
      const listener: Listener<T> = { fn };
      entry.listeners.add(listener);
      if (entry.latest) {
        // Async, so a subscriber can finish wiring up before its first value.
        queueMicrotask(() => {
          if (entry.latest && entry.listeners.has(listener)) fn(entry.latest.value);
        });
      }
      let left = false;
      return {
        refresh() {
          if (!left) void entry.poller?.refresh();
        },
        unsubscribe() {
          if (left) return;
          left = true;
          entry.listeners.delete(listener);
          if (entry.listeners.size > 0 || entries.get(key) !== entry) return;
          entries.delete(key);
          entry.poller?.stop();
        },
      };
    },
    size: () => entries.size,
  };
}

/**
 * Fixed-cadence poller: first check after `firstDelayMs`, then every
 * `intervalMs` after the previous check settles. `fetch` returning null (or
 * throwing) publishes nothing, so subscribers keep their last-known value.
 */
export function startIntervalPoll<T>(opts: {
  fetch: () => Promise<T | null>;
  publish: (value: T) => void;
  firstDelayMs: number;
  intervalMs: number;
}): Poller {
  let stopped = false;
  let busy = false;
  let timer: NodeJS.Timeout | undefined;
  const schedule = (delay: number): void => {
    clearTimeout(timer);
    timer = setTimeout(() => void refresh(), delay);
    timer.unref?.();
  };
  const refresh = async (): Promise<void> => {
    // A check already in flight answers this request too.
    if (stopped || busy) return;
    busy = true;
    clearTimeout(timer);
    try {
      const value = await opts.fetch();
      if (value !== null && !stopped) opts.publish(value);
    } catch {
      // Transient (offline, timeout, git lock): keep the last-known value.
    } finally {
      busy = false;
      if (!stopped) schedule(opts.intervalMs);
    }
  };
  schedule(opts.firstDelayMs);
  return {
    refresh,
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
