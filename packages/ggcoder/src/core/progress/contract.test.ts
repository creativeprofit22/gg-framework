import { describe, expect, it } from "vitest";
import { isProgressSnapshot, parseProgressSnapshot } from "@kenkaiiii/gg-core/progress-contract";
import { buildSnapshot } from "./ranks.js";
import { createEmptyProgress } from "./store.js";

const snapshot = () => buildSnapshot(createEmptyProgress(new Date("2026-07-01T12:00:00Z")));

describe("shared progress contract", () => {
  it("accepts real producer snapshots, including max-level and live rank-up data", () => {
    const file = createEmptyProgress(new Date("2026-07-01T12:00:00Z"));
    for (const xp of [0, 303, 100_000, 1e12]) {
      file.xp = xp;
      expect(isProgressSnapshot(buildSnapshot(file))).toBe(true);
    }
    expect(
      isProgressSnapshot({
        ...snapshot(),
        origin: true,
        eventNonce: "award",
        levelUp: { from: 1, to: 2, rankName: "Tinkerer" },
      }),
    ).toBe(true);
  });
  it("accepts legacy snapshots without inventing cap metadata", () => {
    const { maxLevel: _maxLevel, ...legacy } = snapshot();
    expect(parseProgressSnapshot(legacy)).toEqual(legacy);
    expect(parseProgressSnapshot(legacy).maxLevel).toBeUndefined();
  });
  it("rejects every missing required field", () => {
    const valid = snapshot();
    for (const key of Object.keys(valid)) {
      if (key === "origin" || key === "maxLevel") continue;
      const broken = { ...valid } as Record<string, unknown>;
      delete broken[key];
      expect(isProgressSnapshot(broken), key).toBe(false);
    }
  });
  it("rejects missing or malformed nested fields", () => {
    for (const group of ["streak", "totals", "xpBySource"] as const) {
      for (const key of Object.keys(snapshot()[group])) {
        for (const bad of [undefined, null, "0", {}, -1, NaN, Infinity]) {
          const valid = snapshot();
          expect(
            isProgressSnapshot({ ...valid, [group]: { ...valid[group], [key]: bad } }),
            `${group}.${key}`,
          ).toBe(false);
        }
      }
    }
  });
  it.each([
    { percent: 101 },
    { level: 0 },
    { maxLevel: 0 },
    { maxLevel: null },
    { maxLevel: "1000" },
    { maxLevel: 1.5 },
    { maxLevel: Infinity },
    { maxLevel: 1, level: 2 },
    { xp: Infinity },
    { xpForLevel: NaN },
    { origin: "true" },
    { eventNonce: {} },
    { rankName: {} },
    { levelUp: { from: 1, to: 2 } },
    { ladder: [null] },
    { ladder: [{}] },
  ])("rejects malformed display and celebration data: %j", (patch) => {
    expect(() => parseProgressSnapshot({ ...snapshot(), ...patch })).toThrow(
      "invalid progress snapshot",
    );
  });
});
