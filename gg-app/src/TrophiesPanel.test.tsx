// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("./agent", () => ({ getTrophies: vi.fn(), subscribe: vi.fn(() => () => {}) }));

import type { Trophy, TrophySnapshot } from "./agent";
import { TrophiesPanel } from "./TrophiesPanel";
import { trophiesToCelebrate } from "./useTrophies";
import { trophyTimeline } from "./TrophyUnlock";

afterEach(cleanup);

const trophy = (over: Partial<Trophy>): Trophy => ({
  id: "x",
  title: "X",
  tier: "bronze",
  category: "start",
  description: "What it is.",
  hint: "How to get it.",
  goal: 1,
  current: 0,
  unlockedAt: null,
  secret: false,
  ...over,
});

const snapshot = (trophies: Trophy[], over: Partial<TrophySnapshot> = {}): TrophySnapshot => ({
  trophies,
  categories: [
    { id: "start", label: "Getting started" },
    { id: "flow", label: "Working with GG" },
  ],
  earned: trophies.filter((t) => t.unlockedAt).length,
  total: trophies.length,
  unlocked: [],
  eventNonce: null,
  ...over,
});

describe("TrophiesPanel", () => {
  const snap = snapshot([
    trophy({ id: "slash", title: "Shortcut", unlockedAt: "2026-10-21T10:00:00.000Z", current: 1 }),
    trophy({
      id: "toolbelt",
      title: "Toolbelt",
      category: "flow",
      tier: "silver",
      goal: 5,
      current: 3,
    }),
  ]);

  it("opens on earned trophies, grouped by area, with when they were earned", () => {
    render(<TrophiesPanel snapshot={snap} onClose={() => {}} />);
    expect(screen.getByText("1 of 2 earned")).toBeTruthy();
    expect(screen.getByText("Shortcut")).toBeTruthy();
    expect(screen.getByText("Getting started")).toBeTruthy();
    expect(screen.getByText(/^Earned /)).toBeTruthy();
    expect(screen.queryByText("Toolbelt")).toBeNull();
  });

  it("shows how to earn the rest, with progress toward multi-step goals", () => {
    render(<TrophiesPanel snapshot={snap} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: /To earn/ }));
    expect(screen.getByText("Toolbelt")).toBeTruthy();
    expect(screen.getByText("How to get it.")).toBeTruthy();
    expect(screen.getByText("3 of 5")).toBeTruthy();
    const bar = screen.getByRole("progressbar", { name: "Toolbelt progress" });
    expect(bar.getAttribute("aria-valuenow")).toBe("3");
  });

  it("starts on what there is to earn when nothing is earned yet", () => {
    render(<TrophiesPanel snapshot={snapshot([trophy({ title: "First" })])} onClose={() => {}} />);
    expect(screen.getByRole("tab", { name: /To earn/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("First")).toBeTruthy();
  });

  it("closes from its header", () => {
    const onClose = vi.fn();
    render(<TrophiesPanel snapshot={snap} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close Trophies" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("trophiesToCelebrate", () => {
  const earned = trophy({ id: "slash", unlockedAt: "2026-10-21T10:00:00.000Z" });

  it("celebrates once, only in the window that earned it", () => {
    const seen = new Set<string>();
    const frame = snapshot([earned], { unlocked: ["slash"], eventNonce: "n1", origin: true });
    expect(trophiesToCelebrate(frame, seen).map((t) => t.id)).toEqual(["slash"]);
    expect(trophiesToCelebrate(frame, seen)).toEqual([]);
  });

  it("stays quiet in other windows and on plain refreshes", () => {
    const seen = new Set<string>();
    expect(
      trophiesToCelebrate(snapshot([earned], { unlocked: ["slash"], eventNonce: "n2" }), seen),
    ).toEqual([]);
    expect(trophiesToCelebrate(snapshot([earned], { origin: true }), seen)).toEqual([]);
  });
});

describe("trophyTimeline", () => {
  it("charges longer and spins more for rarer tiers", () => {
    const bronze = trophyTimeline("bronze");
    const platinum = trophyTimeline("platinum");
    expect(bronze.turns).toBe(1);
    expect(platinum.turns).toBe(4);
    expect(platinum.chargeFor).toBeGreaterThan(bronze.chargeFor);
    expect(platinum.end).toBeGreaterThan(bronze.end);
  });
});
