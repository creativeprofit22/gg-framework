// Scenario tests for the bench kit CLI (plan scenarios 1-4, 7, 8, 9).
// Every scenario uses tiny local candidates; nothing touches the network.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { main, parseArgs } from "../../assets/bench-kit/cli.mjs";

const CLI = fileURLToPath(new URL("../../assets/bench-kit/cli.mjs", import.meta.url));
const node = process.execPath;

let project;
const quiet = { stderr: () => {} };

/** Run the CLI in-process against the fixture project. */
async function cli(...argv) {
  const { code, output } = await main([...argv, "--project", project], quiet);
  return { code, out: /** @type {any} */ (output) };
}

/** Write a study folder with its workload files. */
async function writeStudy(study, files = {}) {
  const dir = path.join(project, "bench", "studies", study.id);
  await mkdir(path.join(dir, "workload"), { recursive: true });
  await writeFile(path.join(dir, "study.json"), `${JSON.stringify(study, null, 2)}\n`);
  for (const [name, text] of Object.entries(files))
    await writeFile(path.join(dir, "workload", name), text);
  return dir;
}

const fnCandidate = (id, exportName, extra = {}) => ({
  id,
  adapter: {
    type: "function",
    module: "loops.mjs",
    export: exportName,
    inputFormat: "json",
    measure: { warmup: 2, minSamples: 8, minTimeMs: 10 },
  },
  ...extra,
});

const LOOPS = `
const spin = (n) => { let s = 0; for (let i = 0; i < n; i++) s = (s + i * 7) % 1000003; return s; };
export const twice = (input) => ({ sum: spin(input.n * 2) });
export const once = (input) => ({ sum: spin(input.n) });
export const twiceAgain = (input) => ({ sum: spin(input.n * 2) });
`;

const workloadFiles = {
  "small.json": `${JSON.stringify({ n: 400_000 })}\n`,
  "large.json": `${JSON.stringify({ n: 800_000 })}\n`,
};
const workloadItems = [
  { id: "small", input: "small.json" },
  { id: "large", input: "large.json" },
];

before(async () => {
  project = await mkdtemp(path.join(os.tmpdir(), "bench-cli-"));
  await writeFile(path.join(project, "loops.mjs"), LOOPS);
  await writeFile(
    path.join(project, "licence-gate.mjs"),
    `const id = process.argv[2];\nconsole.log(JSON.stringify(id === "loop-c" ? { pass: false, reason: "licence is not allowed for shipping" } : { pass: true, reason: "licence fits" }));\n`,
  );
  await writeFile(
    path.join(project, "tool.mjs"),
    `import { readFileSync, writeFileSync } from "node:fs";\nconst [input, out] = process.argv.slice(2);\nwriteFileSync(out, readFileSync(input, "utf8").toUpperCase());\n`,
  );
  await writeFile(
    path.join(project, "hook.mjs"),
    `import { existsSync, rmSync, writeFileSync } from "node:fs";\nimport path from "node:path";\nconst [what, dir, item] = process.argv.slice(2);\nif (what === "prepare") writeFileSync(path.join(dir, "prepared.flag"), "1");\nif (what === "cleanup") {\n  if (!existsSync(path.join(dir, "prepared.flag"))) process.exit(9);\n  rmSync(path.join(dir, "prepared.flag"));\n  if (item === "bad") { console.error("cleanup broke on bad"); process.exit(2); }\n}\n`,
  );
});

after(async () => {
  await rm(project, { recursive: true, force: true });
});

