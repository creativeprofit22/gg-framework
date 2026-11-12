import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { decide } from "../../assets/bench-kit/lib/compare.mjs";
import {
  KIT_GLOSSARY,
  addTerm,
  auditDecision,
  auditWording,
  candidateName,
  describeChange,
  describeRange,
  explainCandidate,
  explainCounts,
  explainDecision,
  explainMetric,
  explainMetricResult,
  explainTerm,
  explainUnmeasured,
  formatLevel,
  formatNumber,
  formatPercent,
  mergeGlossaries,
  metricInfo,
  nextSteps,
  readGlossary,
  validateGlossary,
  writeGlossary,
} from "../../assets/bench-kit/lib/explain.mjs";

const jitter = [1, 1.02, 0.98, 1.01, 0.99, 1.03, 0.97, 1, 1.01, 0.99];
const series = (scale) => ({
  clip1: jitter.map((j) => 10 * scale * j),
  clip2: jitter.map((j) => 40 * scale * j),
});

function study(overrides = {}) {
  return {
    seed: 7,
    candidates: [
      { id: "a", label: "Engine A" },
      { id: "b", label: "Engine B" },
      { id: "c", label: "Engine C" },
    ],
    metrics: [
      { id: "export_seconds", type: "wall-time", unit: "s", better: "lower", label: "export time" },
      { id: "seek_p95_ms", type: "custom", unit: "ms", better: "lower", label: "seek p95" },
      {
        id: "decode_fps",
        type: "custom",
        unit: "fps",
        better: "higher",
        explain: "frames decoded per second",
      },
      { id: "peak_memory_mb", type: "peak-memory", unit: "MB", better: "lower" },
    ],
    decision: {
      reference: "a",
      primary: { metric: "export_seconds", minRatio: 1.3, ciLowerAbove: 1.0 },
      secondary: [{ metric: "seek_p95_ms", mustNotRegressBeyond: 1.1 }],
      tieBreak: ["simpler integration", "licence fit"],
    },
    ...overrides,
  };
}

const data = (b, c) => ({
  a: { export_seconds: series(1), seek_p95_ms: series(1) },
  b: { export_seconds: series(b), seek_p95_ms: series(1) },
  c: { export_seconds: series(c), seek_p95_ms: series(1) },
});

const run = (s, d, extra = {}) => decide({ study: s, data: d, resamples: 400, ...extra });
const allText = (explained) =>
  [
    explained.verdict.headline,
    explained.verdict.meaning,
    ...explained.verdict.details,
    ...explained.candidates.flatMap((c) => [c.headline, c.meaning, ...c.details]),
  ].join("\n");

describe("number formatting", () => {
  it("is deterministic and locale-free", () => {
    assert.equal(formatNumber(1.4567), "1.46");
    assert.equal(formatNumber(12.345), "12.3");
    assert.equal(formatNumber(0.0012345), "0.00123");
    assert.equal(formatNumber(1234567.8), "1,234,568");
    assert.equal(formatNumber(0), "0");
    assert.equal(formatPercent(0.874), "87%");
    assert.equal(formatPercent(0.004), "under 1%");
    assert.equal(formatPercent(0.996), "over 99%");
    assert.equal(formatPercent(0), "0%");
    assert.equal(formatLevel(0.975), "97.5%");
    assert.equal(formatLevel(0.95), "95%");
  });
});

describe("describeChange", () => {
  const s = study();
  it("uses faster/slower for time metrics", () => {
    assert.equal(describeChange(1.5, metricInfo(s, "export_seconds")), "1.5× faster");
    assert.equal(describeChange(0.5, metricInfo(s, "export_seconds")), "2× slower");
    assert.equal(describeChange(1.001, metricInfo(s, "export_seconds")), "the same");
  });
  it("says higher/lower plus better/worse for other metrics", () => {
    assert.equal(describeChange(1.2, metricInfo(s, "decode_fps")), "1.2× higher (better)");
    assert.equal(describeChange(0.8, metricInfo(s, "peak_memory_mb")), "1.25× higher (worse)");
    assert.equal(describeChange(1.25, metricInfo(s, "peak_memory_mb")), "1.25× lower (better)");
  });
  it("handles the difference scale and invalid values", () => {
    assert.equal(
      describeChange(3, metricInfo(s, "decode_fps"), "difference"),
      "3 fps higher (better)",
    );
    assert.equal(
      describeChange(-0.5, metricInfo(s, "export_seconds"), "difference"),
      "0.5 s slower",
    );
    assert.equal(describeChange(-1, metricInfo(s, "export_seconds")), "not comparable");
  });
  it("compresses a one-sided range and states the adjusted level", () => {
    const m = metricInfo(s, "export_seconds");
    assert.equal(
      describeRange({ lower: 1.4, upper: 1.6, level: 0.975, scale: "ratio" }, m, {
        level: 0.95,
        comparisons: 2,
      }),
      "likely between 1.4× and 1.6× faster (97.5% confidence, widened from 95% because 2 comparisons were made)",
    );
    assert.equal(
      describeRange({ lower: 0.98, upper: 1.03, level: 0.95 }, m),
      "likely between 1.02× slower and 1.03× faster (95% confidence)",
    );
    assert.match(describeRange({}, m), /could not be compared/);
  });
});

