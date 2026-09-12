import { describe, expect, it } from "vitest";
import { MAX_LEVEL, levelForXp, rankForLevel, rankLadder, xpForLevel } from "./ranks.js";

describe("xpForLevel", () => {
  it("matches the 100 × N^1.6 curve up to the level-50 knee", () => {
    expect(xpForLevel(1)).toBe(0);
    expect(xpForLevel(2)).toBe(303);
    expect(xpForLevel(10)).toBe(3981);
    expect(xpForLevel(50)).toBe(52282);
  });

  it("continues past the knee at the knee's own step, then ramps", () => {
    // No cliff and no cheap level at the seam: level 51 costs what level 50 did.
    expect(xpForLevel(51) - xpForLevel(50)).toBe(xpForLevel(50) - xpForLevel(49));
    expect(xpForLevel(1000) - xpForLevel(999)).toBe(3561);
    // The full climb stays in reach: ~2.5M XP rather than the exponential's 6.3M.
    expect(xpForLevel(MAX_LEVEL)).toBe(2533682);
  });

  it("is strictly increasing with a monotonically growing step", () => {
    for (let n = 2; n <= MAX_LEVEL; n++) {
      expect(xpForLevel(n)).toBeGreaterThan(xpForLevel(n - 1));
    }
    for (let n = 52; n <= MAX_LEVEL; n++) {
      const step = xpForLevel(n) - xpForLevel(n - 1);
      const prevStep = xpForLevel(n - 1) - xpForLevel(n - 2);
      expect(step).toBeGreaterThan(prevStep);
    }
  });
});

describe("levelForXp", () => {
  it("returns 1 at 0 XP", () => {
    expect(levelForXp(0)).toBe(1);
  });

  it("crosses level boundaries exactly", () => {
    expect(levelForXp(302)).toBe(1);
    expect(levelForXp(303)).toBe(2);
    expect(levelForXp(3981)).toBe(10);
  });

  it("crosses boundaries above the knee too", () => {
    for (const level of [50, 51, 52, 137, 500, 999, 1000]) {
      expect(levelForXp(xpForLevel(level))).toBe(level);
      expect(levelForXp(xpForLevel(level) - 1)).toBe(level - 1);
    }
  });

  it("caps at MAX_LEVEL", () => {
    expect(MAX_LEVEL).toBe(1000);
    expect(levelForXp(10_000_000)).toBe(MAX_LEVEL);
  });
});

describe("rankForLevel", () => {
  it("names the tier boundaries correctly", () => {
    expect(rankForLevel(1).name).toBe("Lurker");
    expect(rankForLevel(5).name).toBe("Scripter");
    expect(rankForLevel(6).name).toBe("Patcher");
    expect(rankForLevel(20).name).toBe("Architect");
    expect(rankForLevel(25).name).toBe("Netrunner");
    expect(rankForLevel(50).name).toBe("Singularity");
  });

  it("holds one rank per 10 levels above the knee", () => {
    expect(rankForLevel(51).name).toBe("Starforge");
    expect(rankForLevel(60).name).toBe("Starforge");
    expect(rankForLevel(61).name).toBe("Cataclysm");
    expect(rankForLevel(100).name).toBe("Supernova");
    expect(rankForLevel(101).name).toBe("Blazecore");
    expect(rankForLevel(1000).name).toBe("Origin");
  });

  it("assigns tiers 1–29", () => {
    expect(rankForLevel(1).tier).toBe(1);
    expect(rankForLevel(5).tier).toBe(1);
    expect(rankForLevel(6).tier).toBe(2);
    expect(rankForLevel(50).tier).toBe(10);
    expect(rankForLevel(51).tier).toBe(11);
    expect(rankForLevel(100).tier).toBe(11);
    expect(rankForLevel(101).tier).toBe(12);
    expect(rankForLevel(1000).tier).toBe(29);
  });

  it("clamps out-of-range levels", () => {
    expect(rankForLevel(0).level).toBe(1);
    expect(rankForLevel(9999).level).toBe(1000);
  });
});

describe("rankLadder", () => {
  it("has 145 unique names with increasing xpRequired", () => {
    const ladder = rankLadder();
    expect(ladder).toHaveLength(145);
    expect(new Set(ladder.map((r) => r.name)).size).toBe(145);
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i].xpRequired).toBeGreaterThan(ladder[i - 1].xpRequired);
    }
  });

  it("lists the first level of every rank, covering the whole ladder", () => {
    const ladder = rankLadder();
    expect(ladder[0].level).toBe(1);
    expect(ladder[49].level).toBe(50);
    expect(ladder[50].level).toBe(51);
    expect(ladder[ladder.length - 1].level).toBe(991);
    for (const entry of ladder) {
      expect(rankForLevel(entry.level).name).toBe(entry.name);
    }
  });
});
