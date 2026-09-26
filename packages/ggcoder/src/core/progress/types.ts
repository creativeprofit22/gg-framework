// Progress ("Ranks") system — shared types for the XP engine, store, and broadcast snapshot.

import type { LevelUpEvent } from "@kenkaiiii/gg-core/progress-contract";
export type {
  LevelUpEvent,
  RankLadderEntry,
  ProgressSnapshot,
} from "@kenkaiiii/gg-core/progress-contract";

/** Last award event marker — nonce lets other windows dedupe celebrations. */
export interface ProgressLastEvent {
  nonce: string;
  levelUp: LevelUpEvent | null;
}

/** Durable on-disk progress file (~/.gg/progress.json), versioned + HMAC-signed. */
export interface ProgressFile {
  v: 1;
  xp: number;
  createdAt: string;
  totals: {
    prompts: number;
    commits: number;
    linesShipped: number;
    /** Hashed project cwds the user has earned XP in. */
    projects: string[];
  };
  xpBySource: {
    prompts: number;
    commits: number;
    streakBonus: number;
  };
  streak: {
    current: number;
    best: number;
    /** Local calendar day (YYYY-MM-DD) of the last XP event. */
    lastActiveDay: string;
  };
  rolling: {
    /** Epoch-ms timestamps of prompt awards in the last hour. */
    promptTimes: number[];
    /** Epoch-ms timestamps of XP-earning commits in the last hour. */
    commitTimes: number[];
    /** XP earned so far today (for the daily soft cap). */
    dayXp: number;
    /** Local calendar day (YYYY-MM-DD) dayXp belongs to. */
    dayKey: string;
  };
  /** Per-repo last seen HEAD, keyed by repo-root hash. */
  repos: Record<string, { lastHead: string }>;
  /** Ring buffer of git patch-ids already scored (cap 500). */
  patchIds: string[];
  lastEvent: ProgressLastEvent | null;
  /** HMAC-SHA256 of canonical JSON minus this field. */
  sig: string;
}

/** A commit that passed detection filters and is ready to be scored. */
export interface ScoredCommit {
  sha: string;
  patchId: string;
  linesChanged: number;
}
