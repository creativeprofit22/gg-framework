import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { decide } from "../../assets/bench-kit/lib/compare.mjs";
import { evaluateGates, gateValidators } from "../../assets/bench-kit/lib/gates/index.mjs";
import { parseScore } from "../../assets/bench-kit/lib/gates/quality.mjs";
import { validateValue } from "../../assets/bench-kit/lib/gates/schema.mjs";

const node = process.execPath;
const V = gateValidators();
const errorsFor = (g) => V[g.type].validate(g).join("\n");

let project;
let studyDir;
let workDir;

/** Write a recorded sample's files and return its samples.jsonl record. */
async function sample({
  candidate = "a",
  item = "i1",
  repeat = 0,
  index = 0,
  output,
  stdout,
  metrics = {},
  info = {},
  status = "ok",
}) {
  const rel = `runs/r1/samples/${String(index).padStart(5, "0")}-${candidate}-${item}`;
  const dir = path.join(studyDir, rel);
  await mkdir(path.join(dir, "out"), { recursive: true });
  const extra = {};
  if (output !== undefined) {
    await writeFile(path.join(dir, "out", "output.txt"), output);
    extra.outPath = `${rel}/out/output.txt`;
    extra.outDir = `${rel}/out`;
  }
  if (stdout !== undefined) {
    await writeFile(path.join(dir, "stdout.txt"), stdout);
    extra.stdoutPath = `${rel}/stdout.txt`;
  }
  return {
    runId: "r1",
    index,
    phase: "measure",
    repeat,
    item,
    candidate,
    position: 0,
    status,
    metrics,
    info: { sampleDir: rel, ...extra, ...info },
  };
}

const study = (gates, extra = {}) => ({
  id: "g",
  candidates: [{ id: "a" }, { id: "b" }],
  workload: {
    items: [
      { id: "i1", input: "i1.json", expectedFile: "i1.expected.txt" },
      { id: "i2", input: "i2.json", expectedFile: "i2.expected.json" },
      { id: "nox", input: "i1.json" },
    ],
  },
  metrics: [{ id: "ms", type: "wall-time" }],
  gates,
  ...extra,
});

const runGate = async (gate, s, extra = {}) => {
  const { checks } = await evaluateGates({
    study: study([gate]),
    samples: [s],
    studyDir,
    projectDir: project,
    workDir,
    ...extra,
  });
  assert.equal(checks.length, 1, "one check");
  return checks[0];
};

before(async () => {
  project = await mkdtemp(path.join(os.tmpdir(), "bench-gates-"));
  studyDir = path.join(project, "bench", "studies", "g");
  workDir = path.join(studyDir, "runs", "r1", "gates");
  await mkdir(path.join(studyDir, "workload"), { recursive: true });
  await writeFile(path.join(studyDir, "workload", "i1.json"), "[3,1,2]\n");
  await writeFile(path.join(studyDir, "workload", "i1.expected.txt"), "HELLO\nWORLD\n");
  await writeFile(
    path.join(studyDir, "workload", "i2.expected.json"),
    JSON.stringify({ b: [1, 2], a: { fps: 60, seek: [10, 20] } }),
  );
  await writeFile(
    path.join(studyDir, "out.schema.json"),
    JSON.stringify({ type: "object", required: ["fps"] }),
  );
  await writeFile(
    path.join(project, "check.mjs"),
    [
      "const [mode, arg] = process.argv.slice(2);",
      'if (mode === "pass") console.log(JSON.stringify({ pass: true, value: 7, reason: `ok ${arg}` }));',
      'if (mode === "fail") { console.log("checking..."); console.log(JSON.stringify({ pass: false, reason: "seek landed 2 frames late" })); }',
      'if (mode === "silent") { console.error("crashed hard"); process.exit(2); }',
      'if (mode === "liar") { console.log(JSON.stringify({ pass: true })); process.exit(1); }',
      'if (mode === "env") console.log(JSON.stringify({ pass: !process.env.BENCH_GATE_SECRET, reason: "secret visible" }));',
      'if (mode === "hang") setInterval(() => {}, 1000);',
    ].join("\n"),
  );
  await writeFile(
    path.join(project, "vmaf.mjs"),
    [
      'import { writeFileSync } from "node:fs";',
      "const [mode, a, b] = process.argv.slice(2);",
      'if (mode === "report") writeFileSync(b, JSON.stringify({ frames: [], pooled_metrics: { vmaf: { min: 80, mean: Number(a), max: 99 } } }));',
      'if (mode === "legacy") console.log(JSON.stringify({ aggregate: { VMAF_score: Number(a) } }));',
      'if (mode === "text") console.log(`frames: 120\\nVMAF score: ${a}`);',
      'if (mode === "broken") { console.error("missing model file"); process.exit(1); }',
    ].join("\n"),
  );
});

