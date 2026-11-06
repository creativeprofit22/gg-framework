import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import * as cli from "../../assets/bench-kit/lib/adapters/cli.mjs";
import * as fn from "../../assets/bench-kit/lib/adapters/function.mjs";
import * as httpAdapter from "../../assets/bench-kit/lib/adapters/http.mjs";
import {
  adapterExecutor,
  adapterValidators,
  buildJob,
} from "../../assets/bench-kit/lib/adapters/index.mjs";
import * as manual from "../../assets/bench-kit/lib/adapters/manual.mjs";
import { fillSlots, slotsIn } from "../../assets/bench-kit/lib/argv.mjs";
import { collectRuns, runStudy } from "../../assets/bench-kit/lib/runner.mjs";
import { detectDocker, dockerRunArgv } from "../../assets/bench-kit/lib/sandbox/docker.mjs";
import { runProcess, scrubEnv } from "../../assets/bench-kit/lib/sandbox/process.mjs";
import { validateStudy } from "../../assets/bench-kit/lib/study.mjs";

const node = process.execPath;

/** Candidate CLI: copies its input to {out}, prints JSON, optionally misbehaves. */
const ENGINE = `
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
const [mode, input, out] = process.argv.slice(2);
if (mode === "hang") setInterval(() => {}, 1000);
else {
  const data = readFileSync(input, "utf8");
  writeFileSync(input, "TAMPERED");
  writeFileSync(out, data.toUpperCase());
  console.log(JSON.stringify({ secret: process.env.BENCH_SECRET ?? null, nodeOptions: process.env.NODE_OPTIONS ?? null, passed: process.env.PASS_ME ?? null, set: process.env.SET_ME ?? null, tmp: process.env.TMP ?? process.env.TMPDIR }));
  if (mode === "fail") process.exit(3);
}
`;

let project;
let studyDir;
let study;
const fixedNow = () => "2026-10-20T00:00:00.000Z";

const baseStudy = () => ({
  schema: 1,
  id: "adapters",
  title: "Adapters",
  question: "Do the adapters work?",
  repeats: 2,
  seed: 3,
  timeoutMs: 8_000,
  candidates: [
    {
      id: "cli-ok",
      adapter: {
        type: "cli",
        command: `"${node}" engine.mjs ok {input} {out}`,
        prepare: `"${node}" hook.mjs prepare {tmp}`,
        cleanup: `"${node}" hook.mjs cleanup {tmp}`,
        outputExt: ".txt",
        passEnv: ["PASS_ME"],
        env: { SET_ME: "yes" },
      },
    },
    {
      id: "fn-sort",
      adapter: {
        type: "function",
        module: "sorts.mjs",
        export: "sort",
        inputFormat: "json",
        measure: { warmup: 1, minSamples: 5, minTimeMs: 5 },
      },
    },
  ],
  workload: { items: [{ id: "small", input: "small.json", expectedFile: "small.expected.json" }] },
  metrics: [{ id: "ms", type: "wall-time", better: "lower" }],
  decision: { reference: "cli-ok", primary: { metric: "ms", better: "lower", minRatio: 1.1 } },
});

const slot = (candidate, extra = {}) => ({
  index: 0,
  phase: "measure",
  repeat: 0,
  item: "small",
  candidate,
  position: 0,
  ...extra,
});
const job = (candidate, adapter, extra = {}) => {
  const s = {
    ...study,
    candidates: [...study.candidates, ...(adapter ? [{ id: candidate, adapter }] : [])],
  };
  return buildJob({
    study: s,
    slot: slot(candidate, extra.slot),
    studyDir,
    projectDir: project,
    runId: extra.runId ?? `direct-${candidate}-${Math.random().toString(36).slice(2, 8)}`,
    config: extra.config,
    docker: extra.docker,
    timeoutMs: extra.timeoutMs,
  });
};

