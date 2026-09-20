import { describe, expect, it } from "vitest";
import { buildSnapshot, MAX_LEVEL, rankForLevel, rankLadder, xpForLevel } from "../../../packages/ggcoder/src/core/progress/ranks";
import type { ProgressFile } from "../../../packages/ggcoder/src/core/progress/types";
import { isProgressSnapshot } from "../../../packages/gg-core/src/progress-contract";
import { responses } from "../capture-screenshots.mjs";
import { fixtureResponses } from "./fixtures.mjs";
import { canonicalProgressScenarios, progressSeed } from "./progress-fixtures.mjs";

// JSON round-trip matches the transport the browser actually receives.
const wire = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

describe("canonical chat preview progress", () => {
  it("overrides only the chat sample with the real 18,240 XP snapshot", () => {
    const inherited = structuredClone(responses.agent_progress);
    const seed = progressSeed() as ProgressFile;
    const snapshot = wire(fixtureResponses().agent_progress);
    expect(snapshot).toEqual(buildSnapshot(seed));
    expect(snapshot).toMatchObject({ level: 25, maxLevel: 1000, rankName: "Netrunner",
      tier: 5, tierName: "Vibe", tierGlyph: "✦", effectId: "gradient", xp: 18_240,
      xpIntoLevel: 993, xpForLevel: 1117, percent: 88,
      xpBySource: { prompts: 9820, commits: 6410, streakBonus: 2010 } });
    expect(responses.agent_progress).toEqual(inherited);
    snapshot.ladder.pop();
    expect(fixtureResponses().agent_progress.ladder).toHaveLength(145);
  });

  it.each(Object.entries(canonicalProgressScenarios()))("%s agrees with the producer and full ladder contract", (_name, scenario) => {
    const { seed, snapshot } = scenario as { seed: ProgressFile; snapshot: ReturnType<typeof buildSnapshot> };
    const before = structuredClone(seed);
    expect(wire(snapshot)).toEqual(buildSnapshot(seed));
    expect(seed).toEqual(before);
    expect(isProgressSnapshot(wire(snapshot))).toBe(true);
    expect(Object.values(snapshot.xpBySource).reduce((sum, xp) => sum + xp, 0)).toBe(snapshot.xp);
    expect(snapshot.ladder).toEqual(rankLadder());
    expect(snapshot.ladder).toHaveLength(145);
    expect(new Set(snapshot.ladder.map((entry) => entry.name)).size).toBe(145);
    expect(snapshot.ladder[0].level).toBe(1);
    expect(snapshot.ladder[49].level).toBe(50);
    expect(snapshot.ladder[50].level).toBe(51);
    expect(snapshot.ladder.at(-1)?.level).toBe(991);
    snapshot.ladder.forEach((entry, index) => {
      const rank = rankForLevel(entry.level);
      expect(entry).toEqual({ level: rank.level, name: rank.name, tier: rank.tier,
        tierName: rank.tierName, effectId: rank.effectId, xpRequired: xpForLevel(entry.level) });
      if (index) expect(entry.xpRequired).toBeGreaterThan(snapshot.ladder[index - 1].xpRequired);
    });
  });

  it("covers a real tier boundary, gold effect and cap without editing rank metadata", () => {
    const scenarios = canonicalProgressScenarios();
    expect(scenarios.tierBefore.snapshot).toMatchObject({ level: 25, tierName: "Vibe", percent: 99 });
    expect(scenarios.tierTransition.snapshot).toMatchObject({ level: 26, rankName: "Cipher", tierName: "Deep",
      effectId: "gradient-glow", xpIntoLevel: 0, percent: 0,
      levelUp: { from: 25, to: 26, rankName: "Cipher" }, eventNonce: "chat-preview-tier-25-26" });
    expect(scenarios.tierTransition.snapshot.xp).toBe(scenarios.tierBefore.snapshot.xp + 1);
    expect(scenarios.gold.snapshot).toMatchObject({ level: 36, rankName: "Shellmaster", tierName: "Root", effectId: "gold", xpIntoLevel: 740 });
    expect(scenarios.maximum.snapshot).toMatchObject({ level: MAX_LEVEL, maxLevel: MAX_LEVEL,
      rankName: "Origin", tierName: "Origin", effectId: "origin", xp: xpForLevel(MAX_LEVEL),
      xpIntoLevel: 0, xpForLevel: 1, percent: 100 });
  });
});