describe("argument parsing", () => {
  it("rejects unknown commands and options with a usage error", async () => {
    assert.throws(() => parseArgs(["nope"]), /unknown command/);
    assert.throws(() => parseArgs(["run", "x", "--repeat", "2"]), /does not take --repeat/);
    assert.throws(() => parseArgs(["validate"]), /takes 1 argument/);
    const r = await main(["run", "x", "--repeats", "3"], quiet);
    assert.equal(r.code, 2);
    assert.match(/** @type {any} */ (r.output).error.message, /only applies to --pilot/);
  });

  it("prints usage for help", async () => {
    const r = await main(["help"], quiet);
    assert.equal(r.code, 0);
    assert.match(String(r.output), /Usage: node bench\/kit\/cli\.mjs/);
  });

  it("runs as a real process and prints JSON with an exit code", async () => {
    const result = await new Promise((resolve) => {
      execFile(node, [CLI, "validate", "missing-study", "--project", project], (error, stdout) =>
        resolve({ code: error ? error.code : 0, stdout }),
      );
    });
    assert.equal(result.code, 1);
    const out = JSON.parse(result.stdout);
    assert.equal(out.ok, false);
    assert.equal(out.error.code, "STUDY_MISSING");
  });
});

describe("scenario 1: three function candidates, one about 2x faster", () => {
  const study = {
    schema: 1,
    id: "loops",
    title: "Pick a loop",
    question: "Which loop should the editor use?",
    kind: "code",
    repeats: 4,
    seed: 11,
    timeoutMs: 60_000,
    candidates: [
      fnCandidate("loop-a", "twice", { label: "Loop A (current)" }),
      fnCandidate("loop-b", "once", { label: "Loop B" }),
      fnCandidate("loop-c", "twiceAgain", { label: "Loop C" }),
    ],
    workload: { items: workloadItems },
    metrics: [
      { id: "call_ms", type: "wall-time", unit: "ms", better: "lower" },
      { id: "fps", type: "custom", source: "stdout-json", field: "fps", better: "higher" },
    ],
    decision: {
      reference: "loop-a",
      primary: { metric: "call_ms", better: "lower", minRatio: 1.3 },
      tieBreak: ["simpler code"],
    },
  };

  it("validates, freezes, runs and reports a WIN for the faster candidate", async () => {
    const dir = await writeStudy(study, workloadFiles);
    const v = await cli("validate", "loops");
    assert.equal(v.code, 0, JSON.stringify(v.out));
    assert.deepEqual(v.out.warnings, []);

    const f = await cli("freeze", "loops");
    assert.equal(f.code, 0, JSON.stringify(f.out));
    assert.equal(f.out.status, "created");
    assert.equal(f.out.version, 1);
    assert.equal((await cli("freeze", "loops")).out.status, "unchanged");

    const r = await cli("run", "loops", "--run-id", "full-1");
    assert.equal(r.code, 0, JSON.stringify(r.out));
    assert.equal(r.out.status, "complete");
    for (const id of ["loop-a", "loop-b", "loop-c"])
      assert.deepEqual(r.out.counts[id], { planned: 8, completed: 8, errored: 0, notRun: 0 });
    assert.equal((await cli("run", "loops", "--run-id", "full-1")).out.error.code, "RUN_EXISTS");

    const rep = await cli("report", "loops");
    assert.equal(rep.code, 0, JSON.stringify(rep.out));
    assert.equal(rep.out.verdict, "WIN");
    assert.equal(rep.out.winner, "loop-b");
    assert.equal(rep.out.keep, "loop-b");
    assert.deepEqual(rep.out.runs, ["full-1"]);
    assert.equal(rep.out.ledgerAction, "created");

    const verdict = JSON.parse(await readFile(path.join(dir, "verdict.json"), "utf8"));
    assert.equal(verdict.verdict, "WIN");
    assert.equal(verdict.candidates["loop-b"].verdict, "WIN");
    assert.ok(verdict.candidates["loop-b"].primary.lower > 1);

    const md = await readFile(path.join(dir, "report.md"), "utf8");
    assert.ok(!md.includes("\r"));
    const meanings = md.match(/What this means for you:/g) ?? [];
    assert.ok(meanings.length >= 4, "verdict plus one line per candidate");
    // scenario 8: an unmeasured metric is labelled, never shown as zero
    assert.match(md, /not measured/i);

    const ledger = await readFile(path.join(project, "bench", "RESULTS.md"), "utf8");
    assert.match(ledger, /<!-- bench:start loops v1 -->/);
    assert.match(ledger, /WIN: loop-b/);
    const again = await cli("report", "loops");
    assert.equal(again.out.ledgerAction, "replaced");
  });

  it("explains the study from its own numbers, then terms from the glossary", async () => {
    const s = await cli("explain", "loops");
    assert.equal(s.code, 0, JSON.stringify(s.out));
    assert.equal(s.out.kind, "study");
    assert.equal(s.out.verdict, "WIN");
    assert.match(s.out.rule, /replaces Loop A \(current\) \[loop-a\] only with/);

    const m = await cli("explain", "loops:call_ms");
    assert.equal(m.out.kind, "metric");
    assert.equal(m.out.results.length, 2);
    assert.match(m.out.results.join(" "), /faster/);

    const t = await cli("explain", "noise floor");
    assert.equal(t.out.kind, "term");
    assert.ok(t.out.plain.length > 20);

    const unknown = await cli("explain", "flux capacitor");
    assert.equal(unknown.code, 1);
    assert.equal(unknown.out.error.code, "TERM_UNKNOWN");

    const add = await cli(
      "explain",
      "decode fps",
      "--plain",
      "Frames decoded per second.",
      "--alias",
      "fps rate",
    );
    assert.equal(add.code, 0, JSON.stringify(add.out));
    assert.equal((await cli("explain", "fps rate")).out.plain, "Frames decoded per second.");
    const dup = await cli("explain", "decode fps", "--plain", "Again.");
    assert.equal(dup.out.error.code, "TERM_EXISTS");
    const shadow = await cli("explain", "p95", "--plain", "Mine now.");
    assert.equal(
      shadow.out.error.code,
      "TERM_EXISTS",
      "a project term never silently shadows a kit term",
    );
  });

  it("lists the study with its verdict", async () => {
    const l = await cli("list");
    assert.equal(l.code, 0);
    const entry = l.out.studies.find((s) => s.id === "loops");
    assert.equal(entry.verdict, "WIN");
    assert.equal(entry.protocolVersion, 1);
    assert.equal(entry.runs, 1);
  });
});