before(async () => {
  project = await mkdtemp(path.join(os.tmpdir(), "bench-adapters-"));
  studyDir = path.join(project, "bench", "studies", "adapters");
  await mkdir(path.join(studyDir, "workload"), { recursive: true });
  await writeFile(path.join(project, "engine.mjs"), ENGINE);
  await writeFile(
    path.join(project, "hook.mjs"),
    `import { writeFileSync, rmSync, existsSync } from "node:fs";\nimport path from "node:path";\nconst [what, dir] = process.argv.slice(2);\nif (what === "prepare") writeFileSync(path.join(dir, "prepared.flag"), "1");\nif (what === "cleanup") { if (!existsSync(path.join(dir, "prepared.flag"))) process.exit(9); rmSync(path.join(dir, "prepared.flag")); }\nif (what === "fail") { console.error("hook broke"); process.exit(2); }\n`,
  );
  await writeFile(
    path.join(project, "sorts.mjs"),
    "export function sort(xs) { return [...xs].sort((a, b) => a - b); }\nexport function bytes() { return new Uint8Array([1, 2, 3]); }\nexport function boom() { throw new Error('bad sort'); }\n",
  );
  await writeFile(path.join(studyDir, "workload", "small.json"), "[3,1,2]\n");
  await writeFile(path.join(studyDir, "workload", "small.expected.json"), "[1,2,3]\n");
  await writeFile(
    path.join(studyDir, "workload", "manual.csv"),
    'candidate,item,repeat,export_seconds,fps\nlab,small,0,41.5,\nlab,small,0,42,"30"\nlab,small,1,40,29.5\n',
  );
  await writeFile(
    path.join(studyDir, "workload", "manual.json"),
    JSON.stringify([
      { candidate: "lab", item: "small", repeat: 0, values: { export_seconds: 12.5 } },
    ]),
  );
  study = baseStudy();
});

after(async () => {
  await rm(project, { recursive: true, force: true });
});

describe("adapter config validation", () => {
  it("accepts the base study through the registry", () => {
    assert.deepEqual(validateStudy(study, { adapters: adapterValidators() }), []);
  });

  it("names unknown slots, bad paths and missing fields", () => {
    assert.match(cli.validate({ command: "x {inptu}" }).join(), /unknown slot\(s\) \{inptu\}/);
    assert.match(cli.validate({}).join(), /command: required/);
    assert.match(
      cli.validate({ command: "x", cwd: "../up", passEnv: ["BAD NAME"] }).join("\n"),
      /cwd[\s\S]*passEnv/,
    );
    assert.match(
      fn
        .validate({ module: "/abs.mjs", inputFormat: "xml", measure: { minSamples: -1, nope: 1 } })
        .join("\n"),
      /module[\s\S]*inputFormat[\s\S]*minSamples[\s\S]*nope/,
    );
    assert.match(
      httpAdapter.validate({ path: "no-slash" }).join("\n"),
      /baseUrl or service[\s\S]*path/,
    );
    assert.match(
      httpAdapter.validate({ baseUrl: "ftp://x", path: "/{bogus}" }).join("\n"),
      /baseUrl[\s\S]*\{bogus\}/,
    );
    assert.match(
      manual.validate({ file: "../x.csv", provenance: "me" }).join("\n"),
      /file[\s\S]*provenance/,
    );
  });

  it("slot filling never produces empty arguments", () => {
    assert.deepEqual(slotsIn(["a {input}", "{out}-{input}"]), ["input", "out"]);
    assert.deepEqual(fillSlots(["--in", "{input}"], { input: "C:\\a b\\c.json" }).value, [
      "--in",
      "C:\\a b\\c.json",
    ]);
    assert.equal(
      fillSlots(["{expected}"], { expected: undefined, input: "x" }).error.code,
      "SLOT_UNAVAILABLE",
    );
  });
});

describe("process sandbox", () => {
  it("scrubs the environment to an allowlist plus named variables", () => {
    const env = scrubEnv(
      {
        PATH: "/bin",
        Path: "C:\\bin",
        OPENAI_API_KEY: "sk-x",
        NODE_OPTIONS: "--inspect",
        NODE_TEST_CONTEXT: "child",
        KEEP: "1",
        Foo: "a",
      },
      { pass: ["KEEP"], set: { FOO: "b" }, tmpDir: "/t", platform: "win32" },
    );
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.NODE_TEST_CONTEXT, undefined);
    assert.equal(env.KEEP, "1");
    assert.equal(env.FOO, "b");
    assert.equal(env.Foo, undefined, "case-insensitive override on Windows");
    assert.equal(env.TMP, "/t");
    assert.equal(env.PATH, "/bin");
  });

  it("captures exit code, stdout tail and a sampled peak", async () => {
    const r = await runProcess(
      [node, "-e", "const b = Buffer.alloc(32e6, 1); console.log('hi', b.length); process.exit(4)"],
      { timeoutMs: 10_000, sampleMemory: true, memoryIntervalMs: 20 },
    );
    assert.equal(r.exitCode, 4);
    assert.match(r.stdoutTail, /hi 32000000/);
    assert.ok(r.wallMs > 0);
    assert.ok(r.memory, "memory reading present");
    assert.match(r.memory.label, /^sampled/);
  });

  it("reports a missing command instead of throwing", async () => {
    const r = await runProcess(["definitely-not-a-real-command-xyz"], { timeoutMs: 5_000 });
    assert.equal(r.spawnError.code, "COMMAND_NOT_FOUND");
  });
});

