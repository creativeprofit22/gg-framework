// The 1000-level rank ladder: 145 named ranks across 29 tiers, with CSS effect ids
// and tier glyphs.
//
// Two paces, so nobody is ever re-ranked by an update:
//   • Levels 1–50 (the original ladder) — 10 tiers × 5 ranks, one rank per level.
//   • Levels 51–1000 (the long game)    — 19 tiers × 5 ranks, one rank per 10 levels.
// Names, tiers and XP costs below level 51 are byte-identical to the old 50-level
// ladder, so an existing Deity stays a Deity and simply keeps climbing.

import type { ProgressFile, ProgressSnapshot, RankLadderEntry } from "./types.js";

export const MAX_LEVEL = 1000;

/** Last level of the original one-rank-per-level ladder. */
const KNEE_LEVEL = 50;
/** Levels each rank spans above the knee. */
const LEVELS_PER_RANK = 10;
const RANKS_PER_TIER = 5;

interface TierDef {
  name: string;
  glyph: string;
  effectId: string;
  ranks: [string, string, string, string, string];
}

const TIERS: TierDef[] = [
  {
    name: "Boot",
    glyph: "○",
    effectId: "dim",
    ranks: ["Lurker", "Tinkerer", "Prompter", "Looper", "Scripter"],
  },
  {
    name: "Ship",
    glyph: "◇",
    effectId: "plain",
    ranks: ["Patcher", "Forker", "Merger", "Shipper", "Builder"],
  },
  {
    name: "Flow",
    glyph: "◆",
    effectId: "blue",
    ranks: ["Hacker", "Stacker", "Debugger", "Compiler", "Operator"],
  },
  {
    name: "Craft",
    glyph: "⬖",
    effectId: "green",
    ranks: ["Toolsmith", "Machinist", "Optimizer", "Artificer", "Architect"],
  },
  {
    name: "Vibe",
    glyph: "✦",
    effectId: "gradient",
    ranks: ["Vibesmith", "Codeslinger", "Bytebender", "Overclocker", "Netrunner"],
  },
  {
    name: "Deep",
    glyph: "✧",
    effectId: "gradient-glow",
    ranks: ["Cipher", "Daemon", "Phantom", "Glitch", "Specter"],
  },
  {
    name: "Arcane",
    glyph: "❖",
    effectId: "animated",
    ranks: ["Warlock", "Technomancer", "Codeweaver", "Archmage", "Oracle"],
  },
  {
    name: "Root",
    glyph: "⬢",
    effectId: "gold",
    ranks: ["Shellmaster", "Kernelghost", "Gitlord", "Mainframe", "Root"],
  },
  {
    name: "Myth",
    glyph: "★",
    effectId: "gold-shimmer",
    ranks: ["Basilisk", "Ascendant", "Sentinel", "Harbinger", "Titan"],
  },
  {
    name: "Beyond",
    glyph: "✹",
    effectId: "iridescent",
    ranks: ["Anomaly", "Entity", "Overmind", "Deity", "Singularity"],
  },
  // ── Past the Singularity: levels 51–1000, one rank per 10 levels. ──
  {
    name: "Supernova",
    glyph: "✶",
    effectId: "ember",
    ranks: ["Starforge", "Cataclysm", "Hypergiant", "Hypernova", "Supernova"],
  },
  {
    name: "Quasar",
    glyph: "✷",
    effectId: "ember",
    ranks: ["Blazecore", "Jetstream", "Starflare", "Radiance", "Quasar"],
  },
  {
    name: "Nebula",
    glyph: "❂",
    effectId: "nebula",
    ranks: ["Stardust", "Starbirth", "Veilspinner", "Auroral", "Nebulon"],
  },
  {
    name: "Horizon",
    glyph: "✺",
    effectId: "nebula",
    ranks: ["Accretion", "Gravwell", "Lightcage", "Eventline", "Horizon"],
  },
  {
    name: "Vortex",
    glyph: "✸",
    effectId: "rift",
    ranks: ["Maelstrom", "Spiralbound", "Whirlcore", "Cyclonic", "Vortex"],
  },
  {
    name: "Rift",
    glyph: "⬡",
    effectId: "rift",
    ranks: ["Fracture", "Seamripper", "Riftwalker", "Breachlord", "Worldrift"],
  },
  {
    name: "Void",
    glyph: "⬣",
    effectId: "void",
    ranks: ["Hollow", "Nullpointer", "Voidwalker", "Abyssal", "Voidcrown"],
  },
  {
    name: "Aether",
    glyph: "⧫",
    effectId: "aether",
    ranks: ["Etherborn", "Luminant", "Skyforge", "Aetherlord", "Empyrean"],
  },
  {
    name: "Eidolon",
    glyph: "⬟",
    effectId: "aether",
    ranks: ["Revenant", "Wraithcode", "Phantasm", "Soulforge", "Eidolon"],
  },
  {
    name: "Paradox",
    glyph: "✳",
    effectId: "prism",
    ranks: ["Recursor", "Loopbreaker", "Strangeloop", "Antilogic", "Paradox"],
  },
  {
    name: "Infinite",
    glyph: "∞",
    effectId: "prism",
    ranks: ["Unbounded", "Limitless", "Aleph", "Transfinite", "Infinitum"],
  },
  {
    name: "Eternal",
    glyph: "✴",
    effectId: "eternal",
    ranks: ["Ageless", "Timeless", "Eonkeeper", "Perpetual", "Eternal"],
  },
  {
    name: "Genesis",
    glyph: "✱",
    effectId: "eternal",
    ranks: ["Firstlight", "Sparkbearer", "Worldsmith", "Lifegiver", "Genesis"],
  },
  {
    name: "Zenith",
    glyph: "▲",
    effectId: "platinum",
    ranks: ["Summit", "Crestline", "Apex", "Pinnacle", "Zenith"],
  },
  {
    name: "Absolute",
    glyph: "◉",
    effectId: "platinum",
    ranks: ["Invariant", "Immutable", "Axiom", "Sovereign", "Absolute"],
  },
  {
    name: "Immortal",
    glyph: "❈",
    effectId: "radiant",
    ranks: ["Undying", "Deathless", "Phoenix", "Everflame", "Immortal"],
  },
  {
    name: "Transcendent",
    glyph: "❋",
    effectId: "radiant",
    ranks: ["Ethereal", "Sublime", "Numinous", "Apotheosis", "Transcendent"],
  },
  {
    name: "Omega",
    glyph: "Ω",
    effectId: "omega",
    ranks: ["Terminus", "Lastlight", "Endbringer", "Omegacore", "Omega"],
  },
  {
    name: "Origin",
    glyph: "✵",
    effectId: "origin",
    ranks: ["Firstcause", "Primemover", "Demiurge", "Worldseed", "Origin"],
  },
];

