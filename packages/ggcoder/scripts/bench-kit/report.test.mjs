import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { decide } from "../../assets/bench-kit/lib/compare.mjs";
import {
  LEDGER_HEADER,
  buildVerdict,
  ledgerEntry,
  updateLedger,
  writeVerdict,
} from "../../assets/bench-kit/lib/ledger.mjs";
import { buildReport, writeReport } from "../../assets/bench-kit/lib/report.mjs";

const jitter = [1, 1.02, 0.98, 1.01, 0.99, 1.03, 0.97, 1, 1.01, 0.99];
const series = (scale) => ({
  clip1: jitter.map((j) => 10 * scale * j),
  clip2: jitter.map((j) => 40 * scale * j),
});

const study = () => ({
  id: "video-engine",
  title: "Pick a video engine",
  question: "Which engine should the editor use?",
  seed: 11,
  candidates: [
    { id: "engine-a", label: "Engine A" },
    { id: "engine-b", label: "Engine B" },
    { id: "engine-c", label: "Engine C" },
  ],
  metrics: [
    { id: "export_seconds", type: "wall-time", unit: "s", better: "lower", label: "export time" },
    { id: "peak_memory_mb", type: "peak-memory", unit: "MB", better: "lower" },
  ],
  decision: {
    reference: "engine-a",
    primary: { metric: "export_seconds", minRatio: 1.3, ciLowerAbove: 1.0 },
    tieBreak: ["licence fit"],
  },
});

const counts = {
  "engine-a": { planned: 20, completed: 20, errored: 0, notRun: 0 },
  "engine-b": { planned: 20, completed: 19, errored: 1, notRun: 0 },
  "engine-c": { planned: 20, completed: 20, errored: 0, notRun: 0 },
};
const gates = {
  "engine-a": { status: "pass", failures: [], errored: [], checked: 4 },
  "engine-b": { status: "pass", failures: [], errored: [], checked: 4 },
  "engine-c": {
    status: "fail",
    failures: [{ gate: "licence", reason: "GPL | not allowed" }],
    errored: [],
    checked: 4,
  },
};

function scenario(bScale = 0.5) {
  const s = study();
  const data = {
    "engine-a": { export_seconds: series(1), peak_memory_mb: { clip1: [400, 410, 405, 420, 415] } },
    "engine-b": {
      export_seconds: series(bScale),
      peak_memory_mb: { clip1: [300, 310, 305, 320, 315] },
    },
    "engine-c": { export_seconds: series(0.4) },
  };
  const decision = decide({ study: s, data, gates, counts, resamples: 400 });
  const metrics = {
    data,
    unmeasured: {
      "engine-c": { peak_memory_mb: { count: 20, reasons: ["unmeasured in docker"] } },
    },
    labels: { peak_memory_mb: ["sampled, 50 ms resolution"] },
  };
  return { s, decision, metrics };
}

