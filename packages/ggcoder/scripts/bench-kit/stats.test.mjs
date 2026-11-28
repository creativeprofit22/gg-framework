import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { makeRng, seedFrom, shuffle } from "../../assets/bench-kit/lib/rng.mjs";
import { buildSchedule, positionCounts } from "../../assets/bench-kit/lib/schedule.mjs";
import {
  bootstrapRatio,
  clusteredStandardError,
  geomean,
  hierarchicalResample,
  madOutliers,
  madZScores,
  normalQuantile,
  pairedBootstrap,
  passAtK,
  percentile,
  pilotRepetitions,
  rankProbability,
  summarize,
  tukey,
  wilson,
  zForLevel,
} from "../../assets/bench-kit/lib/stats.mjs";

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

describe("ported known values (bench/search/stats.mjs parity)", () => {
  it("percentile type 7", () => {
    const xs = [15, 20, 35, 40, 50];
    close(percentile(xs, 50), 35);
    close(percentile(xs, 40), 29);
    close(percentile(xs, 90), 46);
    close(percentile(xs, 0), 15);
    close(percentile(xs, 100), 50);
    close(percentile([1, 2, 3, 4], 25), 1.75);
    close(percentile([50, NaN, 15, 40, undefined, 20, 35], 50), 35);
    assert.equal(percentile([], 50), undefined);
  });

  it("summarize reports p50/p90/p95/p99/max and cv", () => {
    const s = summarize(Array.from({ length: 101 }, (_, i) => i));
    assert.equal(s.n, 101);
    close(s.p50, 50);
    close(s.p95, 95);
    close(s.p99, 99);
    assert.equal(s.max, 100);
    assert.ok(s.cv > 0);
  });

  it("mulberry32 is deterministic per seed and matches the search bench sequence", () => {
    const a = makeRng(42);
    const b = makeRng(42);
    for (let i = 0; i < 5; i++) assert.equal(a(), b());
    assert.notEqual(makeRng(1)(), makeRng(2)());
    // First draw of mulberry32(42), identical to bench/search/stats.mjs.
    close(makeRng(42)(), 0.6011037519201636, 0);
  });

  it("hierarchical resample draws only existing leaves", () => {
    const out = hierarchicalResample([[[1, 2], [3]], [[4, 5, 6]]], makeRng(7));
    for (const x of out) assert.ok([1, 2, 3, 4, 5, 6].includes(x));
  });

  it("bootstrapRatio recovers 2× and is reproducible", () => {
    const groups = (s) => [
      [
        [10 * s, 11 * s, 9 * s],
        [10 * s, 12 * s],
      ],
      [
        [11 * s, 10 * s],
        [9 * s, 10 * s, 11 * s],
      ],
    ];
    const ci = bootstrapRatio(groups(2), groups(1), { resamples: 2_000 });
    close(ci.point, 2);
    assert.ok(ci.lower > 1);
    assert.deepEqual(
      bootstrapRatio(groups(2), groups(1), { resamples: 500, seed: 9 }),
      bootstrapRatio(groups(2), groups(1), { resamples: 500, seed: 9 }),
    );
  });

  it("Wilson interval matches the search bench at 0 and n", () => {
    const zero = wilson(0, 100);
    assert.equal(zero.rate, 0);
    assert.equal(zero.lower, 0);
    assert.ok(zero.upper > 0 && zero.upper < 0.05);
    close(zero.upper, 0.036994, 1e-6);
    assert.equal(wilson(100, 100).upper, 1);
    assert.equal(wilson(0, 0).rate, undefined);
    const half = wilson(5, 10);
    close(half.lower, 0.236593, 1e-6);
    close(half.upper, 0.763407, 1e-6);
  });

  it("pilot sizing", () => {
    const r = pilotRepetitions([9, 10, 11]);
    close(r.cv, 0.1);
    assert.equal(r.repeats, 16);
    assert.equal(pilotRepetitions([5]).repeats, 30);
  });
});

describe("normal quantile", () => {
  it("is exact at common levels and accurate elsewhere", () => {
    assert.equal(zForLevel(0.95), 1.959963984540054);
    close(normalQuantile(0.5), 0, 1e-9);
    close(normalQuantile(0.9875), 2.241402727604945, 1e-7); // Bonferroni, 2 comparisons
    close(normalQuantile(0.01), -2.3263478740408408, 1e-7);
  });
});

