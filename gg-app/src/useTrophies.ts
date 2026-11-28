// Trophies for one pane: the initial GET /trophies paint, then live
// `trophies` frames (the sidecar sends one to every session whenever a counter
// moves). A frame that earned trophies carries their ids and a nonce; the
// session whose action earned them (`origin`) queues them to celebrate, once.
// Local Fork: pane-scoped like useProgress, so each pane reads through its own
// client and only the earning pane celebrates.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PaneAgentClient, SidecarEvent, Trophy, TrophySnapshot } from "./agent";

export interface TrophiesState {
  snapshot: TrophySnapshot | null;
  /** Earned trophies waiting to be celebrated, oldest first. */
  queue: Trophy[];
  /** The front of the queue has been shown; move on to the next. */
  shift: () => void;
}

/** Shape check for frames from the sidecar; a malformed one is ignored. */
export function isTrophySnapshot(value: unknown): value is TrophySnapshot {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.trophies) &&
    v.trophies.every(
      (t) =>
        typeof t === "object" &&
        t !== null &&
        typeof (t as { id?: unknown }).id === "string" &&
        typeof (t as { title?: unknown }).title === "string",
    ) &&
    Array.isArray(v.categories) &&
    typeof v.earned === "number" &&
    typeof v.total === "number" &&
    Array.isArray(v.unlocked) &&
    v.unlocked.every((id) => typeof id === "string") &&
    (v.eventNonce === null || typeof v.eventNonce === "string")
  );
}

/** The newly earned trophies a frame should celebrate here, or none. */
export function trophiesToCelebrate(snap: TrophySnapshot, seen: Set<string>): Trophy[] {
  const nonce = snap.eventNonce;
  if (!nonce || snap.unlocked.length === 0 || seen.has(nonce)) return [];
  seen.add(nonce);
  if (snap.origin !== true) return [];
  const ids = new Set(snap.unlocked);
  return snap.trophies.filter((t) => ids.has(t.id));
}

export function useTrophies(
  client: Pick<PaneAgentClient, "getTrophies" | "subscribe">,
): TrophiesState {
  const [snapshot, setSnapshot] = useState<TrophySnapshot | null>(null);
  const [queue, setQueue] = useState<Trophy[]>([]);
  const seen = useRef<Set<string>>(new Set());

  useEffect(() => {
    let disposed = false;
    setSnapshot(null);
    setQueue([]);
    seen.current.clear();
    // A live frame supersedes the initial request, even if its reply arrives later.
    let acceptedLive = false;
    void client
      .getTrophies()
      .then((snap) => {
        if (disposed || acceptedLive || !isTrophySnapshot(snap)) return;
        if (snap.eventNonce) seen.current.add(snap.eventNonce);
        setSnapshot(snap);
      })
      .catch(() => {
        // Sidecar unavailable: the key stays hidden until the first frame.
      });
    const unsubscribe = client.subscribe((e: SidecarEvent) => {
      if (disposed || e.type !== "trophies" || !isTrophySnapshot(e.data)) return;
      const snap = e.data;
      acceptedLive = true;
      setSnapshot(snap);
      const fresh = trophiesToCelebrate(snap, seen.current);
      if (fresh.length > 0) setQueue((q) => [...q, ...fresh]);
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [client]);

  const shift = useCallback(() => setQueue((q) => q.slice(1)), []);
  return { snapshot, queue, shift };
}