describe("report.md", () => {
  it("lays out verdict, rule, candidates, measurements, gates and provenance with plain lines", () => {
    const { s, decision, metrics } = scenario();
    const { markdown, problems } = buildReport({
      study: s,
      decision,
      metrics,
      gates,
      counts,
      protocol: { version: 2, digest: "abcdef0123456789" },
      runIds: ["r1", "r2"],
      aa: { passed: true, noise: 0.012 },
      generatedAt: "2026-10-20T10:00:00.000Z",
    });
    assert.deepEqual(problems, []);
    assert.match(
      markdown,
      /^# Pick a video engine\n\n\*\*Question:\*\* Which engine should the editor use\?/,
    );
    assert.match(
      markdown,
      /\*\*WIN: switch to Engine B \(engine-b\)\. It cleared the rule you set before the run\.\*\*/,
    );
    assert.match(
      markdown,
      /A candidate replaces Engine A \(engine-a\) only with at least 1\.3× faster on export time, with the whole range above 'no difference'\. On a tie, choose by: licence fit; otherwise keep Engine A \(engine-a\)\./,
    );
    // one plain line for the verdict and one per candidate
    assert.equal(markdown.match(/^What this means for you: /gm)?.length, 1 + s.candidates.length);
    assert.match(
      markdown,
      /\| Engine C \(engine-c\) \| GATED-OUT \| failed: licence \| 20\/20 ok \|/,
    );
    assert.match(
      markdown,
      /\| Engine B \(engine-b\) \| WIN \| passed \(4 checks\) \| 19\/20 ok, 1 errored \|/,
    );
    assert.match(
      markdown,
      /\| Engine C \(engine-c\) \| licence \| all \| failed \| GPL \\\| not allowed \|/,
      "pipes in cells are escaped",
    );
    assert.match(
      markdown,
      /\| Engine C \(engine-c\) \| not measured \| too few samples \| 0 \| 20 not measured \|/,
    );
    assert.match(markdown, /These readings are sampled, 50 ms resolution\./);
    assert.ok(!/\| 0 MB/.test(markdown), "unmeasured is never printed as zero");
    assert.match(
      markdown,
      /Protocol v2 \(abcdef012345\); results from other versions are never mixed in\./,
    );
    assert.match(markdown, /A\/A \(same-vs-same\) check passed; noise floor about 1%\./);
    assert.match(markdown, /computed by the bench kit, not by hand/);
    assert.ok(!markdown.includes("\r"));
  });

  it("says so when no A/A check ran and lists next steps when inconclusive", () => {
    const s = study();
    s.decision.noise = { requireAA: true };
    const data = {
      "engine-a": { export_seconds: series(1) },
      "engine-b": { export_seconds: series(0.5) },
      "engine-c": { export_seconds: series(1) },
    };
    const decision = decide({ study: s, data, resamples: 300 });
    const { markdown, problems } = buildReport({ study: s, decision, metrics: { data } });
    assert.deepEqual(problems, []);
    assert.match(markdown, /\*\*INCONCLUSIVE: do not decide from this run yet\.\*\*/);
    assert.match(markdown, /Next steps:\n\n- Run the A\/A \(same-vs-same\) check\./);
    assert.match(markdown, /No A\/A \(same-vs-same\) check was run/);
    assert.ok(!/^## Gates/m.test(markdown), "no gates section when gates were not evaluated");
  });

  it("lists the study's unmeasured items as not measured in report.md and verdict.json", () => {
    // A tie verdict, so the honesty audit checks the new lines for win wording.
    const { s, decision, metrics } = scenario(1);
    s.unmeasured = [
      { what: "Picture quality as people see it", how: "blind human A/B rating" },
      { what: "Licence cost" },
    ];
    const { markdown, problems, explained } = buildReport({ study: s, decision, metrics });
    assert.deepEqual(problems, []);
    assert.match(
      markdown,
      /\n## Not measured\n\n- Picture quality as people see it: not measured by this run; it could be judged by blind human A\/B rating\.\n- Licence cost: not measured by this run\.\n/,
    );
    assert.ok(markdown.indexOf("## Measurements") < markdown.indexOf("## Not measured"));
    const verdict = buildVerdict({
      study: s,
      decision,
      explained,
      protocol: { version: 1, digest: "0123456789abcdef" },
      runIds: ["r1"],
      generatedAt: "2026-10-20T10:00:00.000Z",
    });
    assert.deepEqual(verdict.unmeasured, [
      { what: "Picture quality as people see it", how: "blind human A/B rating" },
      { what: "Licence cost" },
    ]);
  });

  it("flags win wording in unmeasured items when the verdict is not a win", () => {
    const { s, decision, metrics } = scenario(1);
    s.unmeasured = [{ what: "Which engine wins with editors" }];
    const { problems } = buildReport({ study: s, decision, metrics });
    assert.ok(problems.some((p) => p.includes('"wins" claims a win')));
  });

  it("omits the Not measured section and verdict field when the study lists none", () => {
    const { s, decision, metrics } = scenario();
    const { markdown, explained } = buildReport({ study: s, decision, metrics });
    assert.ok(!/^## Not measured/m.test(markdown));
    const verdict = buildVerdict({
      study: s,
      decision,
      explained,
      protocol: { version: 1, digest: "0123456789abcdef" },
      runIds: ["r1"],
      generatedAt: "2026-10-20T10:00:00.000Z",
    });
    assert.ok(!("unmeasured" in verdict));
  });

  it("writes report.md atomically", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bench-report-"));
    try {
      const { s, decision, metrics } = scenario();
      const { markdown } = buildReport({ study: s, decision, metrics });
      assert.ok((await writeReport(dir, markdown)).ok);
      assert.equal(await readFile(path.join(dir, "report.md"), "utf8"), markdown);
      assert.equal((await writeReport(dir, "bad\r\n")).ok, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("verdict ledger", () => {
  const make = (bScale, version = 1, date = "2026-10-20T10:00:00.000Z") => {
    const { s, decision, metrics } = scenario(bScale);
    const { explained } = buildReport({ study: s, decision, metrics });
    return {
      s,
      verdict: buildVerdict({
        study: s,
        decision,
        explained,
        protocol: { version, digest: "0123456789abcdef" },
        runIds: ["r2", "r1"],
        generatedAt: date,
      }),
    };
  };

  it("builds verdict.json with per-candidate results", async () => {
    const { verdict } = make(0.5);
    assert.equal(verdict.verdict, "WIN");
    assert.equal(verdict.winner, "engine-b");
    assert.equal(verdict.keep, "engine-b");
    assert.deepEqual(verdict.runs, ["r1", "r2"]);
    assert.equal(verdict.candidates["engine-c"].verdict, "GATED-OUT");
    assert.equal(verdict.candidates["engine-b"].primary.metric, "export_seconds");
    assert.ok(verdict.candidates["engine-b"].primary.lower > 1);
    const dir = await mkdtemp(path.join(tmpdir(), "bench-verdict-"));
    try {
      assert.ok((await writeVerdict(dir, verdict)).ok);
      assert.deepEqual(
        JSON.parse(await readFile(path.join(dir, "verdict.json"), "utf8")),
        JSON.parse(JSON.stringify(verdict)),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("formats an entry in ledger vocabulary", () => {
    const { s, verdict } = make(0.5);
    const entry = ledgerEntry(verdict, s);
    assert.match(
      entry,
      /^<!-- bench:start video-engine v1 -->\n### 2026-10-20 · video-engine \(protocol v1\) · WIN: engine-b\n/,
    );
    assert.match(entry, /- Keep: Engine B \(engine-b\)/);
    assert.match(
      entry,
      /- Gated out: Engine C \(engine-c\) \(gate licence failed: GPL \| not allowed\)/,
    );
    assert.match(entry, /- Report: studies\/video-engine\/report\.md\n<!-- bench:end -->$/);
  });

  it("creates, replaces its own entry, appends other versions and keeps user prose", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bench-ledger-"));
    const file = path.join(dir, "RESULTS.md");
    try {
      const first = make(0.5);
      const created = await updateLedger(file, first.verdict, first.s);
      assert.equal(created.ok && created.value.action, "created");
      let text = await readFile(file, "utf8");
      assert.ok(text.startsWith(LEDGER_HEADER));
      await writeFile(file, `${text}\nOur own note about the first run.\n`);

      const again = make(1);
      const replaced = await updateLedger(file, again.verdict, again.s);
      assert.equal(replaced.ok && replaced.value.action, "replaced");
      text = await readFile(file, "utf8");
      assert.equal(text.match(/bench:start video-engine v1/g)?.length, 1);
      assert.match(text, /· TIE\n/);
      assert.ok(!text.includes("WIN: engine-b"));
      assert.match(text, /Our own note about the first run\./);

      const v2 = make(0.5, 2, "2026-10-21T09:00:00.000Z");
      const added = await updateLedger(file, v2.verdict, v2.s);
      assert.equal(added.ok && added.value.action, "added");
      text = await readFile(file, "utf8");
      assert.ok(text.indexOf("video-engine v1") < text.indexOf("video-engine v2"));
      assert.ok(!text.includes("\r") && text.endsWith("<!-- bench:end -->\n"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to edit a CRLF ledger", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bench-ledger-"));
    const file = path.join(dir, "RESULTS.md");
    try {
      await writeFile(file, "# Bench results\r\n");
      const { s, verdict } = make(0.5);
      const r = await updateLedger(file, verdict, s);
      assert.equal(r.ok, false);
      assert.equal(r.error.code, "LEDGER_CRLF");
      assert.equal(await readFile(file, "utf8"), "# Bench results\r\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