describe("scenario 2 and 8: same-vs-same never wins, and its wording never claims one", () => {
  it("gives TIE or INCONCLUSIVE and the A/A check reports a noise floor", async () => {
    const dir = await writeStudy(
      {
        schema: 1,
        id: "same",
        title: "Same vs same",
        question: "Is a copy of the loop any faster?",
        repeats: 4,
        seed: 5,
        timeoutMs: 60_000,
        candidates: [
          fnCandidate("loop-a", "twice"),
          fnCandidate("loop-copy", "twiceAgain", { synthetic: true, label: "Loop copy" }),
        ],
        workload: { items: workloadItems },
        metrics: [{ id: "call_ms", type: "wall-time", better: "lower" }],
        decision: {
          reference: "loop-a",
          primary: { metric: "call_ms", better: "lower", minRatio: 1.3 },
          noise: { requireAA: true },
        },
      },
      workloadFiles,
    );
    assert.equal((await cli("freeze", "same")).code, 0);

    const withoutAA = await cli("run", "same", "--run-id", "full-1");
    assert.equal(withoutAA.code, 0, JSON.stringify(withoutAA.out));
    const first = await cli("report", "same");
    assert.equal(first.code, 0, JSON.stringify(first.out));
    assert.equal(first.out.verdict, "INCONCLUSIVE", "required A/A missing");
    assert.match(first.out.headline + first.out.meaning, /A\/A|same-vs-same|noise|not/i);

    const aa = await cli("aa", "same", "--run-id", "aa-1");
    assert.equal(aa.code, 0, JSON.stringify(aa.out));
    assert.equal(aa.out.kind, "aa");
    assert.equal(typeof aa.out.aa.passed, "boolean");
    assert.ok(aa.out.aa.ci.lower !== undefined);

    const rep = await cli("report", "same");
    assert.equal(rep.code, 0, JSON.stringify(rep.out));
    assert.ok(["TIE", "INCONCLUSIVE"].includes(rep.out.verdict), rep.out.verdict);
    assert.notEqual(rep.out.candidates["loop-copy"].verdict, "WIN");
    assert.equal(rep.out.aa.runId, "aa-1");
    const md = await readFile(path.join(dir, "report.md"), "utf8");
    assert.doesNotMatch(rep.out.headline, /\bwins?\b|\bbetter choice\b/i);
    assert.match(md, /\[synthetic stand-in\]/);
    assert.doesNotMatch(md, /\bloop-copy\b[^\n]*\bwins\b/i);
  });
});

