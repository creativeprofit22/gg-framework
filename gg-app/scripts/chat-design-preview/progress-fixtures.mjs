import { buildSnapshot, MAX_LEVEL, rankForLevel, xpForLevel } from "../../../packages/ggcoder/src/core/progress/ranks.ts";

/** Deterministic in-memory input only. Never import the progress store or award engine. */
export function progressSeed(xp = 18_240, lastEvent = null) {
  return {
    v: 1,
    xp,
    createdAt: "2026-01-14T00:00:00.000Z",
    totals: { prompts: 1284, commits: 337, linesShipped: 91240,
      projects: Array.from({ length: 7 }, (_, index) => `synthetic-project-${index + 1}`) },
    xpBySource: { prompts: xp - 6410 - 2010, commits: 6410, streakBonus: 2010 },
    streak: { current: 9, best: 21, lastActiveDay: "2026-09-18" },
    rolling: { promptTimes: [], commitTimes: [], dayXp: 0, dayKey: "2026-09-18" },
    repos: {}, patchIds: [], sig: "", lastEvent,
  };
}

// All scenarios pass through the real pure producer; no hand-maintained rank DTOs.
export function canonicalProgressScenarios() {
  const seeds = {
    normal: progressSeed(),
    tierBefore: progressSeed(xpForLevel(26) - 1),
    tierTransition: progressSeed(xpForLevel(26), {
      nonce: "chat-preview-tier-25-26",
      levelUp: { from: 25, to: 26, rankName: rankForLevel(26).name },
    }),
    gold: progressSeed(xpForLevel(36) + 740),
    maximum: progressSeed(xpForLevel(MAX_LEVEL)),
  };
  return Object.fromEntries(Object.entries(seeds).map(([name, seed]) => [name, { seed, snapshot: buildSnapshot(seed) }]));
}

export function normalProgressSnapshot() {
  return buildSnapshot(progressSeed());
}
