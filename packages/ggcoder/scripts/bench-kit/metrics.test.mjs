import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { extractMetrics, metricValidators } from "../../assets/bench-kit/lib/metrics/index.mjs";

const V = metricValidators();
const errorsFor = (m) => V[m.type].validate(m).join("\n");

let studyDir;

async function sample({
  candidate = "a",
  item = "i1",
  index = 0,
  metrics = {},
  info = {},
  output,
  stdout,
  status = "ok",
  phase = "measure",
}) {
  const rel = `runs/r1/samples/${index}`;
  await mkdir(path.join(studyDir, rel, "out"), { recursive: true });
  const extra = {};
  if (output !== undefined) {
    await writeFile(path.join(studyDir, rel, "out", "output.json"), output);
    extra.outPath = `${rel}/out/output.json`;
  }
  if (stdout !== undefined) {
    await writeFile(path.join(studyDir, rel, "stdout.txt"), stdout);
    extra.stdoutPath = `${rel}/stdout.txt`;
  }
  return {
    runId: "r1",
    index,
    phase,
    repeat: 0,
    item,
    candidate,
    status,
    metrics,
    info: { ...extra, ...info },
  };
}

before(async () => {
  studyDir = await mkdtemp(path.join(os.tmpdir(), "bench-metrics-"));
});

after(async () => {
  await rm(studyDir, { recursive: true, force: true });
});

describe("metric config validation", () => {
  it("checks units, fields and custom sources", () => {
    assert.match(
      errorsFor({ id: "t", type: "wall-time", unit: "hours" }),
      /unit: expected one of ns\|us\|ms\|s\|min/,
    );
    assert.match(
      errorsFor({ id: "t", type: "wall-time", field: "cpuMs" }),
      /field: expected one of wallMs/,
    );
    assert.match(
      errorsFor({ id: "m", type: "peak-memory", unit: "mb" }),
      /unit: expected one of B\|KB\|MB/,
    );
    assert.match(errorsFor({ id: "c", type: "custom" }), /source: expected one of/);
    assert.match(
      errorsFor({ id: "c", type: "custom", source: "stdout-json", field: "a..b" }),
      /dotted path/,
    );
    assert.match(
      errorsFor({ id: "c", type: "custom", source: "stdout-regex", pattern: "fps \\d+" }),
      /capture group/,
    );
    assert.match(
      errorsFor({ id: "c", type: "custom", source: "gate", scale: 0, extra: 1 }),
      /extra: unknown option[\s\S]*gate: expected[\s\S]*scale/,
    );
    assert.equal(
      errorsFor({
        id: "c",
        type: "custom",
        source: "metric",
        field: "reported.export_seconds",
        unit: "s",
        better: "lower",
      }),
      "",
    );
  });
});

