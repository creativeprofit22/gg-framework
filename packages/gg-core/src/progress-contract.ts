/** Shared daemon-global progress DTO, used by both RPC and live event consumers. */
export interface LevelUpEvent {
  from: number;
  to: number;
  rankName: string;
}

export interface RankLadderEntry {
  /** First level at which this rank is earned. */
  level: number;
  name: string;
  tier: number;
  tierName: string;
  effectId: string;
  xpRequired: number;
}

export interface ProgressSnapshot {
  level: number;
  /** Authoritative producer cap. Absent on legacy payloads: terminal state is unknown. */
  maxLevel?: number;
  rankName: string;
  tier: number;
  tierName: string;
  tierGlyph: string;
  effectId: string;
  xp: number;
  xpIntoLevel: number;
  xpForLevel: number;
  /** 0–100 percent toward the next level, or 100 at the maximum level. */
  percent: number;
  streak: { current: number; best: number };
  totals: { prompts: number; commits: number; linesShipped: number; projects: number };
  xpBySource: { prompts: number; commits: number; streakBonus: number };
  memberSince: string;
  ladder: RankLadderEntry[];
  levelUp: LevelUpEvent | null;
  /** Award identity used to deduplicate celebrations. */
  eventNonce: string | null;
  /** Only present on live frames; gates window-local feedback. */
  origin?: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function level(value: unknown): value is number {
  return count(value) && Number.isInteger(value) && value >= 1;
}

function counts(value: unknown, keys: string[]): boolean {
  return record(value) && keys.every((key) => count(value[key]));
}

/** Reject errors/partial data rather than manufacturing a zero-XP account.
 * Unknown extra fields are allowed for forward-compatible producer additions.
 */
export function isProgressSnapshot(value: unknown): value is ProgressSnapshot {
  if (!record(value)) return false;
  return (
    level(value.level) &&
    (value.maxLevel === undefined ||
      (level(value.maxLevel) && value.maxLevel >= value.level)) &&
    count(value.tier) &&
    Number.isInteger(value.tier) &&
    ["rankName", "tierName", "tierGlyph", "effectId", "memberSince"].every(
      (key) => typeof value[key] === "string",
    ) &&
    ["xp", "xpIntoLevel", "xpForLevel", "percent"].every((key) => count(value[key])) &&
    (value.percent as number) <= 100 &&
    counts(value.streak, ["current", "best"]) &&
    counts(value.totals, ["prompts", "commits", "linesShipped", "projects"]) &&
    counts(value.xpBySource, ["prompts", "commits", "streakBonus"]) &&
    Array.isArray(value.ladder) &&
    value.ladder.every(
      (entry: unknown) =>
        record(entry) &&
        level(entry.level) &&
        count(entry.tier) &&
        Number.isInteger(entry.tier) &&
        count(entry.xpRequired) &&
        ["name", "tierName", "effectId"].every((key) => typeof entry[key] === "string"),
    ) &&
    (value.levelUp === null ||
      (record(value.levelUp) &&
        level(value.levelUp.from) &&
        level(value.levelUp.to) &&
        typeof value.levelUp.rankName === "string")) &&
    (value.eventNonce === null || typeof value.eventNonce === "string") &&
    (value.origin === undefined || typeof value.origin === "boolean")
  );
}

export function parseProgressSnapshot(value: unknown): ProgressSnapshot {
  if (!isProgressSnapshot(value)) {
    throw new Error(
      "Progress is unavailable: the daemon returned an invalid progress snapshot. Try again after restarting the app.",
    );
  }
  return value;
}