describe("cli adapter", () => {
  it(
    "runs prepare → command → cleanup on a copy of the input with a scrubbed env",
    { timeout: 30_000 },
    async () => {
      process.env.BENCH_SECRET = "do-not-leak";
      process.env.PASS_ME = "passed";
      try {
        const j = job("cli-ok");
        const r = await cli.runSample(j);
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.ok(r.metrics.wallMs > 0);
        assert.equal(r.metrics.exitCode, 0);
        assert.equal(r.metrics.outputBytes, "[3,1,2]\n".length);
        assert.equal(r.info.exitCode, 0);
        const reported = JSON.parse(r.info.stdoutTail.trim());
        assert.deepEqual(
          { ...reported, tmp: undefined },
          { secret: null, nodeOptions: null, passed: "passed", set: "yes", tmp: undefined },
        );
        assert.equal(reported.tmp, path.join(j.sampleDir, "tmp"));
        assert.equal(
          await readFile(path.join(studyDir, r.info.outPath), "utf8"),
          "[3,1,2]\n".toUpperCase(),
        );
        assert.equal(
          await readFile(path.join(studyDir, "workload", "small.json"), "utf8"),
          "[3,1,2]\n",
          "frozen workload untouched",
        );
        assert.equal(
          await readFile(path.join(j.sampleDir, "input", "small.json"), "utf8"),
          "TAMPERED",
          "only the copy changed",
        );
        assert.match(r.info.peakMemory.label, /sampled|unmeasured/);
      } finally {
        delete process.env.BENCH_SECRET;
        delete process.env.PASS_ME;
      }
    },
  );

  it("records a non-zero exit as behaviour, not a harness error", async () => {
    const r = await cli.runSample(
      job("cli-fail", { type: "cli", command: `"${node}" engine.mjs fail {input} {out}` }),
    );
    assert.equal(r.ok, true);
    assert.equal(r.info.exitCode, 3);
    assert.equal(r.metrics.exitCode, 3);
  });

  it(
    "errors on timeouts, failing hooks, missing commands and unavailable slots",
    { timeout: 30_000 },
    async () => {
      const hang = await cli.runSample(
        job(
          "cli-hang",
          { type: "cli", command: `"${node}" engine.mjs hang {input} {out}` },
          { timeoutMs: 800 },
        ),
      );
      assert.equal(hang.error.code, "TIMEOUT");
      const prep = await cli.runSample(
        job("cli-prep", {
          type: "cli",
          command: `"${node}" engine.mjs ok {input} {out}`,
          prepare: `"${node}" hook.mjs fail x`,
        }),
      );
      assert.equal(prep.error.code, "PREPARE_FAILED");
      assert.match(prep.error.message, /hook broke/);
      const clean = await cli.runSample(
        job("cli-clean", {
          type: "cli",
          command: `"${node}" engine.mjs ok {input} {out}`,
          cleanup: `"${node}" hook.mjs fail x`,
        }),
      );
      assert.equal(clean.error.code, "CLEANUP_FAILED");
      const missing = await cli.runSample(
        job("cli-missing", { type: "cli", command: "no-such-engine-binary {input}" }),
      );
      assert.equal(missing.error.code, "COMMAND_NOT_FOUND");
      const noExpected = {
        ...study,
        workload: { items: [{ id: "small", input: "small.json" }] },
        candidates: [
          ...study.candidates,
          {
            id: "cli-exp",
            adapter: { type: "cli", command: `"${node}" engine.mjs ok {expected} {out}` },
          },
        ],
      };
      const j = buildJob({
        study: noExpected,
        slot: slot("cli-exp"),
        studyDir,
        projectDir: project,
        runId: "noexp",
      });
      assert.equal((await cli.runSample(j)).error.code, "SLOT_UNAVAILABLE");
    },
  );

  it("refuses the docker sandbox when docker was not detected", async () => {
    const dockerStudy = { ...study, sandbox: { type: "docker", image: "node:22" } };
    const j = buildJob({
      study: dockerStudy,
      slot: slot("cli-ok"),
      studyDir,
      projectDir: project,
      runId: "dock",
      docker: { available: false, reason: "docker not available: ENOENT" },
    });
    const r = await cli.runSample(j);
    assert.equal(r.error.code, "SANDBOX_UNAVAILABLE");
    assert.match(r.error.message, /ENOENT/);
  });
});

