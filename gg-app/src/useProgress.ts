// XP/rank progress state for one pane: initial GET /progress paint, then live
// `progress` SSE frames (broadcast by the sidecar to EVERY window on any award,
// including awards earned in other windows). `levelUpNonce` changes exactly once
// per level-up event so the UI can fire the toast + confetti celebration once.
import { useEffect, useRef, useState } from "react";
import { isProgressSnapshot } from "@kenkaiiii/gg-core/progress-contract";
import {
  type PaneAgentClient,
  type LevelUpEvent,
  type ProgressSnapshot,
  type SidecarEvent,
} from "./agent";

export interface LevelTransition extends LevelUpEvent {
  rankChanged: boolean;
  tierChanged: boolean;
}

// Resolve against the event's own ladder, never a later refreshed snapshot.
function resolveTransition(event: LevelUpEvent, ladder: ProgressSnapshot["ladder"]): LevelTransition {
  const atLevel = (level: number) => ladder.reduce<ProgressSnapshot["ladder"][number] | undefined>(
    (best, entry) => entry.level <= level && (!best || entry.level > best.level) ? entry : best,
    undefined,
  );
  const from = atLevel(event.from);
  const to = atLevel(event.to);
  // Legacy/empty ladders cannot prove a rank or tier crossing.
  return {
    ...event,
    rankName: to?.name ?? event.rankName,
    rankChanged: !!from && !!to && from.name !== to.name,
    tierChanged: !!from && !!to && from.tier !== to.tier,
  };
}

export interface ProgressState {
  snapshot: ProgressSnapshot | null;
  /** Set when the latest frame carried a level-up; nonce dedupes celebrations. */
  levelUp: LevelTransition | null;
  levelUpNonce: string | null;
  /** True when the level-up was earned by THIS window's run (gates sound). */
  levelUpOrigin: boolean;
}

export function useProgress(client: Pick<PaneAgentClient, "getProgress" | "subscribe">): ProgressState {
  const [snapshot, setSnapshot] = useState<ProgressSnapshot | null>(null);
  const [levelUp, setLevelUp] = useState<LevelTransition | null>(null);
  const [levelUpNonce, setLevelUpNonce] = useState<string | null>(null);
  const [levelUpOrigin, setLevelUpOrigin] = useState(false);
  // Nonces already celebrated (or present at initial load — never re-celebrate).
  const seenNonces = useRef<Set<string>>(new Set());

  useEffect(() => {
    let disposed = false;
    setSnapshot(null);
    setLevelUp(null);
    setLevelUpNonce(null);
    setLevelUpOrigin(false);
    seenNonces.current.clear();
    // A live frame supersedes the initial request, even if its reply arrives later.
    // Keep this local to the effect so replacement clients can initialize anew.
    let acceptedLiveProgress = false;

    void client.getProgress()
      .then((snap) => {
        if (disposed || acceptedLiveProgress || !isProgressSnapshot(snap)) return;
        if (snap.eventNonce) seenNonces.current.add(snap.eventNonce);
        setSnapshot(snap);
      })
      .catch(() => {
        // Sidecar unavailable — badge stays hidden until the first frame.
      });

    const unsubscribe = client.subscribe((e: SidecarEvent) => {
      if (disposed || e.type !== "progress" || !isProgressSnapshot(e.data)) return;
      const snap = e.data;
      acceptedLiveProgress = true;
      setSnapshot(snap);
      const nonce = snap.eventNonce;
      if (snap.levelUp && nonce && !seenNonces.current.has(nonce)) {
        seenNonces.current.add(nonce);
        setLevelUp(resolveTransition(snap.levelUp, snap.ladder));
        setLevelUpNonce(nonce);
        setLevelUpOrigin(snap.origin === true);
      }
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [client]);

  return { snapshot, levelUp, levelUpNonce, levelUpOrigin };
}