describe("scenario 3: a candidate failing a gate is GATED-OUT with the reason", () => {
  it("excludes the candidate and keeps the reason", async () => {
    await writeStudy(
      {
        schema: 1,
        id: "gated",
        title: "Gated",
        question: "Which loop may we ship?",
        repeats: 2,
        seed: 3,
        timeoutMs: 60_000,
        candidates: [
          fnCandidate("loop-a", "twice"),
          fnCandidate("loop-b", "once"),
          fnCandidate("loop-c", "twiceAgain"),
        ],
        workload: { items: [workloadItems[0]] },
        metrics: [{ id: "call_ms", type: "wall-time", better: "lower" }],
        gates: [
          {
            id: "licence-fit",
            type: "command",
            scope: "candidate",
            command: `"${node}" licence-gate.mjs {candidate}`,
          },
        ],
        decision: {
          reference: "loop-a",
          primary: { metric: "call_ms", better: "lower", minRatio: 1.3 },
        },
      },
      { "small.json": workloadFiles["small.json"] },
    );
    assert.equal((await cli("freeze", "gated")).code, 0);
    assert.equal((await cli("run", "gated", "--run-id", "full-1")).code, 0);
    const rep = await cli("report", "gated");
    assert.equal(rep.code, 0, JSON.stringify(rep.out));
    assert.equal(rep.out.candidates["loop-c"].verdict, "GATED-OUT");
    assert.match(
      rep.out.candidates["loop-c"].headline + rep.out.candidates["loop-c"].meaning,
      /licence/i,
    );
    const verdict = JSON.parse(
      await readFile(path.join(project, "bench", "studies", "gated", "verdict.json"), "utf8"),
    );
    assert.match(verdict.candidates["loop-c"].reasons.join(" "), /licence is not allowed/);
    const checks = JSON.parse(await readFile(rep.out.files.gateChecks, "utf8"));
    assert.equal(checks.filter((c) => c.status === "fail").length, 1);
  });
});