/** Cumulative XP to reach the knee — the last level of the original curve. */
const KNEE_XP = Math.round(100 * Math.pow(KNEE_LEVEL, 1.6));
/** Cost of the knee level itself (level 49 → 50), the step the long game inherits. */
const KNEE_STEP = KNEE_XP - Math.round(100 * Math.pow(KNEE_LEVEL - 1, 1.6));
/** Each level past the knee costs this much more than the one before it. */
const STEP_GROWTH = 2;

/**
 * Cumulative XP required to reach level n (level 1 = 0).
 *
 * Levels 2–50 keep the original 100 × N^1.6 curve untouched. Past the knee the
 * exponential would balloon to millions per level, so the cost switches to a linear
 * ramp that starts exactly at the knee step (~1.7k) and grows to ~3.6k at level 1000
 * — roughly 2.53M XP for the full climb, steady instead of a wall.
 */
export function xpForLevel(n: number): number {
  if (n <= 1) return 0;
  if (n <= KNEE_LEVEL) return Math.round(100 * Math.pow(n, 1.6));
  const past = n - KNEE_LEVEL;
  return KNEE_XP + KNEE_STEP * past + (STEP_GROWTH * past * (past - 1)) / 2;
}

/** Level for a cumulative XP total (1..MAX_LEVEL). */
export function levelForXp(xp: number): number {
  // Binary search — the ladder is 1000 rungs deep and this runs on every award.
  let low = 1;
  let high = MAX_LEVEL;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (xp >= xpForLevel(mid)) low = mid;
    else high = mid - 1;
  }
  return low;
}

