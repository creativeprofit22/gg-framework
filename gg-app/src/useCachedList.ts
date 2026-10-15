import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * A list a picker shows (projects, a project's sessions, chats, motion
 * sessions, goals). The first visit shows the skeleton while it loads. Every
 * visit after that shows the list as it was at once, then refreshes quietly in
 * the background and swaps in the new copy: no skeleton, no flash, the way
 * the goals list already behaved while its goals worked.
 *
 * The last copy is kept per window in sessionStorage, keyed by `key`, so a
 * trip into a session and back (which unmounts the picker) still finds it. It
 * lasts as long as the window does.
 */
export interface CachedList<T> {
  items: T[];
  /** Nothing to show yet: the first load for this key is still running. */
  loading: boolean;
  /** The last load failed and there's no earlier copy to fall back on. */
  error: string | null;
  /**
   * Refreshing failed (after retries) while an earlier copy is on screen, so
   * that copy may be out of date. Pickers say so instead of silently passing
   * an old list off as current.
   */
  refreshError: string | null;
  /** Load again; keeps showing the current copy meanwhile. */
  reload: () => void;
  /** Replace the shown copy (and the kept one) after a local change. */
  setItems: (update: (items: T[]) => T[]) => void;
}

const PREFIX = "gg-list:";

/**
 * A refresh behind a kept copy is retried after these delays before it is
 * reported. A list asked for while the window's daemon is still starting or
 * respawning fails transiently; giving up at once left that copy on screen
 * for good.
 */
export const REFRESH_RETRY_DELAYS_MS = [1_000, 3_000] as const;

function readKept<T>(key: string | null): T[] | null {
  if (!key) return null;
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : null;
  } catch {
    return null;
  }
}

function keep<T>(key: string, items: T[]): void {
  try {
    sessionStorage.setItem(PREFIX + key, JSON.stringify(items));
  } catch {
    // Storage full or unavailable: the next visit loads as a first visit.
  }
}

/**
 * `key` names the list (null while what to load isn't known yet, e.g. a
 * session list before its project is picked). `load` fetches it; a rejection's
 * message becomes `error` only when there's no kept copy to keep showing.
 */
export function useCachedList<T>(
  key: string | null,
  load: (signal: { cancelled: boolean }) => Promise<T[]>,
): CachedList<T> {
  const [state, setState] = useState<{
    key: string | null;
    items: T[];
    loading: boolean;
    error: string | null;
    refreshError: string | null;
  }>(() => {
    const kept = readKept<T>(key);
    return {
      key,
      items: kept ?? [],
      loading: key !== null && kept === null,
      error: null,
      refreshError: null,
    };
  });
  const [nonce, setNonce] = useState(0);
  // The latest loader, read by the effect without making it re-run (and
  // re-fetch) on every render's new function.
  const loadRef = useRef(load);
  useLayoutEffect(() => {
    loadRef.current = load;
  });

  // A new key shows its own kept copy (or the skeleton) in the same render,
  // never the previous list's rows.
  if (state.key !== key) {
    const kept = readKept<T>(key);
    setState({
      key,
      items: kept ?? [],
      loading: key !== null && kept === null,
      error: null,
      refreshError: null,
    });
  }

  useEffect(() => {
    if (key === null) return;
    const signal = { cancelled: false };
    // A first load reports its failure at once (there is nothing else to
    // show); a refresh behind a kept copy retries first.
    const behindKeptCopy = readKept<T>(key) !== null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (retries: number): void => {
      loadRef
        .current(signal)
        .then((items) => {
          if (signal.cancelled) return;
          keep(key, items);
          setState({ key, items, loading: false, error: null, refreshError: null });
        })
        .catch((reason: unknown) => {
          if (signal.cancelled) return;
          const message = reason instanceof Error ? reason.message : String(reason);
          const delay = REFRESH_RETRY_DELAYS_MS[retries];
          if (behindKeptCopy && delay !== undefined) {
            retryTimer = setTimeout(() => attempt(retries + 1), delay);
            return;
          }
          setState((current) =>
            current.key !== key
              ? current
              : // A kept copy stays on screen, flagged as possibly out of
                // date; only a first load reports the error.
                current.loading
                ? { key, items: [], loading: false, error: message, refreshError: null }
                : { ...current, refreshError: message },
          );
        });
    };
    attempt(0);
    return () => {
      signal.cancelled = true;
      clearTimeout(retryTimer);
    };
  }, [key, nonce]);

  const reload = useCallback(() => {
    setState((current) =>
      current.error
        ? { ...current, loading: true, error: null, refreshError: null }
        : { ...current, refreshError: null },
    );
    setNonce((n) => n + 1);
  }, []);

  const setItems = useCallback((update: (items: T[]) => T[]) => {
    setState((current) => {
      const items = update(current.items);
      if (current.key) keep(current.key, items);
      return { ...current, items };
    });
  }, []);

  return {
    items: state.items,
    loading: state.loading,
    error: state.error,
    refreshError: state.refreshError,
    reload,
    setItems,
  };
}