after(async () => {
  await rm(project, { recursive: true, force: true });
});

describe("gate config validation", () => {
  it("names unknown options, wrong scopes and missing thresholds", () => {
    assert.match(errorsFor({ id: "x", type: "exit-code", expct: 0 }), /expct: unknown option/);
    for (const type of ["command", "quality"])
      assert.match(
        errorsFor({ id: "x", type, command: "node c.mjs", format: "number", passEnv: ["A=1"] }),
        /passEnv: expected an array of variable names/,
        type,
      );
    assert.match(errorsFor({ id: "x", type: "equals", scope: "candidate" }), /checks each sample/);
    assert.match(
      errorsFor({ id: "x", type: "tolerance", source: "output-json", field: "a" }),
      /abs or rel/,
    );
    assert.match(
      errorsFor({ id: "x", type: "tolerance", source: "metric" }),
      /field: expected the adapter metric name/,
    );
    assert.match(
      errorsFor({
        id: "x",
        type: "quality",
        command: ["vmaf"],
        format: "regex",
        pattern: "score \\d+",
      }),
      /capture group[\s\S]*min or max/,
    );
    assert.match(
      errorsFor({ id: "x", type: "quality", command: ["vmaf"], format: "vmaf-xml", min: 1 }),
      /format: expected one of/,
    );
    assert.match(
      errorsFor({ id: "x", type: "exit-code", samples: "some" }),
      /samples: expected all or first/,
    );
    assert.match(
      errorsFor({ id: "x", type: "command", scope: "candidate", samples: "first", command: ["x"] }),
      /only applies to "scope": "sample"/,
    );
  });

  it("explains that sample slots need a sample-scope gate", () => {
    assert.match(
      errorsFor({ id: "x", type: "command", scope: "candidate", command: "node c.mjs {out}" }),
      /\{out\} need "scope": "sample"/,
    );
    assert.match(
      errorsFor({ id: "x", type: "command", command: "node c.mjs {otu}" }),
      /unknown slot\(s\) \{otu\}/,
    );
    assert.equal(
      errorsFor({
        id: "x",
        type: "command",
        scope: "candidate",
        command: "node licence.mjs {candidate} {report}",
      }),
      "",
    );
  });

  it("refuses schema keywords it would otherwise ignore", () => {
    assert.match(
      errorsFor({ id: "x", type: "schema", schema: { type: "object", oneOf: [] } }),
      /schema\.oneOf: unsupported keyword/,
    );
    assert.match(
      errorsFor({ id: "x", type: "schema", schema: {}, schemaFile: "s.json" }),
      /declare exactly one/,
    );
    assert.match(
      errorsFor({ id: "x", type: "schema", schemaFile: "../s.json" }),
      /inside the study folder/,
    );
  });
});

