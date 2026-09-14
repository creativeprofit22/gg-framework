// Progress ("Ranks") system — shared types for the XP engine, store, and broadcast snapshot.

/** Rank-up event embedded in the file so watcher-side sidecars can re-broadcast it once. */
export interface LevelUpEvent {
  from: number;
  to: number;
  rankName: string;
}

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

/** One named rank of the 1000-level ladder, as sent to the webview. */
export interface RankLadderEntry {
  /** First level at which this rank is earned (ranks span 10 levels above level 50). */
  level: number;
  name: string;
  tier: number;
  tierName: string;
  effectId: string;
  /** Cumulative XP required to reach this level. */
  xpRequired: number;
}

/** What the sidecar broadcasts/serves — the webview renders this verbatim. */
export interface ProgressSnapshot {
  level: number;
  rankName: string;
  tier: number;
  tierName: string;
  tierGlyph: string;
  effectId: string;
  xp: number;
  xpIntoLevel: number;
  xpForLevel: number;
  /** 0–100 percent toward the next level. */
  percent: number;
  streak: { current: number; best: number };
  totals: {
    prompts: number;
    commits: number;
    linesShipped: number;
    projects: number;
  };
  xpBySource: {
    prompts: number;
    commits: number;
    streakBonus: number;
  };
  memberSince: string;
  ladder: RankLadderEntry[];
  levelUp: LevelUpEvent | null;
  /** Nonce of the award event this snapshot was produced by (for celebration dedupe). */
  eventNonce: string | null;
  /** True only on the SSE frame sent to the window whose run earned the XP.
   *  Gates window-local feedback (sounds, XP chips); absent on GET /progress. */
  origin?: boolean;
}

/** A commit that passed detection filters and is ready to be scored. */
export interface ScoredCommit {
  sha: string;
  patchId: string;
  linesChanged: number;
}
