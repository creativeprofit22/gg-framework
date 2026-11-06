import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { measureFunction } from "../../assets/bench-kit/lib/measure.mjs";
import {
  aaStudy,
  baseCandidateId,
  collectRuns,
  forkExecutor,
  runStudy,
} from "../../assets/bench-kit/lib/runner.mjs";
import {
  pollPeakMemory,
  samplePeakMemory,
  selfPeakMemory,
} from "../../assets/bench-kit/lib/sampler.mjs";
import { runJob } from "../../assets/bench-kit/lib/worker.mjs";

/** Fake monotonic clock that advances `step` ms per read. */
const steppingClock = (step) => {
  let t = 0;
  return () => (t += step);
};

describe("in-process measurement stop rule", () => {
  it("needs BOTH min samples and min time", async () => {
    // Each iteration costs 2 clock reads × 5 ms = 10 ms of fake time.
    const slow = await measureFunction(() => {}, {
      warmup: 0,
      minSamples: 3,
      minTimeMs: 100,
      clock: steppingClock(5),
      gc: undefined,
    });
    assert.equal(slow.stoppedBy, "min-samples-and-time");
    assert.ok(
      slow.samplesMs.length >= 9 && slow.samplesMs.length <= 11,
      `got ${slow.samplesMs.length}`,
    );
    const fast = await measureFunction(() => {}, {
      warmup: 0,
      minSamples: 50,
      minTimeMs: 1,
      clock: steppingClock(1),
      gc: undefined,
    });
    assert.equal(fast.samplesMs.length, 50);
  });

  it("stops at the hard caps and runs warm-up first", async () => {
    let calls = 0;
    const capped = await measureFunction(() => calls++, {
      warmup: 3,
      minSamples: 1_000,
      minTimeMs: 0,
      maxSamples: 20,
      clock: steppingClock(1),
      gc: undefined,
    });
    assert.equal(capped.stoppedBy, "max-samples");
    assert.equal(capped.warmupMs.length, 3);
    assert.equal(calls, 23);
    const timed = await measureFunction(() => {}, {
      warmup: 0,
      minSamples: 1_000,
      minTimeMs: 0,
      maxTimeMs: 50,
      clock: steppingClock(5),
      gc: undefined,
    });
    assert.equal(timed.stoppedBy, "max-time");
  });

  it("forces gc around the loop and reports the heap delta only when gc is available", async () => {
    let gcCalls = 0;
    const heaps = [1_000, 1_600];
    const withGc = await measureFunction(async () => {}, {
      warmup: 0,
      minSamples: 2,
      minTimeMs: 0,
      clock: steppingClock(1),
      gc: () => gcCalls++,
      heapUsed: () => /** @type {number} */ (heaps.shift()),
    });
    assert.equal(withGc.gcForced, true);
    assert.equal(gcCalls, 2);
    assert.equal(withGc.heapDeltaBytes, 600);
    const without = await measureFunction(() => {}, {
      warmup: 0,
      minSamples: 2,
      minTimeMs: 0,
      clock: steppingClock(1),
      gc: undefined,
    });
    assert.equal(without.gcForced, false);
    assert.equal(without.heapDeltaBytes, null);
  });

  it("stops when aborted", async () => {
    const controller = new AbortController();
    let n = 0;
    const m = await measureFunction(
      () => {
        if (++n === 4) controller.abort();
      },
      {
        warmup: 0,
        minSamples: 100,
        minTimeMs: 0,
        clock: steppingClock(1),
        gc: undefined,
        signal: controller.signal,
      },
    );
    assert.equal(m.stoppedBy, "aborted");
    assert.equal(m.samplesMs.length, 4);
  });
});

describe("peak-memory sampling", () => {
  it("keeps the highest reading and labels the value as sampled", async () => {
    const readings = [10, 50, undefined, 30];
    /** @type {(() => void)[]} */
    const timers = [];
    const sampler = pollPeakMemory(1, {
      intervalMs: 25,
      method: "fake",
      probe: async () => readings.shift(),
      setTimer: (fn) => timers.push(fn),
      clearTimer: () => {},
    });
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setImmediate(r));
      timers.shift()?.();
    }
    await new Promise((r) => setImmediate(r));
    const result = await sampler.stop();
    assert.equal(result.peakBytes, 50);
    assert.equal(result.polls, 4);
    assert.equal(result.readings, 3);
    assert.match(result.label, /^sampled, 25 ms resolution/);
  });

  it("measures a real child process on this platform", { timeout: 20_000 }, async () => {
    const child = spawn(
      process.execPath,
      ["-e", "const b = Buffer.alloc(64 * 1024 * 1024, 1); setTimeout(() => b.length, 4000);"],
      { stdio: "ignore", windowsHide: true },
    );
    await new Promise((r) => child.once("spawn", r));
    const sampler = samplePeakMemory(/** @type {number} */ (child.pid), { intervalMs: 50 });
    await new Promise((r) => child.once("exit", r));
    const result = await sampler.stop();
    assert.ok(result.readings > 0, `no readings via ${result.method}`);
    assert.ok(
      /** @type {number} */ (result.peakBytes) > 32 * 1024 * 1024,
      `peak ${result.peakBytes}`,
    );
  });

  it("reads the worker's own exact peak", () => {
    const self = selfPeakMemory();
    assert.ok(/** @type {number} */ (self.peakBytes) > 0);
    assert.equal(self.method, "self-max-rss");
  });
});

