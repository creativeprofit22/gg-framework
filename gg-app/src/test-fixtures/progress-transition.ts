import { buildSnapshot, rankForLevel, xpForLevel } from "../../../packages/ggcoder/src/core/progress/ranks";
import type { ProgressFile } from "../../../packages/ggcoder/src/core/progress/types";

/** Pure backend producer fixture: no awards, store access, or persisted changes. */
export function progressTransition(from: number, to: number, nonce = `${from}-${to}`) {
  const file: ProgressFile = {
    v: 1, xp: xpForLevel(to), createdAt: "2026-07-01T00:00:00Z",
    totals: { prompts: 0, commits: 0, linesShipped: 0, projects: [] },
    xpBySource: { prompts: 0, commits: 0, streakBonus: 0 },
    streak: { current: 0, best: 0, lastActiveDay: "" },
    rolling: { promptTimes: [], commitTimes: [], dayXp: 0, dayKey: "" },
    repos: {}, patchIds: [], sig: "",
    lastEvent: { nonce, levelUp: { from, to, rankName: rankForLevel(to).name } },
  };
  return buildSnapshot(file);
}