describe("paired bootstrap", () => {
  const byItem = (scale) => ({
    a: [10, 11, 9, 10, 10.5].map((x) => x * scale),
    b: [100, 104, 98, 101, 99].map((x) => x * scale),
  });
  it("weighs items of different scale equally (geometric mean of per-item ratios)", () => {
    const ci = pairedBootstrap(byItem(2), byItem(1), { resamples: 1_000 });
    close(ci.point, 2);
    assert.ok(ci.lower > 1.5 && ci.upper < 2.5);
    assert.equal(ci.items, 2);
  });
  it("orients higher-is-better and difference scales", () => {
    close(pairedBootstrap(byItem(1), byItem(1.5), { better: "higher", resamples: 200 }).point, 1.5);
    const d = pairedBootstrap(
      { t: [0, 1, 0, 1] },
      { t: [1, 1, 1, 1] },
      { statistic: "mean", better: "higher", scale: "difference", resamples: 200 },
    );
    close(d.point, 0.5);
  });
  it("same-vs-same gives an interval containing 1", () => {
    const ci = pairedBootstrap(byItem(1), byItem(1), { resamples: 1_000 });
    close(ci.point, 1);
    assert.ok(ci.lower <= 1 && ci.upper >= 1);
  });
  it("is deterministic and reports no interval without shared items", () => {
    assert.deepEqual(
      pairedBootstrap(byItem(2), byItem(1), { resamples: 100, seed: 3 }),
      pairedBootstrap(byItem(2), byItem(1), { resamples: 100, seed: 3 }),
    );
    assert.equal(pairedBootstrap({ a: [1] }, { b: [1] }).point, undefined);
  });
});

describe("rank probability, pass@k, clustered SE, outliers", () => {
  it("rank probability favours the clearly fastest and sums to 1", () => {
    const p = rankProbability(
      {
        fast: { x: [1, 1.1, 0.9], y: [10, 11, 9] },
        mid: { x: [2, 2.1, 1.9], y: [20, 21, 19] },
        slow: { x: [3, 3.1, 2.9], y: [30, 31, 29] },
      },
      { resamples: 300 },
    );
    assert.ok(p.fast > 0.99);
    close(p.fast + p.mid + p.slow, 1, 1e-9);
  });
  it("pass@k matches the closed form", () => {
    close(passAtK(10, 3, 1), 0.3);
    close(passAtK(5, 1, 2), 0.4); // 1 - C(4,2)/C(5,2) = 1 - 6/10
    assert.equal(passAtK(5, 4, 2), 1);
    assert.equal(passAtK(5, 0, 2), 0);
    assert.equal(passAtK(3, 1, 4), undefined);
  });
  it("clustered SE grows when repeats of a task agree", () => {
    const values = [1, 1, 1, 0, 0, 0];
    const clustered = clusteredStandardError(values, ["a", "a", "a", "b", "b", "b"]);
    const independent = clusteredStandardError(values, ["a", "b", "c", "d", "e", "f"]);
    assert.ok(clustered > independent);
    assert.equal(clusteredStandardError([1, 2], ["a", "a"]), undefined);
  });
  it("Tukey labels and MAD z-scores flag the same gross outlier", () => {
    const xs = [10, 10.2, 9.9, 10.1, 10, 9.8, 10.3, 40];
    const t = tukey(xs);
    assert.equal(t.labels[7], "high severe");
    assert.equal(t.outliers, 1);
    const flagged = madOutliers(xs);
    assert.deepEqual(
      flagged.map((f) => f.value),
      [40],
    );
    assert.deepEqual(madZScores([5, 5, 5]), [0, 0, 0]);
  });
  it("geomean rejects non-positive values", () => {
    close(geomean([1, 4]), 2);
    assert.equal(geomean([1, 0]), undefined);
  });
});

describe("seeded schedule", () => {
  it("rotates every candidate through every position equally", () => {
    const slots = buildSchedule({
      candidates: ["a", "b", "c"],
      items: ["x"],
      repeats: 6,
      warmupRepeats: 1,
      seed: 5,
    });
    assert.equal(slots.length, 21);
    assert.equal(slots.filter((s) => s.phase === "warmup").length, 3);
    for (const row of Object.values(positionCounts(slots))) assert.deepEqual(row, [2, 2, 2]);
  });
  it("is deterministic per seed and differs across seeds", () => {
    const opts = { candidates: ["a", "b", "c"], items: ["x", "y"], repeats: 3 };
    assert.deepEqual(buildSchedule({ ...opts, seed: 1 }), buildSchedule({ ...opts, seed: 1 }));
    const order = (seed) =>
      buildSchedule({ ...opts, seed })
        .map((s) => s.candidate + s.item)
        .join();
    assert.notEqual(order(1), order(2));
  });
  it("seedFrom and shuffle are stable", () => {
    assert.equal(seedFrom("abc"), seedFrom("abc"));
    assert.deepEqual(shuffle([1, 2, 3, 4], makeRng(1)), shuffle([1, 2, 3, 4], makeRng(1)));
  });
});