describe("metric explanations", () => {
  it("explains what a metric means and which way is better", () => {
    const s = study();
    assert.equal(
      explainMetric(s, "decode_fps"),
      "decode_fps: frames decoded per second (measured in fps, higher is better).",
    );
    assert.match(explainMetric(s, "peak_memory_mb"), /short spikes can be missed.*lower is better/);
    assert.match(explainMetric(s, "export_seconds"), /^export time: how long one run takes/);
  });

  it("reports the study's own numbers and labels unmeasured values, never zero", () => {
    const s = study();
    const lines = explainMetricResult({
      study: s,
      metricId: "peak_memory_mb",
      data: {
        a: { peak_memory_mb: { clip1: [400, 410, 405, 420, 415] } },
        b: { peak_memory_mb: { clip1: [300] } },
      },
      unmeasured: {
        b: { peak_memory_mb: { count: 4, reasons: ["unmeasured in docker"] } },
        c: { peak_memory_mb: { count: 5, reasons: ["this adapter does not measure memory"] } },
      },
      labels: { peak_memory_mb: ["sampled, 50 ms resolution"] },
    });
    assert.match(lines[1], /These readings are sampled, 50 ms resolution\./);
    assert.match(
      lines[2],
      /^Engine A \(a\): median 410 MB, p95 419 MB from 5 measurements on 1 input\.$/,
    );
    assert.match(
      lines[3],
      /4 samples not measured: unmeasured in docker; shown as unmeasured, not as zero\./,
    );
    assert.equal(lines[4], "Engine C (c): not measured (this adapter does not measure memory).");
    assert.ok(!/\b0 MB\b/.test(lines.join("\n")));
  });

  it("flags noisy measurements", () => {
    const s = study();
    const [, line] = explainMetricResult({
      study: s,
      metricId: "export_seconds",
      data: { a: { export_seconds: { x: [1, 2, 3, 1, 2] } } },
    });
    assert.match(line, /noisy: runs vary by about \d+%/);
  });

  it("lists unmeasured metrics per candidate", () => {
    const lines = explainUnmeasured(study(), {
      c: { decode_fps: { count: 2, reasons: ["stdout had no decodeFps"] } },
    });
    assert.deepEqual(lines, [
      "decode_fps was not measured for Engine C (c) in 2 samples (stdout had no decodeFps); it is shown as unmeasured, not as zero.",
    ]);
  });

  it("describes sample counts and never hides errors", () => {
    assert.equal(
      explainCounts({ planned: 20, completed: 18, errored: 2, notRun: 0 }),
      "18 of 20 planned samples completed, 2 errored; errored samples count against the candidate and are never re-run.",
    );
    assert.equal(
      explainCounts({ planned: 20, completed: 20, errored: 0, notRun: 0 }),
      "20 of 20 planned samples completed.",
    );
  });
});

