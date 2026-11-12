import { describe, expect, it } from "vitest";
import type { VerifyGate, VerifyPlan } from "@kenkaiiii/gg-core/verify-plan";
import {
  findGateQuietBudgetSeconds,
  handOffNotice,
  inactiveHint,
  resolveQuietBudgetMs,
} from "./quiet-budget.js";

function gate(id: string, argv: string[], quietBudgetSeconds: number | null): VerifyGate {
  return {
    id,
    argv,
    cwd: ".",
    covers: [],
    fingerprint: null,
    quietBudgetSeconds,
    protectedPaths: [],
  };
}

function plan(...gates: VerifyGate[]): VerifyPlan {
  return { version: 1, mode: "changed", gates, advice: [] };
}

describe("findGateQuietBudgetSeconds", () => {
  const verify = plan(gate("unit", ["pnpm", "test"], 1800), gate("lint", ["pnpm", "lint"], null));

  it("returns the budget of the gate whose argv matches exactly", () => {
    expect(findGateQuietBudgetSeconds(verify, "pnpm test")).toBe(1800);
    expect(findGateQuietBudgetSeconds(verify, "  pnpm test\n")).toBe(1800);
  });

  it("does not match a lookalike or a gate without a budget", () => {
    expect(findGateQuietBudgetSeconds(verify, "pnpm test --watch")).toBeNull();
    expect(findGateQuietBudgetSeconds(verify, "pnpm  test")).toBeNull();
    expect(findGateQuietBudgetSeconds(verify, "pnpm lint")).toBeNull();
    expect(findGateQuietBudgetSeconds(verify, "")).toBeNull();
  });

  it("returns null without a plan", () => {
    expect(findGateQuietBudgetSeconds(null, "pnpm test")).toBeNull();
    expect(findGateQuietBudgetSeconds(undefined, "pnpm test")).toBeNull();
  });
});

describe("resolveQuietBudgetMs", () => {
  it("prefers the gate budget over the setting", () => {
    expect(resolveQuietBudgetMs({ settingsSeconds: 600, gateSeconds: 1800 })).toBe(1_800_000);
  });

  it("falls back to the setting", () => {
    expect(resolveQuietBudgetMs({ settingsSeconds: 600, gateSeconds: null })).toBe(600_000);
  });

  it("treats 0 as no quiet notice", () => {
    expect(resolveQuietBudgetMs({ settingsSeconds: 0, gateSeconds: null })).toBeNull();
  });
});

describe("result hints", () => {
  it("names run_in_background with a wake and an explicit timeout, not a setting", () => {
    const hint = inactiveHint({ persistent: false });
    expect(hint).toContain("run_in_background=true");
    expect(hint).toContain("wake.silence_seconds");
    expect(hint).toContain("explicit timeout");
    expect(hint).not.toContain("bashInactivitySeconds");
    expect(hint).not.toContain("persist");
  });

  it("tells a persist caller that persist keeps the silence limit", () => {
    expect(inactiveHint({ persistent: true })).toContain("drop persist");
  });

  it("says silence only notifies and names the hard limit", () => {
    const text = handOffNotice({
      id: "abc",
      elapsed: "2 min",
      hardLimit: "60 min",
      quietNotice: true,
    });
    expect(text).toContain('task_output with id="abc"');
    expect(text).toContain("Silence only sends you a notice");
    expect(text).toContain("never stops");
    expect(text).toContain("hard limit (60 min in total)");
    expect(text).not.toMatch(/stretch with no output/);
    expect(
      handOffNotice({ id: "abc", elapsed: "2 min", hardLimit: null, quietNotice: true }),
    ).toContain("no hard limit");
  });

  it("promises no silence notice when none can be delivered", () => {
    const text = handOffNotice({
      id: "abc",
      elapsed: "2 min",
      hardLimit: "60 min",
      quietNotice: false,
    });
    expect(text).not.toContain("sends you a notice");
    expect(text).toContain("never stops the command, but no notice will arrive");
    expect(text).toContain("task_output wait_ms");
    expect(text).toContain("hard limit (60 min in total)");
  });
});