export interface RankInfo {
  level: number;
  name: string;
  tier: number;
  tierName: string;
  tierGlyph: string;
  effectId: string;
}

/** Tier + rank slot for a level: one rank per level to the knee, then one per 10. */
function slotForLevel(level: number): { tierIndex: number; rankIndex: number } {
  if (level <= KNEE_LEVEL) {
    return {
      tierIndex: Math.floor((level - 1) / RANKS_PER_TIER),
      rankIndex: (level - 1) % RANKS_PER_TIER,
    };
  }
  const past = level - KNEE_LEVEL - 1;
  const rankSlot = Math.floor(past / LEVELS_PER_RANK);
  return {
    tierIndex: KNEE_LEVEL / RANKS_PER_TIER + Math.floor(rankSlot / RANKS_PER_TIER),
    rankIndex: rankSlot % RANKS_PER_TIER,
  };
}

/** Rank metadata for a level (clamped to 1..MAX_LEVEL). */
export function rankForLevel(level: number): RankInfo {
  const l = Math.min(Math.max(1, Math.floor(level)), MAX_LEVEL);
  const { tierIndex, rankIndex } = slotForLevel(l);
  const tier = TIERS[tierIndex];
  return {
    level: l,
    name: tier.ranks[rankIndex],
    tier: tierIndex + 1,
    tierName: tier.name,
    tierGlyph: tier.glyph,
    effectId: tier.effectId,
  };
}

/** Build the broadcast snapshot the webview renders verbatim. */
export function buildSnapshot(file: ProgressFile): ProgressSnapshot {
  const level = levelForXp(file.xp);
  const rank = rankForLevel(level);
  const floor = xpForLevel(level);
  const ceil = level >= MAX_LEVEL ? floor : xpForLevel(level + 1);
  const span = Math.max(1, ceil - floor);
  const into = Math.max(0, file.xp - floor);
  return {
    level,
    rankName: rank.name,
    tier: rank.tier,
    tierName: rank.tierName,
    tierGlyph: rank.tierGlyph,
    effectId: rank.effectId,
    xp: file.xp,
    xpIntoLevel: into,
    xpForLevel: span,
    percent: level >= MAX_LEVEL ? 100 : Math.min(100, Math.floor((into / span) * 100)),
    streak: { current: file.streak.current, best: file.streak.best },
    totals: {
      prompts: file.totals.prompts,
      commits: file.totals.commits,
      linesShipped: file.totals.linesShipped,
      projects: file.totals.projects.length,
    },
    xpBySource: { ...file.xpBySource },
    memberSince: file.createdAt,
    ladder: rankLadder(),
    levelUp: file.lastEvent?.levelUp ?? null,
    eventNonce: file.lastEvent?.nonce ?? null,
  };
}

/**
 * One entry per named rank (145 of them), not per level — above the knee a rank spans
 * 10 levels, so a per-level ladder would ship 1000 near-duplicate rungs on every frame.
 * `level` is the first level at which the rank is earned.
 */
export function rankLadder(): RankLadderEntry[] {
  const ladder: RankLadderEntry[] = [];
  for (let level = 1; level <= MAX_LEVEL; level += level <= KNEE_LEVEL ? 1 : LEVELS_PER_RANK) {
    const rank = rankForLevel(level);
    ladder.push({
      level,
      name: rank.name,
      tier: rank.tier,
      tierName: rank.tierName,
      effectId: rank.effectId,
      xpRequired: xpForLevel(level),
    });
  }
  return ladder;
}