describe("verdict explanations", () => {
  it("WIN names the winner, the range and the rule", () => {
    const s = study();
    const d = run(s, data(0.5, 1));
    assert.equal(d.verdict, "WIN");
    const e = explainDecision(d, s);
    assert.equal(
      e.verdict.headline,
      "WIN: switch to Engine B (b). It cleared the rule you set before the run.",
    );
    assert.match(
      e.verdict.meaning,
      /^On export time against Engine A \(a\), Engine B \(b\) is likely between [\d.]+× and [\d.]+× faster \(97\.5% confidence, widened from 95% because 2 comparisons were made\)\./,
    );
    assert.match(
      e.verdict.meaning,
      /at least 1\.3× faster on export time against Engine A \(a\), with the whole range above 'no difference'/,
    );
    assert.match(
      e.verdict.details.join("\n"),
      /Engine B \(b\) ranked best on export time in \d+% of resamples\./,
    );
    const b = e.candidates.find((c) => c.id === "b");
    assert.match(b.headline, /clears the rule \(WIN\)/);
    assert.match(b.meaning, /candidate to switch to/);
    assert.equal(e.candidates.find((c) => c.id === "a").verdict, "REFERENCE");
    assert.deepEqual(auditDecision(e, s), []);
  });

  it("TIE is never worded as a win and points to the tie-break", () => {
    const s = study();
    const d = run(s, data(1, 1));
    assert.equal(d.verdict, "TIE");
    const e = explainDecision(d, s);
    const text = allText(e);
    assert.equal(
      e.verdict.headline,
      "TIE: no candidate is meaningfully better than Engine A (a) on export time.",
    );
    assert.match(
      e.verdict.meaning,
      /This is a tie, not a win\. Choose using the tie-break you wrote down, in order: simpler integration and licence fit\. If that does not settle it, keep Engine A \(a\)\./,
    );
    assert.ok(!/WIN:|\(WIN\)|switch to/.test(text));
    assert.match(text, /\(a ranking, not a verdict\)/);
    for (const c of e.candidates.filter((x) => x.id !== "a"))
      assert.match(c.meaning, /^This is not a win for either\./);
    assert.deepEqual(auditDecision(e, s), []);
  });

  it("TIE without a tie-break keeps the reference", () => {
    const s = study();
    s.decision.tieBreak = [];
    const e = explainDecision(run(s, data(1, 1)), s);
    assert.match(e.verdict.meaning, /No tie-break was written down, so keep Engine A \(a\)\./);
  });

  it("NO-WIN keeps the reference and restates the bar", () => {
    const s = study();
    const d = run(s, data(2, 2));
    assert.equal(d.verdict, "NO-WIN");
    const e = explainDecision(d, s);
    assert.equal(e.verdict.headline, "NO-WIN: keep Engine A (a).");
    assert.match(e.verdict.meaning, /^No candidate cleared the rule: at least 1\.3× faster/);
    assert.match(
      e.candidates[1].meaning,
      /^Keep Engine A \(a\) rather than Engine B \(b\); the rule needs at least 1\.3× faster on export time, with/,
    );
    assert.deepEqual(auditDecision(e, s), []);
  });

  it("INCONCLUSIVE gives the reasons and concrete next steps, and a measured lead is not called a win", () => {
    const s = study();
    s.decision.noise = { requireAA: true };
    const d = run(s, data(0.5, 1));
    assert.equal(d.verdict, "INCONCLUSIVE");
    const e = explainDecision(d, s);
    assert.equal(e.verdict.headline, "INCONCLUSIVE: do not decide from this run yet.");
    assert.deepEqual(e.verdict.nextSteps, ["Run the A/A (same-vs-same) check."]);
    const b = e.candidates.find((c) => c.id === "b");
    assert.match(
      b.headline,
      /measured ahead of Engine A \(a\) on export time: likely between .*\. It cannot be called a win yet\.$/,
    );
    assert.ok(!/\([^)]*\(/.test(b.headline), "no nested brackets");
    assert.match(b.meaning, /^Do not switch yet/);
    assert.deepEqual(auditDecision(e, s), []);
  });

  it("GATED-OUT explains the failed gate and that its numbers do not count", () => {
    const s = study();
    const gates = {
      c: { status: "fail", failures: [{ gate: "licence", reason: "GPL-3.0 is not allowed" }] },
    };
    const d = run(s, data(0.5, 0.4), { gates });
    const e = explainDecision(d, s);
    const c = e.candidates.find((x) => x.id === "c");
    assert.equal(c.verdict, "GATED-OUT");
    assert.equal(
      c.headline,
      "Engine C (c) is ruled out (GATED-OUT): gate licence failed: GPL-3.0 is not allowed.",
    );
    assert.match(c.meaning, /do not count, however good they look/);
    assert.match(e.verdict.details.join("\n"), /Engine C \(c\) was ruled out: gate licence failed/);
    assert.deepEqual(auditDecision(e, s), []);
  });

  it("errored samples make a candidate inconclusive with a fix-and-rerun step", () => {
    const s = study();
    const counts = {
      a: { planned: 20, completed: 20, errored: 0, notRun: 0 },
      b: { planned: 20, completed: 14, errored: 6, notRun: 0 },
      c: { planned: 20, completed: 20, errored: 0, notRun: 0 },
    };
    const d = run(s, data(0.5, 1), { counts });
    const b = explainCandidate(d, s, "b");
    assert.equal(b.verdict, "INCONCLUSIVE");
    assert.match(b.headline, /30% of samples errored \(limit 10%\)/);
    assert.match(b.meaning, /errored samples are never re-run selectively/);
    assert.match(b.details[0], /14 of 20 planned samples completed, 6 errored/);
  });

  it("labels synthetic stand-ins everywhere they are named", () => {
    const s = study();
    s.candidates[1].synthetic = true;
    const e = explainDecision(run(s, data(0.5, 1)), s);
    assert.equal(candidateName(s, "b"), "Engine B (b) [synthetic stand-in]");
    assert.equal(
      candidateName({ candidates: [{ id: "x", label: "Engine X (current)" }] }, "x"),
      "Engine X (current) [x]",
    );
    assert.equal(candidateName({ candidates: [{ id: "x" }] }, "x"), "x");
    assert.match(e.verdict.headline, /switch to Engine B \(b\) \[synthetic stand-in\]/);
    assert.match(
      e.verdict.details.join("\n"),
      /is a synthetic stand-in, not the real thing; confirm on the real candidate before deciding\./,
    );
    assert.deepEqual(auditDecision(e, s), []);
  });

  it("includes sampled labels and unmeasured notes in the verdict details", () => {
    const s = study();
    const e = explainDecision(run(s, data(1, 1)), s, {
      labels: { peak_memory_mb: ["sampled, 50 ms resolution"] },
      unmeasured: { c: { peak_memory_mb: { count: 20, reasons: ["unmeasured in docker"] } } },
    });
    const details = e.verdict.details.join("\n");
    assert.match(details, /peak_memory_mb readings are sampled, 50 ms resolution\./);
    assert.match(
      details,
      /peak_memory_mb was not measured for Engine C \(c\) in 20 samples \(unmeasured in docker\); it is shown as unmeasured, not as zero\./,
    );
  });

  it("words a secondary metric with the orientation set on decision.secondary", () => {
    const s = study();
    s.metrics.push({ id: "quality", type: "custom" });
    s.decision.secondary = [{ metric: "quality", better: "higher" }];
    const d = run(s, {
      ...data(0.5, 1),
      a: { export_seconds: series(1), quality: series(5) },
      b: { export_seconds: series(0.5), quality: series(8) },
    });
    assert.equal(d.candidates.b.secondary[0].better, "higher");
    const line = explainCandidate(d, s, "b").details.find((x) => x.startsWith("quality:"));
    assert.ok(line, "expected a quality detail line");
    assert.match(line, /higher \(better\)/);
    assert.ok(!line.includes("lower"), line);
  });

  it("is deterministic", () => {
    const s = study();
    const d = run(s, data(0.5, 0.9));
    assert.deepEqual(explainDecision(d, s), explainDecision(run(s, data(0.5, 0.9)), s));
  });
});

describe("honesty audit", () => {
  it("catches win wording on a non-win verdict", () => {
    assert.deepEqual(auditWording("Engine B wins on export time.", { verdict: "TIE" }), [
      '"wins" claims a win but the verdict is TIE',
    ]);
    assert.equal(auditWording("Engine B beat engine A.", { verdict: "INCONCLUSIVE" }).length, 1);
    assert.equal(auditWording("Engine B clears the rule.", { verdict: "NO-WIN" }).length, 1);
  });
  it("allows verdict tokens, negations and real wins", () => {
    assert.deepEqual(
      auditWording(
        "NO-WIN: keep engine A. This is not a win for either. It did not clear the rule.",
        { verdict: "NO-WIN" },
      ),
      [],
    );
    assert.deepEqual(auditWording("No winner yet.", { verdict: "INCONCLUSIVE" }), []);
    assert.deepEqual(auditWording("Engine B wins.", { verdict: "WIN" }), []);
  });
  it("catches a synthetic candidate named without the label", () => {
    assert.deepEqual(
      auditWording("engine-b is fastest", { verdict: "WIN", synthetic: ["engine-b"] }),
      ["engine-b is synthetic but is named without saying so"],
    );
    assert.deepEqual(
      auditWording("engine-b [synthetic stand-in] is fastest", {
        verdict: "WIN",
        synthetic: ["engine-b"],
      }),
      [],
    );
    assert.deepEqual(
      auditWording("engine-bb is fastest", { verdict: "WIN", synthetic: ["engine-b"] }),
      [],
    );
  });
  it("maps reasons to next steps without duplicates", () => {
    assert.deepEqual(
      nextSteps([
        "30% of samples errored (limit 10%)",
        "40% of samples errored (limit 10%)",
        "the interval is too wide to tell whether it clears the bar",
      ]),
      [
        "Fix what makes samples error, then start a fresh run; errored samples are never re-run selectively.",
        "Add repeats or reduce noise, then run again.",
      ],
    );
  });
});

describe("glossary", () => {
  it("ships a valid base glossary with the core terms and no alias collisions", async () => {
    const g = await readGlossary(KIT_GLOSSARY);
    assert.ok(g.ok, g.ok ? "" : g.error.message);
    const terms = g.value.terms;
    for (const q of [
      "confidence interval",
      "p95",
      "ratio",
      "noise floor",
      "gate",
      "Wilson",
      "pass@k",
      "bootstrap",
      "outlier",
      "warm-up",
      "VMAF",
      "A/A",
      "sampled",
      "GATED-OUT",
      "tie",
    ])
      assert.ok(explainTerm(g.value, q).ok, `missing glossary term ${q}`);
    const seen = new Map();
    for (const [k, e] of Object.entries(terms))
      for (const name of [k, ...(e.aliases ?? [])].map((x) => x.toLowerCase())) {
        assert.ok(!seen.has(name), `"${name}" is used by both ${seen.get(name)} and ${k}`);
        seen.set(name, k);
      }
    const text = await readFile(KIT_GLOSSARY, "utf8");
    assert.ok(!text.includes("\r"), "glossary must be LF-only");
  });

  it("looks terms up by alias and suggests near matches", async () => {
    const g = (await readGlossary(KIT_GLOSSARY)).value;
    const hit = explainTerm(g, "  CI ");
    assert.ok(hit.ok);
    assert.equal(hit.value.term, "confidence interval");
    const miss = explainTerm(g, "interv");
    assert.equal(miss.ok, false);
    assert.equal(miss.error.code, "TERM_UNKNOWN");
    assert.ok(miss.error.details.suggestions.includes("confidence interval"));
  });

  it("merges project terms, refuses silent replacement and round-trips with LF", async () => {
    const base = (await readGlossary(KIT_GLOSSARY)).value;
    const added = addTerm({ schema: 1, terms: {} }, "Seek Accuracy", {
      plain: "Whether a seek lands on the exact frame.",
      aliases: ["frame-exact"],
    });
    assert.ok(added.ok);
    assert.ok(added.value.terms["seek accuracy"]);
    const dup = addTerm(added.value, "seek accuracy", { plain: "again" });
    assert.equal(dup.ok, false);
    assert.equal(dup.error.code, "TERM_EXISTS");
    const aliasClash = addTerm(added.value, "frame exactness", {
      plain: "x",
      aliases: ["frame-exact"],
    });
    assert.equal(aliasClash.ok, false);
    assert.ok(addTerm(added.value, "seek accuracy", { plain: "reworded" }, { replace: true }).ok);
    assert.equal(addTerm(added.value, "empty", { plain: " " }).ok, false);

    const merged = mergeGlossaries(base, added.value);
    assert.ok(explainTerm(merged, "frame-exact").ok);
    assert.ok(explainTerm(merged, "p95").ok);

    const dir = await mkdtemp(path.join(tmpdir(), "bench-glossary-"));
    try {
      const file = path.join(dir, "glossary.json");
      const missing = await readGlossary(file);
      assert.deepEqual(missing.ok && missing.value, { schema: 1, terms: {} });
      assert.ok((await writeGlossary(file, added.value)).ok);
      const raw = await readFile(file, "utf8");
      assert.ok(!raw.includes("\r") && raw.endsWith("\n"));
      assert.deepEqual((await readGlossary(file)).value, added.value);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("validates glossary shape", () => {
    assert.deepEqual(validateGlossary({ schema: 1, terms: { ok: { plain: "fine" } } }), []);
    assert.ok(validateGlossary({ schema: 1, terms: { Bad: { plain: "x" } } }).length);
    assert.ok(validateGlossary({ schema: 2, terms: {} }).length);
    assert.ok(validateGlossary([]).length);
  });
});
