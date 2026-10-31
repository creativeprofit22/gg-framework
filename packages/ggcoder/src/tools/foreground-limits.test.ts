import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXIT_SETTLE_MS,
  DEFAULT_FOREGROUND_LIMIT_SETTINGS,
  resolveForegroundLimits,
  type ForegroundLimits,
  type ResolveForegroundLimitsInput,
} from "./foreground-limits.js";

const base: ResolveForegroundLimitsInput = {
  settings: DEFAULT_FOREGROUND_LIMIT_SETTINGS,
  platform: "linux",
  mode: "spawn",
  canHandOff: true,
};

describe("resolveForegroundLimits", () => {
  const cases: Array<[string, Partial<ResolveForegroundLimitsInput>, Partial<ForegroundLimits>]> = [
    [
      "defaults yield, inactivity and hard limits",
      {},
      { yieldMs: 120_000, inactivityMs: 600_000, hardMs: 3_600_000 },
    ],
    [
      "explicit timeout becomes the hard limit and replaces yield and the silence limit",
      { explicitTimeoutMs: 30_000 },
      { yieldMs: null, inactivityMs: null, hardMs: 30_000 },
    ],
    [
      "zero settings disable every layer",
      { settings: { yieldSeconds: 0, inactivitySeconds: 0, hardLimitMinutes: 0 } },
      { yieldMs: null, inactivityMs: null, hardMs: null },
    ],
    [
      "win32 raises short yields to the platform minimum",
      { platform: "win32", settings: { ...DEFAULT_FOREGROUND_LIMIT_SETTINGS, yieldSeconds: 1 } },
      { yieldMs: 10_000 },
    ],
    ["win32 keeps longer yields", { platform: "win32" }, { yieldMs: 120_000 }],
    ["persistent mode never yields", { mode: "persistent" }, { yieldMs: null, hardMs: 3_600_000 }],
    ["no hand-off target never yields", { canHandOff: false }, { yieldMs: null }],
    [
      "explicit zero timeout disables yield and hard limit",
      { explicitTimeoutMs: 0 },
      { yieldMs: null, hardMs: null, inactivityMs: null },
    ],
    [
      "a gate quiet budget overrides the silence setting",
      { quietBudgetSeconds: 1800 },
      { yieldMs: 120_000, inactivityMs: 1_800_000, hardMs: 3_600_000 },
    ],
    [
      "persist keeps the gate quiet budget as its silence limit",
      { mode: "persistent", quietBudgetSeconds: 900 },
      { yieldMs: null, inactivityMs: 900_000 },
    ],
    [
      "an explicit timeout still wins over a gate quiet budget",
      { explicitTimeoutMs: 30_000, quietBudgetSeconds: 1800 },
      { inactivityMs: null, hardMs: 30_000 },
    ],
  ];

  it.each(cases)("%s", (_name, overrides, expected) => {
    const limits = resolveForegroundLimits({ ...base, ...overrides });
    expect(limits).toMatchObject({ ...expected, exitSettleMs: DEFAULT_EXIT_SETTLE_MS });
  });
});