describe("extractMetrics", () => {
  it("maps raw adapter numbers onto study metrics with units, per item", async () => {
    const study = {
      metrics: [
        { id: "export_seconds", type: "wall-time", unit: "s" },
        { id: "peak_mb", type: "peak-memory", unit: "MB" },
        { id: "out_kib", type: "output-size", unit: "KiB" },
      ],
    };
    const samples = [
      await sample({
        index: 0,
        metrics: { wallMs: 1500, peakMemoryBytes: 2e6, outputBytes: 2048 },
        info: {
          timing: "process wall time, spawn to exit",
          peakMemory: { label: "sampled every 50 ms" },
        },
      }),
      await sample({
        index: 1,
        item: "i2",
        metrics: { wallMs: 500, peakMemoryBytes: 1e6, outputBytes: 1024 },
        info: { peakMemory: { label: "sampled every 50 ms" } },
      }),
      await sample({ index: 2, metrics: { wallMs: 99999 }, status: "errored" }),
      await sample({ index: 3, metrics: { wallMs: 99999 }, phase: "warmup" }),
    ];
    const { data, labels, unmeasured } = await extractMetrics({ study, samples, studyDir });
    assert.deepEqual(data.a.export_seconds, { i1: [1.5], i2: [0.5] });
    assert.deepEqual(data.a.peak_mb, { i1: [2], i2: [1] });
    assert.deepEqual(data.a.out_kib, { i1: [2], i2: [1] });
    assert.deepEqual(labels.peak_mb, ["sampled every 50 ms"]);
    assert.deepEqual(labels.export_seconds, ["process wall time, spawn to exit"]);
    assert.deepEqual(unmeasured, {});
  });

  it("records unmeasured values with reasons instead of zeros", async () => {
    const study = {
      metrics: [
        { id: "mem", type: "peak-memory" },
        { id: "cpu", type: "cpu-time" },
        { id: "cost", type: "tokens-cost", measure: "cost", costSource: "reported" },
        { id: "future", type: "future-type" },
      ],
    };
    const samples = [
      await sample({
        candidate: "docker",
        metrics: { wallMs: 10 },
        info: { peakMemory: { method: "none", label: "unmeasured in docker" } },
      }),
      await sample({
        candidate: "docker",
        index: 1,
        metrics: { wallMs: 11 },
        info: { peakMemory: { method: "none", label: "unmeasured in docker" } },
      }),
    ];
    const { data, unmeasured } = await extractMetrics({ study, samples, studyDir });
    assert.equal(data.docker, undefined);
    assert.deepEqual(unmeasured.docker.mem, { count: 2, reasons: ["unmeasured in docker"] });
    assert.deepEqual(unmeasured.docker.cpu.reasons, ["this adapter does not measure CPU time"]);
    assert.deepEqual(unmeasured.docker.cost.reasons, [
      'the agent CLI reported no cost (use "costSource": "estimated" with a price table to estimate it)',
    ]);
    assert.deepEqual(unmeasured.docker.future.reasons, [
      "metric type future-type is not available in this kit version",
    ]);
  });

  it("custom metrics read stdout JSON, output JSON, regex, manual numbers and gate values", async () => {
    const study = {
      metrics: [
        { id: "fps", type: "custom", source: "stdout-json", field: "stats.decodeFps" },
        { id: "seek", type: "custom", source: "output-json", field: "seek[1]" },
        { id: "frames", type: "custom", source: "stdout-regex", pattern: "frames: (\\d+)" },
        {
          id: "reported",
          type: "custom",
          source: "metric",
          field: "reported.export_seconds",
          scale: 1000,
        },
        { id: "vmaf", type: "custom", source: "gate", gate: "vmaf" },
      ],
    };
    const s = await sample({
      stdout: 'warming up\nframes: 120\n{"stats":{"decodeFps":"240.5"}}\n',
      output: '{"seek":[3,4.5]}',
      metrics: { "reported.export_seconds": 1.25 },
    });
    const gateChecks = [
      {
        gate: "vmaf",
        type: "quality",
        candidate: "a",
        scope: "sample",
        status: "pass",
        reason: "",
        value: 95.5,
        runId: "r1",
        index: 0,
      },
    ];
    const { data, unmeasured } = await extractMetrics({
      study,
      samples: [s],
      studyDir,
      gateChecks,
    });
    assert.deepEqual(Object.fromEntries(Object.entries(data.a).map(([k, v]) => [k, v.i1])), {
      fps: [240.5],
      seek: [4.5],
      frames: [120],
      reported: [1250],
      vmaf: [95.5],
    });
    assert.deepEqual(unmeasured, {});
  });

  it("explains why a custom number is missing", async () => {
    const study = {
      metrics: [
        { id: "fps", type: "custom", source: "stdout-json", field: "fps" },
        { id: "vmaf", type: "custom", source: "gate", gate: "vmaf" },
      ],
    };
    const { unmeasured } = await extractMetrics({
      study,
      samples: [await sample({ stdout: '{"other": 1}' }), await sample({ index: 1 })],
      studyDir,
    });
    assert.deepEqual(unmeasured.a.fps.reasons, [
      "stdout has no number at fps",
      "this adapter recorded no stdout",
    ]);
    assert.deepEqual(unmeasured.a.vmaf.reasons, ["gate vmaf recorded no value for this sample"]);
  });
});