describe("sample gates", () => {
  it("exit-code: pass, fail, killed and unreported", async () => {
    const g = { id: "exit", type: "exit-code" };
    assert.equal((await runGate(g, await sample({ info: { exitCode: 0 } }))).status, "pass");
    const bad = await runGate({ ...g, expect: [0, 1] }, await sample({ info: { exitCode: 3 } }));
    assert.deepEqual([bad.status, bad.reason], ["fail", "exited 3, expected 0 or 1"]);
    assert.equal(
      (await runGate(g, await sample({ info: { exitCode: null, signal: "SIGKILL" } }))).status,
      "fail",
    );
    const http = await runGate(g, await sample({ metrics: { status: 200 } }));
    assert.deepEqual(
      [http.status, http.reason],
      ["errored", "this adapter does not report an exit code"],
    );
  });

  it("equals: line endings normalised, first difference named, missing expected is errored", async () => {
    const g = { id: "same", type: "equals" };
    assert.equal((await runGate(g, await sample({ output: "HELLO\r\nWORLD" }))).status, "pass");
    const diff = await runGate(g, await sample({ output: "HELLO\nWORLDS\n" }));
    assert.equal(diff.status, "fail");
    assert.match(diff.reason, /line 2: got "WORLDS", expected "WORLD"/);
    assert.equal(
      (await runGate({ ...g, mode: "bytes" }, await sample({ output: "HELLO\r\nWORLD\r\n" })))
        .status,
      "fail",
    );
    assert.equal(
      (
        await runGate(
          { ...g, mode: "json" },
          await sample({ item: "i2", output: '{"a":{"seek":[10,20],"fps":60},"b":[1,2]}' }),
        )
      ).status,
      "pass",
    );
    assert.equal(
      (
        await runGate(
          { ...g, source: "stdout", expected: "done" },
          await sample({ stdout: "done\n" }),
        )
      ).status,
      "pass",
    );
    assert.equal((await runGate(g, await sample({ item: "nox", output: "x" }))).status, "errored");
  });

  it("equals: an output deleted by cleanup is errored with a hint, not passed", async () => {
    const s = await sample({ output: "HELLO\nWORLD" });
    await rm(path.join(studyDir, s.info.outPath));
    const r = await runGate({ id: "same", type: "equals" }, s);
    assert.equal(r.status, "errored");
    assert.match(r.reason, /cleanup hook may have deleted it/);
  });

  it("refuses recorded paths that leave the study folder", async () => {
    const s = await sample({ info: { outPath: "../../../../etc/passwd" } });
    const r = await runGate({ id: "same", type: "equals" }, s);
    assert.equal(r.status, "errored");
  });

  it("tolerance: per-element abs/rel against the expected file", async () => {
    const g = { id: "close", type: "tolerance", source: "output-json", field: "a.seek", abs: 0.5 };
    const near = await runGate(
      g,
      await sample({ item: "i2", output: '{"a":{"seek":[10.4,19.7]}}' }),
    );
    assert.equal(near.status, "pass");
    const far = await runGate(g, await sample({ item: "i2", output: '{"a":{"seek":[10,21]}}' }));
    assert.equal(far.status, "fail");
    assert.match(far.reason, /21 is 1 away from 20 at position 1/);
    assert.equal(
      (
        await runGate(
          { ...g, rel: 0.1 },
          await sample({ item: "i2", output: '{"a":{"seek":[10,21]}}' }),
        )
      ).status,
      "pass",
    );
    assert.equal(
      (await runGate(g, await sample({ item: "i2", output: '{"a":{"seek":[10]}}' }))).status,
      "fail",
    );
    const metric = await runGate(
      { id: "fps", type: "tolerance", source: "metric", field: "fps", target: 60, rel: 0.05 },
      await sample({ metrics: { fps: 58 } }),
    );
    assert.deepEqual([metric.status, metric.value], ["pass", 58]);
  });

  it("schema: inline and file schemas, with JSON paths in the reason", async () => {
    const schema = {
      type: "object",
      required: ["fps"],
      properties: { fps: { type: "number", minimum: 1 }, codec: { enum: ["h264", "hevc"] } },
      additionalProperties: false,
    };
    assert.equal(
      (
        await runGate(
          { id: "s", type: "schema", schema },
          await sample({ output: '{"fps":30,"codec":"h264"}' }),
        )
      ).status,
      "pass",
    );
    const bad = await runGate(
      { id: "s", type: "schema", schema },
      await sample({ output: '{"fps":0,"codec":"av1","extra":1}' }),
    );
    assert.equal(bad.status, "fail");
    assert.match(
      bad.reason,
      /\$\.fps: 0 is below 1; \$\.codec: expected one of "h264", "hevc"; \$\.extra: no value allowed here/,
    );
    assert.equal(
      (
        await runGate(
          { id: "s", type: "schema", schemaFile: "out.schema.json" },
          await sample({ output: "{}" }),
        )
      ).status,
      "fail",
    );
    assert.equal(
      (await runGate({ id: "s", type: "schema", schema }, await sample({ output: "not json" })))
        .status,
      "fail",
    );
    assert.deepEqual(validateValue(3.5, { type: "integer" }), ["$: expected integer, got number"]);
  });
});

