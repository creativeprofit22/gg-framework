import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  bonferroniLevel,
  classifyChange,
  decide,
  noiseFromAA,
} from "../../assets/bench-kit/lib/compare.mjs";

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

const jitter = [1, 1.02, 0.98, 1.01, 0.99, 1.03, 0.97, 1, 1.01, 0.99];
const series = (scale) => ({
  clip1: jitter.map((j) => 10 * scale * j),
  clip2: jitter.map((j) => 40 * scale * j),
});

function study(overrides = {}) {
  return {
    seed: 7,
    candidates: [{ id: "a" }, { id: "b" }, { id: "c" }],
    metrics: [
      { id: "export_seconds", better: "lower" },
      { id: "seek_p95_ms", better: "lower" },
    ],
    decision: {
      reference: "a",
      primary: { metric: "export_seconds", minRatio: 1.3, ciLowerAbove: 1.0 },
      secondary: [{ metric: "seek_p95_ms", mustNotRegressBeyond: 1.1 }],
      tieBreak: ["simpler integration"],
    },
    ...overrides,
  };
}

const data = (b, c, seekB = 1) => ({
  a: { export_seconds: series(1), seek_p95_ms: series(1) },
  b: { export_seconds: series(b), seek_p95_ms: series(seekB) },
  c: { export_seconds: series(c), seek_p95_ms: series(1) },
});

describe("helpers", () => {
  it("Bonferroni", () => {
    close(bonferroniLevel(0.95, 2), 0.975);
    assert.equal(bonferroniLevel(0.95, 0), 0.95);
  });
  it("A/A noise floor", () => {
    assert.deepEqual(noiseFromAA({ lower: 0.97, upper: 1.04 }).passed, true);
    close(noiseFromAA({ lower: 0.97, upper: 1.04 }).noise, 0.04);
    assert.equal(noiseFromAA({ lower: 1.02, upper: 1.1 }).passed, false);
    assert.equal(noiseFromAA({}).passed, false);
  });
  it("criterion-style classification", () => {
    assert.equal(classifyChange({ lower: 0.9, upper: 1.1 }), "no-change");
    assert.equal(classifyChange({ lower: 1.001, upper: 1.005 }), "within-noise");
    assert.equal(classifyChange({ lower: 1.2, upper: 1.4 }), "better");
    assert.equal(classifyChange({ lower: 0.5, upper: 0.7 }), "worse");
    assert.equal(classifyChange({}), "unknown");
  });
});

describe("decision rule", () => {
  it("a 2× faster candidate wins; the slower one does not", () => {
    const v = decide({ study: study(), data: data(0.5, 1.6), resamples: 1_000 });
    assert.equal(v.verdict, "WIN");
    assert.equal(v.winner, "b");
    assert.equal(v.keep, "b");
    assert.equal(v.candidates.b.verdict, "WIN");
    assert.equal(v.candidates.c.verdict, "NO-WIN");
    close(v.rule.adjustedLevel, 0.975);
    assert.ok(v.rank.b > 0.9);
  });

  it("same-vs-same is a TIE, never a WIN", () => {
    const v = decide({ study: study(), data: data(1, 1), resamples: 1_000 });
    assert.notEqual(v.verdict, "WIN");
    assert.ok(["TIE", "INCONCLUSIVE"].includes(v.verdict));
    assert.equal(v.keep, "a");
  });

  it("a gated-out candidate is excluded with its reason", () => {
    const v = decide({
      study: study(),
      data: data(0.5, 1),
      gates: {
        b: {
          status: "fail",
          failures: [{ gate: "frame-exact-seek", item: "clip1", reason: "off by 2 frames" }],
        },
      },
      resamples: 500,
    });
    assert.equal(v.candidates.b.verdict, "GATED-OUT");
    assert.match(v.candidates.b.reasons[0], /frame-exact-seek failed on clip1: off by 2 frames/);
    assert.notEqual(v.verdict, "WIN");
  });

  it("a secondary regression turns a win into NO-WIN", () => {
    const v = decide({ study: study(), data: data(0.5, 1.6, 1.5), resamples: 500 });
    assert.equal(v.candidates.b.verdict, "NO-WIN");
    assert.match(v.candidates.b.reasons.join(), /seek_p95_ms regressed beyond the allowed 1.1×/);
  });

  it("errored samples, failed A/A, missing A/A and incomplete runs are INCONCLUSIVE", () => {
    const counts = {
      a: { planned: 20, completed: 20, errored: 0, notRun: 0 },
      b: { planned: 20, completed: 15, errored: 5, notRun: 0 },
      c: { planned: 20, completed: 20, errored: 0, notRun: 0 },
    };
    const errored = decide({ study: study(), data: data(0.5, 1.6), counts, resamples: 300 });
    assert.equal(errored.candidates.b.verdict, "INCONCLUSIVE");
    assert.equal(
      decide({
        study: study(),
        data: data(0.5, 1.6),
        aa: { passed: false, noise: 0.2 },
        resamples: 300,
      }).verdict,
      "INCONCLUSIVE",
    );
    const needsAA = study();
    needsAA.decision.noise = { requireAA: true };
    assert.equal(
      decide({ study: needsAA, data: data(0.5, 1.6), resamples: 300 }).verdict,
      "INCONCLUSIVE",
    );
    assert.equal(
      decide({
        study: study(),
        data: data(0.5, 1.6),
        incomplete: "run stopped by budget",
        resamples: 300,
      }).verdict,
      "INCONCLUSIVE",
    );
  });

  it("a gate that could not be checked is INCONCLUSIVE, not a failure", () => {
    const v = decide({
      study: study(),
      data: data(0.5, 1.6),
      gates: { b: { status: "errored", errored: [{ gate: "vmaf", reason: "tool missing" }] } },
      resamples: 300,
    });
    assert.equal(v.candidates.b.verdict, "INCONCLUSIVE");
    assert.equal(v.verdict, "INCONCLUSIVE");
  });

  it("a gated-out reference makes the whole study INCONCLUSIVE", () => {
    const v = decide({
      study: study(),
      data: data(0.5, 1.6),
      gates: { a: { status: "fail", failures: [{ gate: "licence", reason: "GPL" }] } },
      resamples: 300,
    });
    assert.equal(v.verdict, "INCONCLUSIVE");
    assert.match(v.reasons.join(), /reference a is GATED-OUT/);
  });

  it("all challengers gated out keeps the reference (NO-WIN)", () => {
    const fail = { status: "fail", failures: [{ gate: "licence", reason: "x" }] };
    const v = decide({
      study: study(),
      data: data(0.5, 0.5),
      gates: { b: fail, c: fail },
      resamples: 300,
    });
    assert.equal(v.verdict, "NO-WIN");
    assert.equal(v.keep, "a");
  });
});