describe("docker sandbox (argument building only; no docker on this machine)", () => {
  it("locks the container down and mounts only what it needs", () => {
    const argv = dockerRunArgv({
      image: "img:1",
      argv: ["engine", "/bench/input/a.json"],
      projectDir: "/p",
      inputDir: "/s/input",
      outDir: "/s/out",
      env: { B: "2", A: "1" },
    });
    const text = argv.join(" ");
    for (const flag of [
      "--rm",
      "--pull never",
      "--network none",
      "--read-only",
      "--cap-drop ALL",
      "--security-opt no-new-privileges",
      "--pids-limit 256",
      "--memory 2g",
    ])
      assert.ok(text.includes(flag), `missing ${flag}`);
    assert.ok(text.includes("type=bind,source=/p,target=/project,readonly"));
    assert.ok(text.includes("type=bind,source=/s/input,target=/bench/input,readonly"));
    assert.ok(text.includes("type=bind,source=/s/out,target=/bench/out "), "out is writable");
    assert.ok(text.indexOf("A=1") < text.indexOf("B=2"), "env sorted");
    assert.deepEqual(argv.slice(-3), ["img:1", "engine", "/bench/input/a.json"]);
  });

  it("forwards pass-through variables by name only, so their values never reach argv", () => {
    const argv = dockerRunArgv({
      image: "img:1",
      argv: ["engine"],
      projectDir: "/p",
      inputDir: "/s/input",
      outDir: "/s/out",
      env: { A: "1" },
      passEnv: ["TOKEN", "A", "TOKEN"],
    });
    const envArgs = argv.flatMap((v, i) => (argv[i - 1] === "--env" ? [v] : []));
    assert.deepEqual(envArgs, ["A=1", "TOKEN"]);
  });

  it("detects docker only when the daemon answers", async () => {
    assert.deepEqual(await detectDocker({ exec: async () => ({ ok: true, stdout: "27.1.1\n" }) }), {
      available: true,
      version: "27.1.1",
    });
    const missing = await detectDocker({
      exec: async () => ({ ok: false, stdout: "", error: "ENOENT" }),
    });
    assert.equal(missing.available, false);
    assert.match(missing.reason, /ENOENT/);
  });
});

describe("function adapter", () => {
  it("times the export in process and saves its first output", async () => {
    const j = job("fn-sort");
    const r = await fn.runSample(j);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.metrics.wallMs >= 0);
    assert.ok(r.metrics.iterations >= 5);
    assert.ok(r.metrics.peakMemoryBytes > 0);
    assert.equal(await readFile(path.join(studyDir, r.info.outPath), "utf8"), "[1,2,3]");
    assert.equal(r.info.timing, "per call, median of the in-process loop");
  });

  it("saves binary output and reports missing exports", async () => {
    const bin = await fn.runSample(
      job("fn-bytes", {
        type: "function",
        module: "sorts.mjs",
        export: "bytes",
        measure: { warmup: 0, minSamples: 2, minTimeMs: 0 },
      }),
    );
    assert.equal(bin.metrics.outputBytes, 3);
    assert.match(bin.info.outPath, /output\.bin$/);
    const missing = await fn.runSample(
      job("fn-missing", { type: "function", module: "sorts.mjs", export: "nope" }),
    );
    assert.equal(missing.error.code, "FUNCTION_MISSING");
  });
});