describe("scenario 4: CLI candidates with prepare/cleanup and errored samples", () => {
  it("counts errored samples, never reruns them, and refuses a verdict on too many", async () => {
    const tool = (id, extra = {}) => ({
      id,
      adapter: {
        type: "cli",
        command: `"${node}" tool.mjs {input} {out}`,
        prepare: `"${node}" hook.mjs prepare {tmp} {item}`,
        cleanup: `"${node}" hook.mjs cleanup {tmp} {item}`,
        outputExt: ".txt",
        ...extra,
      },
    });
    const dir = await writeStudy(
      {
        schema: 1,
        id: "tools",
        title: "Tools",
        question: "Which tool should we call?",
        repeats: 2,
        seed: 9,
        timeoutMs: 30_000,
        candidates: [
          tool("tool-a"),
          tool("tool-b", { cleanup: `"${node}" hook.mjs cleanup {tmp} {item}x` }),
        ],
        workload: {
          items: [
            { id: "good", input: "good.txt" },
            { id: "bad", input: "bad.txt" },
          ],
        },
        metrics: [{ id: "wall_ms", type: "wall-time", better: "lower" }],
        gates: [{ id: "exits-cleanly", type: "exit-code", scope: "sample" }],
        decision: {
          reference: "tool-b",
          primary: { metric: "wall_ms", better: "lower", minRatio: 1.2 },
        },
      },
      { "good.txt": "fine\n", "bad.txt": "broken\n" },
    );
    assert.equal((await cli("freeze", "tools")).code, 0);
    const r = await cli("run", "tools", "--run-id", "full-1");
    assert.equal(r.code, 0, JSON.stringify(r.out));
    // tool-a's cleanup fails on item "bad"; tool-b's never sees item "bad" (its {item}x is "badx").
    assert.deepEqual(r.out.counts["tool-a"], { planned: 4, completed: 2, errored: 2, notRun: 0 });
    assert.deepEqual(r.out.counts["tool-b"], { planned: 4, completed: 4, errored: 0, notRun: 0 });
    const errors = (await readFile(path.join(r.out.runDir, "errors.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(errors.length, 2);
    assert.ok(errors.every((e) => e.candidate === "tool-a" && e.item === "bad"));
    assert.match(errors[0].error.message, /cleanup/);

    const rep = await cli("report", "tools");
    assert.equal(rep.code, 0, JSON.stringify(rep.out));
    assert.equal(rep.out.verdict, "INCONCLUSIVE");
    assert.equal(rep.out.candidates["tool-a"].verdict, "INCONCLUSIVE");
    const md = await readFile(path.join(dir, "report.md"), "utf8");
    assert.match(md, /2\/4 ok, 2 errored/);
  });
});

describe("scenario 7 and 9: editing after freezing makes a new version; blind ratings", () => {
  const base = {
    schema: 1,
    id: "versions",
    title: "Versions",
    question: "Which loop reads better?",
    repeats: 2,
    seed: 4,
    timeoutMs: 60_000,
    candidates: [fnCandidate("loop-a", "twice"), fnCandidate("loop-b", "once")],
    workload: { items: workloadItems },
    metrics: [
      { id: "call_ms", type: "wall-time", better: "lower" },
      { id: "preference", type: "rating", better: "higher", label: "Blind preference" },
    ],
    decision: {
      reference: "loop-a",
      primary: { metric: "call_ms", better: "lower", minRatio: 1.3 },
    },
  };

  it("refuses drifted studies and never pools runs across versions", async () => {
    const dir = await writeStudy(base, workloadFiles);
    assert.equal((await cli("freeze", "versions")).out.version, 1);
    assert.equal((await cli("run", "versions", "--run-id", "v1-run")).code, 0);

    await writeFile(
      path.join(dir, "study.json"),
      `${JSON.stringify({ ...base, title: "Versions, reworded" }, null, 2)}\n`,
    );
    const drifted = await cli("run", "versions", "--run-id", "v1-late");
    assert.equal(drifted.code, 1);
    assert.equal(drifted.out.error.code, "PROTOCOL_DRIFT");
    assert.deepEqual(drifted.out.error.details, ["study.json"]);
    assert.equal((await cli("report", "versions")).out.error.code, "PROTOCOL_DRIFT");

    const refrozen = await cli("freeze", "versions");
    assert.equal(refrozen.out.status, "new-version");
    assert.equal(refrozen.out.version, 2);
    assert.deepEqual(refrozen.out.changed, ["study.json"]);

    const none = await cli("report", "versions");
    assert.equal(none.out.error.code, "NO_RUNS");
    assert.match(none.out.error.message, /only for v1/);
    assert.equal(
      (await cli("report", "versions", "--runs", "v1-run")).out.error.code,
      "PROTOCOL_STALE",
    );

    assert.equal((await cli("run", "versions", "--run-id", "v2-run")).code, 0);
    assert.equal(
      (await cli("report", "versions", "--runs", "v1-run,v2-run")).out.error.code,
      "POOL_MIXED",
    );
    const rep = await cli("report", "versions");
    assert.equal(rep.code, 0, JSON.stringify(rep.out));
    assert.deepEqual(rep.out.runs, ["v2-run"]);
    assert.equal(rep.out.protocolVersion, 2);
    const md = await readFile(path.join(dir, "report.md"), "utf8");
    assert.match(md, /no blind ratings have been imported yet/);

    const pilot = await cli("run", "versions", "--pilot", "--repeats", "2", "--run-id", "pilot-1");
    assert.equal(pilot.code, 0, JSON.stringify(pilot.out));
    assert.equal(pilot.out.kind, "pilot");
    assert.deepEqual(
      (await cli("report", "versions")).out.runs,
      ["v2-run"],
      "pilots are never evidence",
    );
    assert.equal((await cli("report", "versions", "--runs", "pilot-1")).out.error.code, "RUN_KIND");

    // Choosing a subset of full runs is allowed but never silent.
    assert.equal((await cli("run", "versions", "--run-id", "v2-run-b")).code, 0);
    const subset = await cli("report", "versions", "--runs", "v2-run");
    assert.equal(subset.code, 0, JSON.stringify(subset.out));
    assert.deepEqual(subset.out.excludedRuns, ["v2-run-b"]);
    assert.match(
      await readFile(path.join(dir, "report.md"), "utf8"),
      /Left out by choice: v2-run-b\./,
    );
    const verdict = JSON.parse(await readFile(path.join(dir, "verdict.json"), "utf8"));
    assert.deepEqual(verdict.excludedRuns, ["v2-run-b"]);
    const all = await cli("report", "versions");
    assert.deepEqual(all.out.runs, ["v2-run", "v2-run-b"]);
    assert.equal(all.out.excludedRuns, undefined);
  });

  it("builds a blind pack with a separate key and feeds imported scores into the report", async () => {
    const dir = path.join(project, "bench", "studies", "versions");
    const created = await cli("rate", "versions", "create", "pack-1", "--run", "v2-run");
    assert.equal(created.code, 0, JSON.stringify(created.out));
    assert.equal(created.out.items, 2);
    const packFiles = await readdir(created.out.packDir, { recursive: true });
    assert.ok(!packFiles.some((f) => /key/i.test(String(f))), "the key never sits inside the pack");
    assert.ok(!created.out.keyFile.startsWith(created.out.packDir + path.sep));
    const packText = await readFile(path.join(created.out.packDir, "pack.json"), "utf8");
    assert.doesNotMatch(packText, /loop-a|loop-b/, "the pack never names candidates");

    const csv = await readFile(path.join(created.out.packDir, "scores.csv"), "utf8");
    const filled = csv
      .trim()
      .split("\n")
      .map((line, i) => (i === 0 ? line : `rater1${line.replace(/,,$/, ",4,")}`))
      .join("\n");
    const scores = path.join(project, "filled.csv");
    await writeFile(scores, `${filled}\n`);

    const imported = await cli("rate", "versions", "import", "pack-1", "filled.csv");
    assert.equal(imported.code, 0, JSON.stringify(imported.out));
    assert.equal(imported.out.metric, "preference");
    assert.equal(imported.out.rows, 4);
    assert.equal(imported.out.usedByReport, true);
    assert.deepEqual(imported.out.summary["loop-a"], { n: 2, mean: 4 });

    const rep = await cli("report", "versions");
    assert.equal(rep.code, 0, JSON.stringify(rep.out));
    assert.deepEqual(rep.out.ratings, ["pack-1"]);
    const md = await readFile(path.join(dir, "report.md"), "utf8");
    assert.doesNotMatch(md, /no blind ratings have been imported yet/);
    assert.match(md, /Blind preference/);

    const again = await cli("rate", "versions", "create", "pack-1", "--run", "v2-run");
    assert.equal(again.out.error.code, "RATING_PACK_EXISTS");
  });
});
