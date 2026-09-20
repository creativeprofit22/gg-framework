// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RankBadge } from "./RankBadge";
import { ScorecardModal } from "./ScorecardModal";
import { buildSnapshot, MAX_LEVEL, xpForLevel } from "../../packages/ggcoder/src/core/progress/ranks";
import { createEmptyProgress } from "../../packages/ggcoder/src/core/progress/store";

afterEach(cleanup);

function snapshotAt(xp: number) {
  const file = createEmptyProgress(new Date("2026-07-01T12:00:00Z"));
  file.xp = xp;
  return buildSnapshot(file);
}

describe("rank cap presentation", () => {
  it("keeps ordinary progress below the authoritative cap", () => {
    const snapshot = snapshotAt(xpForLevel(MAX_LEVEL) - 1);
    const { container } = render(<><RankBadge snapshot={snapshot} onClick={() => {}} /><ScorecardModal snapshot={snapshot} onClose={() => {}} /></>);
    expect((container.querySelector(".rank-badge") as HTMLButtonElement).title).toContain("3560/3561 XP to next");
    expect(document.querySelector(".scorecard-level-row")?.textContent).toContain(`${new Intl.NumberFormat().format(3560)} / ${new Intl.NumberFormat().format(3561)} XP · 99%`);
    expect((document.querySelector(".scorecard-bar span") as HTMLElement).style.width).toBe("99%");
  });

  it.each([1, 50, 1000])("does not infer a legacy cap from level %i or its sentinel", (level) => {
    const { maxLevel: _maxLevel, ...legacy } = snapshotAt(xpForLevel(MAX_LEVEL) + 100);
    legacy.level = level;
    const { container } = render(<><RankBadge snapshot={legacy} onClick={() => {}} /><ScorecardModal snapshot={legacy} onClose={() => {}} /></>);
    const title = (container.querySelector(".rank-badge") as HTMLButtonElement).title;
    expect(title).toContain("lifetime XP");
    expect(title).not.toMatch(/to next|Maximum level|100\/1/);
    expect(document.querySelector(".scorecard-level-row")?.textContent).toBe("Level100%");
    expect(screen.getByText(`${new Intl.NumberFormat().format(legacy.xp)} lifetime XP`)).toBeTruthy();
    expect((document.querySelector(".scorecard-bar span") as HTMLElement).style.width).toBe("100%");
  });

  it("uses producer metadata rather than a frontend level policy", () => {
    const snapshot = { ...snapshotAt(303), maxLevel: 2, percent: 100 };
    const { container } = render(<><RankBadge snapshot={snapshot} onClick={() => {}} /><ScorecardModal snapshot={snapshot} onClose={() => {}} /></>);
    expect((container.querySelector(".rank-badge") as HTMLButtonElement).title).toContain("Maximum level");
    expect(screen.getByText("Maximum level · 100%")).toBeTruthy();
  });
  it.each([0, 100])("shows maximum level at cap + %i XP without a next-level fraction", (extra) => {
    const snapshot = snapshotAt(xpForLevel(MAX_LEVEL) + extra);
    const { container } = render(<><RankBadge snapshot={snapshot} onClick={() => {}} /><ScorecardModal snapshot={snapshot} onClose={() => {}} /></>);
    const title = (container.querySelector(".rank-badge") as HTMLButtonElement).title;
    expect(title).toContain("Maximum level");
    expect(title).toContain(`${new Intl.NumberFormat().format(snapshot.xp)} lifetime XP`);
    expect(title).not.toContain("to next");
    expect(title).not.toContain("/1");
    expect(screen.getByText("Maximum level · 100%")).toBeTruthy();
    expect(screen.getByText(`${new Intl.NumberFormat().format(snapshot.xp)} lifetime XP`)).toBeTruthy();
    expect(document.querySelector(".scorecard-level-row")?.textContent).not.toContain(" / ");
    expect((document.querySelector(".scorecard-bar span") as HTMLElement).style.width).toBe("100%");
  });
});
