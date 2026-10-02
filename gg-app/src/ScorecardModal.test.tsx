import { describe, expect, it } from "vitest";
import { milestoneFor } from "./ScorecardModal";

describe("milestoneFor (decade ladder)", () => {
  it("brackets a value between round 1/2/5 milestones", () => {
    expect(milestoneFor(957, 10)).toMatchObject({ prev: 500, next: 1000 });
    expect(milestoneFor(24_727, 100)).toMatchObject({ prev: 20_000, next: 50_000 });
    expect(milestoneFor(522_118, 1000)).toMatchObject({ prev: 500_000, next: 1_000_000 });
  });

  it("starts at the base milestone for a brand-new account", () => {
    expect(milestoneFor(0, 100)).toMatchObject({ prev: 0, next: 100 });
    expect(milestoneFor(0, 100).percent).toBe(2);
  });

  it("empties the bar right after a milestone is cleared", () => {
    // 999 → 1000 commits is the last sliver; 1001 restarts the climb to 2000.
    expect(milestoneFor(999, 10).percent).toBe(100);
    expect(milestoneFor(1001, 10)).toMatchObject({ prev: 1000, next: 2000, percent: 2 });
  });

  it("never pegs, however large the value gets", () => {
    for (const value of [1e4, 1e6, 1e8, 1e10]) {
      const m = milestoneFor(value, 100);
      expect(m.next).toBeGreaterThan(value);
      expect(m.percent).toBeLessThan(100);
    }
  });

  it("keeps the bar moving at a visible pace", () => {
    // At ~298 prompts/day a band must not be so wide the bar looks frozen.
    // ~1%/day, and the whole band cleared in a season rather than a decade.
    const { prev, next } = milestoneFor(24_727, 100);
    const perDay = (298 / (next - prev)) * 100;
    expect(perDay).toBeGreaterThan(0.5);
    expect((next - prev) / 298).toBeLessThan(180);
  });
});

describe("milestoneFor (streak ladder)", () => {
  const STREAK = [3, 7, 14, 30, 60, 100, 180, 365, 730, 1095];

  it("uses calendar goals", () => {
    expect(milestoneFor(37, STREAK)).toMatchObject({ prev: 30, next: 60 });
    expect(milestoneFor(1, STREAK)).toMatchObject({ prev: 0, next: 3 });
    expect(milestoneFor(365, STREAK)).toMatchObject({ prev: 365, next: 730 });
  });

  it("continues in whole years past the fixed ladder", () => {
    expect(milestoneFor(1095, STREAK)).toMatchObject({ prev: 1095, next: 1460 });
    expect(milestoneFor(1500, STREAK)).toMatchObject({ prev: 1460, next: 1825 });
  });
});