const tinyStudy = () => ({
  id: "tiny",
  repeats: 2,
  warmupRepeats: 1,
  seed: 7,
  timeoutMs: 1_000,
  candidates: [{ id: "a" }, { id: "b" }, { id: "c" }],
  workload: { items: [{ id: "x" }, { id: "y" }] },
  decision: { reference: "a" },
  gates: [{ id: "g", appliesTo: ["a"] }],
});

describe("runner", () => {
  let dir;
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "bench-runner-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const fixedNow = () => "2026-10-20T00:00:00.000Z";

  it("runs every slot once, records errors and never retries", async () => {
    const calls = [];
    const execute = async (slot) => {
      calls.push(`${slot.phase}:${slot.repeat}:${slot.item}:${slot.candidate}`);
      if (slot.candidate === "c" && slot.item === "y")
        return { status: "errored", error: { code: "BOOM", message: "nope" } };
      if (
        slot.candidate === "b" &&
        slot.item === "x" &&
        slot.repeat === 0 &&
        slot.phase === "measure"
      )
        throw new Error("executor bug");
      return { status: "ok", metrics: { ms: slot.candidate === "a" ? 10 : 5 } };
    };
    const run = await runStudy({
      study: tinyStudy(),
      studyDir: dir,
      runId: "r1",
      protocol: { version: 1, digest: "d1" },
      execute,
      clock: steppingClock(1),
      now: fixedNow,
    });
    assert.equal(run.ok, true);
    // (1 warm-up + 2 repeats) × 2 items × 3 candidates, each exactly once.
    assert.equal(calls.length, 18);
    assert.equal(new Set(calls).size, 18);
    assert.equal(run.value.status, "complete");
    assert.deepEqual(run.value.counts.a, { planned: 4, completed: 4, errored: 0, notRun: 0 });
    assert.deepEqual(run.value.counts.b, { planned: 4, completed: 3, errored: 1, notRun: 0 });
    assert.deepEqual(run.value.counts.c, { planned: 4, completed: 2, errored: 2, notRun: 0 });

    const lines = (await readFile(path.join(dir, "runs/r1/samples.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(lines.length, 18);
    assert.ok(lines.every((l) => l.protocolDigest === "d1" && l.runId === "r1"));
    const errors = (await readFile(path.join(dir, "runs/r1/errors.jsonl"), "utf8"))
      .trim()
      .split("\n");
    assert.equal(errors.length, 4); // c/y: 1 warm-up + 2 measured; b: 1 executor bug
    assert.ok(errors.some((l) => JSON.parse(l).error.code === "EXECUTOR_THREW"));

    const again = await runStudy({
      study: tinyStudy(),
      studyDir: dir,
      runId: "r1",
      protocol: { version: 1, digest: "d1" },
      execute,
      now: fixedNow,
    });
    assert.equal(again.error.code, "RUN_EXISTS");
  });

  it("collects measured samples per candidate, metric and item, without warm-up", async () => {
    const pooled = await collectRuns([path.join(dir, "runs/r1")]);
    assert.equal(pooled.ok, true);
    assert.deepEqual(pooled.value.data.a.ms, { x: [10, 10], y: [10, 10] });
    assert.deepEqual(pooled.value.data.c.ms, { x: [5, 5] });
    assert.deepEqual(pooled.value.counts.c, { planned: 4, completed: 2, errored: 2, notRun: 0 });
    assert.equal(pooled.value.incomplete, undefined);
    assert.equal(pooled.value.samples.length, 12);
  });

  it("marks an aborted run and counts the slots it never reached", async () => {
    const controller = new AbortController();
    let n = 0;
    const execute = async () => {
      if (++n === 8) controller.abort();
      return { status: "ok", metrics: { ms: 1 } };
    };
    const run = await runStudy({
      study: tinyStudy(),
      studyDir: dir,
      runId: "r2",
      protocol: { version: 1, digest: "d1" },
      execute,
      now: fixedNow,
      signal: controller.signal,
    });
    assert.equal(run.value.status, "aborted");
    const total = Object.values(run.value.counts).reduce((s, c) => s + c.notRun, 0);
    assert.equal(total, 10); // 12 measured slots, 2 measured before the stop (6 warm-up first)
    const pooled = await collectRuns([path.join(dir, "runs/r1"), path.join(dir, "runs/r2")]);
    assert.match(pooled.value.incomplete, /r2 \(aborted\)/);
  });

  it("refuses to pool protocol versions, duplicates and unbalanced runs; skips pilots", async () => {
    const execute = async () => ({ status: "ok", metrics: { ms: 1 } });
    await runStudy({
      study: tinyStudy(),
      studyDir: dir,
      runId: "v2",
      protocol: { version: 2, digest: "d2" },
      execute,
      now: fixedNow,
    });
    const mixed = await collectRuns([path.join(dir, "runs/r1"), path.join(dir, "runs/v2")]);
    assert.equal(mixed.error.code, "POOL_MIXED");
    const dup = await collectRuns([path.join(dir, "runs/r1"), path.join(dir, "runs/r1")]);
    assert.equal(dup.error.code, "RUN_DUPLICATE");

    await runStudy({
      study: tinyStudy(),
      studyDir: dir,
      runId: "p1",
      kind: "pilot",
      repeats: 1,
      protocol: { version: 1, digest: "d1" },
      execute,
      now: fixedNow,
    });
    const noPilot = await collectRuns([path.join(dir, "runs/p1")]);
    assert.equal(noPilot.error.code, "POOL_EMPTY");
    const withPilot = await collectRuns([path.join(dir, "runs/p1")], { includePilot: true });
    assert.equal(withPilot.ok, true);

    const runJson = path.join(dir, "runs/v2/run.json");
    const tampered = JSON.parse(await readFile(runJson, "utf8"));
    tampered.planned.c = 1;
    await writeFile(runJson, JSON.stringify(tampered));
    const unbalanced = await collectRuns([path.join(dir, "runs/v2")]);
    assert.equal(unbalanced.error.code, "RUN_UNBALANCED");
  });

  it("builds a same-vs-same study from the reference", () => {
    const aa = aaStudy(tinyStudy());
    assert.deepEqual(
      aa.candidates.map((c) => c.id),
      ["a", "a~aa"],
    );
    assert.deepEqual(aa.gates[0].appliesTo, ["a", "a~aa"]);
    assert.equal(baseCandidateId("a~aa"), "a");
    assert.equal(baseCandidateId("a"), "a");
  });
});

describe("fresh worker per sample", () => {
  let dir;
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "bench-worker-"));
    await writeFile(
      path.join(dir, "adapter.mjs"),
      [
        "export async function runSample(job) {",
        "  console.log('candidate noise on stdout');",
        "  if (job.mode === 'throw') throw new Error('kaboom');",
        "  if (job.mode === 'fail') return { ok: false, error: { code: 'GATE', message: 'bad output' } };",
        "  if (job.mode === 'nan') return { ok: true, metrics: { ms: NaN } };",
        "  if (job.mode === 'exit') process.exit(3);",
        "  if (job.mode === 'hang') await new Promise(() => setInterval(() => {}, 1000));",
        "  return { ok: true, metrics: { ms: 1.5, gc: typeof globalThis.gc === 'function' ? 1 : 0, pid: process.pid } };",
        "}",
        "",
      ].join("\n"),
    );
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const slot = { index: 0, phase: "measure", repeat: 0, item: "x", candidate: "a", position: 0 };
  const exec = (mode, extra = {}) =>
    forkExecutor({
      jobFor: () => ({ adapterModule: path.join(dir, "adapter.mjs"), mode }),
      graceMs: 200,
      ...extra,
    })(slot, { timeoutMs: 1_500 });

  it(
    "returns metrics over IPC from a fresh process with gc exposed",
    { timeout: 20_000 },
    async () => {
      const first = await exec("ok");
      const second = await exec("ok");
      assert.equal(first.status, "ok");
      assert.equal(first.metrics.ms, 1.5);
      assert.equal(first.metrics.gc, 1);
      assert.notEqual(first.metrics.pid, process.pid);
      assert.notEqual(first.metrics.pid, second.metrics.pid);
    },
  );

  it(
    "classifies failures, throws, bad metrics, crashes and timeouts as errored",
    { timeout: 30_000 },
    async () => {
      assert.deepEqual((await exec("fail")).error, { code: "GATE", message: "bad output" });
      assert.equal((await exec("throw")).error.code, "SAMPLE_THREW");
      assert.equal((await exec("nan")).error.code, "ADAPTER_RESULT");
      assert.equal((await exec("exit")).error.code, "WORKER_CRASH");
      assert.equal((await exec("hang")).error.code, "TIMEOUT");
    },
  );

  it("reports a missing adapter module without crashing", async () => {
    const r = await runJob({ adapterModule: path.join(dir, "missing.mjs") });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "ADAPTER_LOAD");
  });
});