describe("http adapter", () => {
  let server;
  let baseUrl;
  before(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url.startsWith("/slow")) return setTimeout(() => res.end("late"), 2_000);
        res.writeHead(req.url.includes("missing") ? 404 : 200, { "content-type": "text/plain" });
        res.end(`${req.method} ${req.url} ${body.trim()}`);
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  it("sends the input, records status and saves the body", async () => {
    const r = await httpAdapter.runSample(
      job(
        "svc",
        {
          type: "http",
          service: "engine",
          method: "POST",
          path: "/render?item={item}",
          body: "input",
        },
        { config: { services: { engine: baseUrl } } },
      ),
    );
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.metrics.status, 200);
    assert.ok(r.metrics.ttfbMs <= r.metrics.wallMs);
    assert.equal(
      await readFile(path.join(studyDir, r.info.outPath), "utf8"),
      "POST /render?item=small [3,1,2]",
    );
  });

  it(
    "records a 404 as status, errors on a missing service, timeouts and refused connections",
    { timeout: 15_000 },
    async () => {
      const notFound = await httpAdapter.runSample(
        job("svc-404", { type: "http", baseUrl, path: "/missing" }),
      );
      assert.equal(notFound.ok, true);
      assert.equal(notFound.info.status, 404);
      const unconfigured = await httpAdapter.runSample(
        job("svc-none", { type: "http", service: "ghost" }),
      );
      assert.equal(unconfigured.error.code, "SERVICE_UNCONFIGURED");
      const slow = await httpAdapter.runSample(
        job("svc-slow", { type: "http", baseUrl, path: "/slow" }, { timeoutMs: 300 }),
      );
      assert.equal(slow.error.code, "TIMEOUT");
      const refused = await httpAdapter.runSample(
        job("svc-down", { type: "http", baseUrl: "http://127.0.0.1:9", path: "/" }),
      );
      assert.equal(refused.error.code, "HTTP_FAILED");
    },
  );
});

describe("manual adapter", () => {
  const provenance = "Measured by hand on the lab Pixel 8, 2026-10-19, stopwatch app";
  it("parses quoted CSV and treats empty cells as unmeasured", () => {
    assert.deepEqual(manual.parseCsv('a,b\n"x,1","say ""hi"""\r\n\n'), [
      ["a", "b"],
      ["x,1", 'say "hi"'],
    ]);
    const rows = manual.parseManual("candidate,item,repeat,s,fps\nlab,small,1,40,\n", "csv").value;
    assert.deepEqual(rows, [{ candidate: "lab", item: "small", repeat: 1, values: { s: 40 } }]);
    assert.equal(manual.parseManual("candidate,item\n", "csv").error.code, "MANUAL_INVALID");
    assert.equal(
      manual.parseManual("candidate,item,repeat,s\nlab,small,0,fast\n", "csv").error.code,
      "MANUAL_INVALID",
    );
  });

  it("returns the row for the slot, refuses duplicates and missing rows", async () => {
    const csv = { type: "manual", file: "manual.csv", provenance };
    const one = await manual.runSample(job("lab", csv, { slot: { repeat: 1 } }));
    assert.deepEqual(one.metrics, { "reported.export_seconds": 40, "reported.fps": 29.5 });
    assert.equal(one.info.provenance, provenance);
    assert.equal(
      (await manual.runSample(job("lab", csv, { slot: { repeat: 0 } }))).error.code,
      "MANUAL_DUPLICATE",
    );
    assert.equal(
      (await manual.runSample(job("lab", csv, { slot: { repeat: 5 } }))).error.code,
      "MANUAL_MISSING",
    );
    const warm = await manual.runSample(job("lab", csv, { slot: { phase: "warmup", repeat: 0 } }));
    assert.deepEqual(warm.metrics, {});
    const json = await manual.runSample(
      job("lab", { type: "manual", file: "manual.json", provenance }),
    );
    assert.deepEqual(json.metrics, { "reported.export_seconds": 12.5 });
  });
});

describe("end to end through fresh workers", () => {
  it("runs a cli and a function candidate via the runner", { timeout: 60_000 }, async () => {
    const run = await runStudy({
      study,
      studyDir,
      runId: "e2e",
      protocol: { version: 1, digest: "d" },
      execute: adapterExecutor({ study, studyDir, projectDir: project, runId: "e2e" }),
      now: fixedNow,
    });
    assert.equal(run.ok, true);
    assert.deepEqual(run.value.counts["cli-ok"], {
      planned: 2,
      completed: 2,
      errored: 0,
      notRun: 0,
    });
    assert.deepEqual(run.value.counts["fn-sort"], {
      planned: 2,
      completed: 2,
      errored: 0,
      notRun: 0,
    });
    const pooled = await collectRuns([path.join(studyDir, "runs", "e2e")]);
    assert.equal(pooled.value.data["cli-ok"].wallMs.small.length, 2);
    assert.equal(pooled.value.data["fn-sort"].iterations.small.length, 2);
  });
});