describe("command and quality gates", () => {
  it(
    "command: the script's JSON decides; silence or contradictions are errored",
    { timeout: 30_000 },
    async () => {
      const s = await sample({ output: "x" });
      const ok = await runGate(
        { id: "c", type: "command", command: [node, "check.mjs", "pass", "{item}"] },
        s,
      );
      assert.deepEqual([ok.status, ok.reason, ok.value], ["pass", "ok i1", 7]);
      const no = await runGate(
        { id: "c", type: "command", command: [node, "check.mjs", "fail"] },
        s,
      );
      assert.deepEqual([no.status, no.reason], ["fail", "seek landed 2 frames late"]);
      const silent = await runGate(
        { id: "c", type: "command", command: [node, "check.mjs", "silent"] },
        s,
      );
      assert.equal(silent.status, "errored");
      assert.match(silent.reason, /printed no \{"pass"[\s\S]*crashed hard/);
      assert.match(
        (await runGate({ id: "c", type: "command", command: [node, "check.mjs", "liar"] }, s))
          .reason,
        /said pass but exited 1/,
      );
      const hang = await runGate(
        { id: "c", type: "command", timeoutMs: 300, command: [node, "check.mjs", "hang"] },
        s,
      );
      assert.deepEqual([hang.status, hang.reason], ["errored", "gate command ran past 300 ms"]);
    },
  );

  it("command: runs with a scrubbed environment", { timeout: 15_000 }, async () => {
    const env = { ...process.env, BENCH_GATE_SECRET: "sk-live" };
    const r = await runGate(
      { id: "c", type: "command", command: [node, "check.mjs", "env"] },
      await sample({ output: "x" }),
      { env },
    );
    assert.equal(r.status, "pass");
  });

  it(
    "quality: VMAF report via {report}, legacy JSON, regex, thresholds",
    { timeout: 30_000 },
    async () => {
      const s = await sample({ output: "x" });
      const vmaf = (score) => ({
        id: "vmaf",
        type: "quality",
        format: "vmaf-json",
        min: 93,
        command: [node, "vmaf.mjs", "report", String(score), "{report}"],
      });
      const good = await runGate(vmaf(95.2), s);
      assert.deepEqual([good.status, good.value], ["pass", 95.2]);
      const low = await runGate(vmaf(90.1), s);
      assert.deepEqual(
        [low.status, low.value, low.reason],
        ["fail", 90.1, "score 90.1 is below the minimum 93"],
      );
      assert.equal(
        (
          await runGate(
            {
              id: "q",
              type: "quality",
              format: "vmaf-json",
              min: 93,
              command: [node, "vmaf.mjs", "legacy", "97"],
            },
            s,
          )
        ).value,
        97,
      );
      assert.equal(
        (
          await runGate(
            {
              id: "q",
              type: "quality",
              format: "regex",
              pattern: "VMAF score: ([\\d.]+)",
              min: 50,
              command: [node, "vmaf.mjs", "text", "88.5"],
            },
            s,
          )
        ).value,
        88.5,
      );
      const broken = await runGate(
        {
          id: "q",
          type: "quality",
          format: "number",
          min: 1,
          command: [node, "vmaf.mjs", "broken"],
        },
        s,
      );
      assert.equal(broken.status, "errored");
      assert.match(broken.reason, /exited 1: missing model file/);
    },
  );

  it("parseScore reads only the declared format", () => {
    assert.equal(parseScore("log line\n42.5\n", { format: "number" }).value, 42.5);
    assert.equal(
      parseScore('{"x":{"y":[1,{"z":"3.5"}]}}', { format: "json-field", field: "x.y[1].z" }).value,
      3.5,
    );
    assert.equal(parseScore('{"vmaf": 99}', { format: "vmaf-json" }).ok, false);
  });

  it("a slot with no value for this sample is errored, not filled with nothing", async () => {
    const r = await runGate(
      { id: "c", type: "command", command: [node, "check.mjs", "pass", "{expected}"] },
      await sample({ item: "nox", output: "x" }),
    );
    assert.equal(r.status, "errored");
    assert.match(r.reason, /slot \{expected\} has no value/);
  });
});

describe("gate engine", () => {
  it("summarises per candidate: fail beats errored, nothing to check is not-run", async () => {
    const gates = [
      { id: "exit", type: "exit-code" },
      { id: "same", type: "equals" },
    ];
    const samples = [
      await sample({ candidate: "a", index: 0, output: "HELLO\nWORLD", info: { exitCode: 0 } }),
      await sample({ candidate: "a", index: 1, item: "nox", output: "x", info: { exitCode: 0 } }),
      await sample({ candidate: "b", index: 2, output: "nope", info: { exitCode: 1 } }),
      await sample({ candidate: "b", index: 3, item: "nox", output: "x", info: { exitCode: 0 } }),
    ];
    const s3 = study(gates, { candidates: [{ id: "a" }, { id: "b" }, { id: "c" }] });
    const { summaries, checks } = await evaluateGates({
      study: s3,
      samples,
      studyDir,
      projectDir: project,
      workDir,
    });
    assert.equal(summaries.a.status, "errored");
    assert.deepEqual(summaries.a.errored, [
      {
        gate: "same",
        item: "nox",
        reason: "item nox has no expectedFile and the gate has no expected value",
      },
    ]);
    assert.equal(summaries.b.status, "fail");
    assert.deepEqual(
      summaries.b.failures.map((f) => `${f.gate}@${f.item}`),
      ["exit@i1", "same@i1"],
    );
    assert.equal(
      summaries.b.errored.length,
      1,
      "errored checks are still reported next to failures",
    );
    assert.equal(summaries.c.status, "not-run");
    assert.equal(summaries.c.checked, 0);
    assert.deepEqual(
      checks.map((c) => `${c.candidate}:${c.gate}:${c.index}`),
      [
        "a:exit:0",
        "a:exit:1",
        "a:same:0",
        "a:same:1",
        "b:exit:2",
        "b:exit:3",
        "b:same:2",
        "b:same:3",
      ],
    );
  });

  it("skips errored and warm-up samples; samples:first checks one per item", async () => {
    const samples = [
      await sample({ index: 0, repeat: 0, output: "HELLO\nWORLD" }),
      await sample({ index: 1, repeat: 1, output: "HELLO\nWORLD" }),
      await sample({ index: 2, repeat: 2, status: "errored" }),
      { ...(await sample({ index: 3, output: "junk" })), phase: "warmup" },
    ];
    const all = await evaluateGates({
      study: study([{ id: "same", type: "equals" }], { candidates: [{ id: "a" }] }),
      samples,
      studyDir,
      projectDir: project,
      workDir,
    });
    assert.equal(all.summaries.a.checked, 2);
    assert.equal(all.summaries.a.status, "pass");
    const first = await evaluateGates({
      study: study([{ id: "same", type: "equals", samples: "first" }], {
        candidates: [{ id: "a" }],
      }),
      samples,
      studyDir,
      projectDir: project,
      workDir,
    });
    assert.equal(first.summaries.a.checked, 1);
  });

  it("gate types not shipped yet, and crashing gates, are errored rather than passed", async () => {
    const s = await sample({ output: "x" });
    // A registry from an older kit that lacks the tests gate.
    const missing = await runGate({ id: "t", type: "tests" }, s, { registry: {} });
    assert.deepEqual(
      [missing.status, missing.reason],
      ["errored", "gate type tests is not available in this kit version"],
    );
    const boom = {
      validate: () => [],
      check: async () => {
        throw new Error("kaboom");
      },
    };
    const crashed = await runGate({ id: "x", type: "exit-code" }, s, {
      registry: { "exit-code": boom },
    });
    assert.deepEqual([crashed.status, crashed.reason], ["errored", "gate crashed: kaboom"]);
  });

  it("candidate-scope gates run once; appliesTo follows the A/A copy's base id", async () => {
    const gates = [
      {
        id: "licence",
        type: "command",
        scope: "candidate",
        appliesTo: ["b"],
        command: [node, "check.mjs", "pass", "{candidate}"],
      },
    ];
    const samples = [
      await sample({ candidate: "b", output: "x" }),
      await sample({ candidate: "b~aa", index: 1, output: "x" }),
      await sample({ candidate: "a", index: 2, output: "x" }),
    ];
    const { checks, summaries } = await evaluateGates({
      study: study(gates),
      samples,
      studyDir,
      projectDir: project,
      workDir,
    });
    assert.deepEqual(
      checks.map((c) => `${c.candidate}:${c.reason}`),
      ["b:ok b", "b~aa:ok b"],
    );
    assert.equal(summaries.a.checked, 0);
    assert.equal(summaries.a.status, "pass");
  });

  it("a failed gate makes decide() mark the candidate GATED-OUT with the reason", async () => {
    const st = {
      ...study([{ id: "exit", type: "exit-code" }]),
      metrics: [{ id: "ms", type: "wall-time", better: "lower" }],
      decision: { reference: "a", primary: { metric: "ms", better: "lower", minRatio: 1.1 } },
    };
    const samples = [
      await sample({ candidate: "a", info: { exitCode: 0 } }),
      await sample({ candidate: "b", index: 1, info: { exitCode: 2 } }),
    ];
    const { summaries } = await evaluateGates({
      study: st,
      samples,
      studyDir,
      projectDir: project,
      workDir,
    });
    const series = (base) => Array.from({ length: 6 }, (_, i) => base + i);
    const d = decide({
      study: st,
      data: { a: { ms: { i1: series(100) } }, b: { ms: { i1: series(40) } } },
      gates: summaries,
    });
    assert.equal(d.candidates.b.verdict, "GATED-OUT");
    assert.match(d.candidates.b.reasons.join(), /gate exit failed on i1: exited 2, expected 0/);
  });
});
