import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  autocorrelation,
  bootstrapRatio,
  hierarchicalResample,
  linearSlope,
  makeRng,
  percentile,
  pilotRepetitions,
  proportionCi,
  summarize,
  verdict,
} from "./stats.mjs";

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

describe("percentile (type 7)", () => {
  it("matches known answers", () => {
    const xs = [15, 20, 35, 40, 50];
    close(percentile(xs, 50), 35);
    close(percentile(xs, 40), 29); // h = 1.6 → 20 + 0.6·15
    close(percentile(xs, 90), 46); // h = 3.6 → 40 + 0.6·10
    close(percentile(xs, 0), 15);
    close(percentile(xs, 100), 50);
    close(percentile([1, 2, 3, 4], 25), 1.75);
  });
  it("is order-independent and ignores non-finite values", () => {
    close(percentile([50, NaN, 15, 40, undefined, 20, 35], 50), 35);
    assert.equal(percentile([], 50), undefined);
  });
  it("summarize reports p50/p90/p99/max", () => {
    const s = summarize(Array.from({ length: 101 }, (_, i) => i));
    assert.equal(s.n, 101);
    close(s.p50, 50);
    close(s.p90, 90);
    close(s.p99, 99);
    assert.equal(s.max, 100);
  });
});

describe("seeded rng and resampling", () => {
  it("is deterministic per seed", () => {
    const a = makeRng(42);
    const b = makeRng(42);
    for (let i = 0; i < 5; i++) assert.equal(a(), b());
    assert.notEqual(makeRng(1)(), makeRng(2)());
  });
  it("hierarchical resample keeps the shape and draws only existing leaves", () => {
    const groups = [[[1, 2], [3]], [[4, 5, 6]]];
    const out = hierarchicalResample(groups, makeRng(7));
    for (const x of out) assert.ok([1, 2, 3, 4, 5, 6].includes(x));
    // A constant tree always resamples to constants.
    assert.deepEqual(
      hierarchicalResample([[[2, 2]], [[2]]], makeRng(1)).every((x) => x === 2),
      true,
    );
  });
});

describe("bootstrapRatio", () => {
  const groups = (scale) => [
    [
      [10 * scale, 11 * scale, 9 * scale],
      [10 * scale, 12 * scale],
    ],
    [
      [11 * scale, 10 * scale],
      [9 * scale, 10 * scale, 11 * scale],
    ],
  ];
  it("recovers an exact 2× latency speedup with a CI that excludes 1", () => {
    const ci = bootstrapRatio(groups(2), groups(1), {
      metric: "p50_latency_ms",
      better: "lower",
      resamples: 2_000,
    });
    close(ci.point, 2);
    assert.ok(ci.lower > 1, `lower ${ci.lower}`);
    assert.ok(ci.lower <= 2 && ci.upper >= 2);
  });
  it("orients higher-is-better metrics so > 1 means the candidate is better", () => {
    const ci = bootstrapRatio(groups(1), groups(1.5), {
      metric: "calls_per_s",
      better: "higher",
      resamples: 2_000,
    });
    close(ci.point, 1.5);
  });
  it("A/A: identical data gives a CI containing 1", () => {
    const ci = bootstrapRatio(groups(1), groups(1), {
      metric: "calls_per_s",
      better: "higher",
      resamples: 2_000,
    });
    close(ci.point, 1);
    assert.ok(ci.lower <= 1 && ci.upper >= 1);
  });
  it("is reproducible for a fixed seed", () => {
    const a = bootstrapRatio(groups(2), groups(1), {
      metric: "p50_latency_ms",
      resamples: 500,
      seed: 9,
    });
    const b = bootstrapRatio(groups(2), groups(1), {
      metric: "p50_latency_ms",
      resamples: 500,
      seed: 9,
    });
    assert.deepEqual(a, b);
  });
});

describe("autocorrelation", () => {
  it("flags a trending series and passes alternating noise at lag 2", () => {
    const trend = Array.from({ length: 50 }, (_, i) => i);
    const acf = autocorrelation(trend, 5);
    assert.ok(acf.lags[0].r > 0.8);
    assert.equal(acf.independentLooking, false);
    const alt = Array.from({ length: 50 }, (_, i) => (i % 2 ? 1 : -1));
    close(autocorrelation(alt, 2).lags[0].r, -0.98);
  });
  it("handles constant series", () => {
    assert.equal(autocorrelation([3, 3, 3, 3], 2).lags[0].r, undefined);
  });
});

describe("pilot sizing, slope, proportions and verdict", () => {
  it("n = ceil((1.96·CV/0.05)²) clamped to [3, 30]", () => {
    // values 9, 10, 11: mean 10, sd 1 → CV 0.1 → (3.92)² = 15.37 → 16
    const r = pilotRepetitions([9, 10, 11]);
    close(r.cv, 0.1);
    assert.equal(r.raw, 16);
    assert.equal(r.launches, 16);
    assert.equal(pilotRepetitions([10, 10.001, 9.999]).launches, 3);
    assert.equal(pilotRepetitions([1, 10, 20]).launches, 30);
    assert.equal(pilotRepetitions([5]).launches, 30);
  });
  it("linear slope", () => {
    close(linearSlope([0, 1, 2, 3], [1, 3, 5, 7]), 2);
    assert.equal(linearSlope([1], [1]), undefined);
  });
  it("Wilson interval is sane at 0 and n", () => {
    const zero = proportionCi(0, 100);
    assert.equal(zero.rate, 0);
    assert.equal(zero.lower, 0);
    assert.ok(zero.upper > 0 && zero.upper < 0.05);
    const all = proportionCi(100, 100);
    assert.equal(all.upper, 1);
  });
  it("applies the keep/kill rule", () => {
    assert.equal(
      verdict(
        { point: 1.4, lower: 1.1, upper: 1.7 },
        { correctnessIdentical: true, reliabilityOk: true },
      ),
      "kept",
    );
    assert.equal(
      verdict(
        { point: 1.4, lower: 0.9, upper: 1.9 },
        { correctnessIdentical: true, reliabilityOk: true },
      ),
      "inconclusive",
    );
    assert.equal(
      verdict(
        { point: 1.1, lower: 1.05, upper: 1.2 },
        { correctnessIdentical: true, reliabilityOk: true },
      ),
      "reverted",
    );
    assert.equal(
      verdict(
        { point: 2, lower: 1.8, upper: 2.2 },
        { correctnessIdentical: false, reliabilityOk: true },
      ),
      "reverted",
    );
  });
});
