// @ts-check
// Function adapter: import one export from a project module and time it in
// process (inside a fresh worker). Every candidate implements the same
// interface, `fn(input, context)`; an optional `setup` export prepares the
// input once, outside the timed loop. The first call's return value is saved
// as the sample's output, so correctness gates check what was timed.
//
//   "adapter": { "type": "function", "module": "src/sorts/radix.mjs", "export": "sort",
//                "setup": "prepare", "inputFormat": "json", "measure": { "minSamples": 20, "minTimeMs": 500 } }
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { measureFunction } from "../measure.mjs";
import { selfPeakMemory } from "../sampler.mjs";
import { prepareSample } from "../sandbox/process.mjs";
import { mean, median } from "../stats.mjs";
import { done, fail, isContainedRelative, isObject, relPosix } from "./common.mjs";

export const INPUT_FORMATS = Object.freeze(["json", "text", "bytes", "path"]);
const MEASURE_KEYS = Object.freeze([
  "warmup",
  "minSamples",
  "minTimeMs",
  "maxSamples",
  "maxTimeMs",
]);
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** @param {any} a @returns {string[]} */
export function validate(a) {
  /** @type {string[]} */
  const e = [];
  if (!isContainedRelative(a.module))
    e.push("module: expected a module path relative to the project (no '..')");
  for (const key of ["export", "setup"])
    if (a[key] !== undefined && !(typeof a[key] === "string" && IDENT.test(a[key])))
      e.push(`${key}: expected an export name`);
  if (a.inputFormat !== undefined && !INPUT_FORMATS.includes(a.inputFormat))
    e.push(`inputFormat: expected one of ${INPUT_FORMATS.join("|")}`);
  if (a.measure !== undefined) {
    if (!isObject(a.measure)) e.push("measure: expected an object");
    else
      for (const [k, v] of Object.entries(a.measure)) {
        if (!MEASURE_KEYS.includes(k))
          e.push(`measure.${k}: unknown (allowed: ${MEASURE_KEYS.join(", ")})`);
        else if (!(Number.isInteger(v) && v >= 0))
          e.push(`measure.${k}: expected an integer of at least 0`);
      }
  }
  return e;
}

/** @param {string | undefined} file @param {string | undefined} format */
async function loadInput(file, format) {
  if (file === undefined) return undefined;
  const fmt = format ?? (path.extname(file).toLowerCase() === ".json" ? "json" : "path");
  if (fmt === "path") return file;
  const bytes = await readFile(file);
  if (fmt === "bytes") return bytes;
  const text = bytes.toString("utf8");
  return fmt === "json" ? JSON.parse(text) : text;
}

/** Save the output so gates and raters can inspect it. @param {string} outDir @param {unknown} value */
async function saveOutput(outDir, value) {
  if (value === undefined) return undefined;
  if (value instanceof Uint8Array) {
    const file = path.join(outDir, "output.bin");
    await writeFile(file, value);
    return { file, bytes: value.byteLength };
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return undefined;
  const file = path.join(outDir, typeof value === "string" ? "output.txt" : "output.json");
  await writeFile(file, text);
  return { file, bytes: Buffer.byteLength(text) };
}

/**
 * @param {import("./common.mjs").AdapterJob} job
 * @returns {Promise<import("./common.mjs").SampleResult>}
 */
export async function runSample(job) {
  const a = job.adapter;
  let mod;
  try {
    mod = await import(pathToFileURL(path.resolve(job.projectDir, a.module)).href);
  } catch (error) {
    return fail(
      "MODULE_LOAD",
      `cannot import ${a.module}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const name = a.export ?? "default";
  const fn = mod[name];
  if (typeof fn !== "function")
    return fail("FUNCTION_MISSING", `${a.module} has no function export "${name}"`);
  if (a.setup !== undefined && typeof mod[a.setup] !== "function")
    return fail("FUNCTION_MISSING", `${a.module} has no setup export "${a.setup}"`);

  const sample = await prepareSample({ sampleDir: job.sampleDir, item: job.item });
  let input;
  try {
    input = await loadInput(sample.inputPath, a.inputFormat);
  } catch (error) {
    return fail(
      "INPUT_INVALID",
      `cannot read input for ${job.item.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const context = Object.freeze({
    item: job.item.id,
    outDir: sample.outDir,
    candidate: job.candidate.id,
  });
  const arg = a.setup === undefined ? input : await mod[a.setup](input, context);

  const output = await fn(arg, context);
  const saved = await saveOutput(sample.outDir, output);
  /** @type {unknown} */
  let sink;
  const m = await measureFunction(
    async () => {
      sink = await fn(arg, context);
    },
    { ...(a.measure ?? {}) },
  );
  void sink;
  const iterations = m.samplesMs.length;
  const memory = selfPeakMemory();
  return done(
    {
      wallMs: median(m.samplesMs),
      wallMsMean: mean(m.samplesMs),
      cpuMs: iterations ? m.cpuMs / iterations : undefined,
      iterations,
      heapDeltaBytes: m.heapDeltaBytes,
      peakMemoryBytes: memory.peakBytes,
      outputBytes: saved?.bytes,
    },
    {
      timing: "per call, median of the in-process loop",
      stoppedBy: m.stoppedBy,
      gcForced: m.gcForced,
      peakMemory: { method: memory.method, label: memory.label },
      sampleDir: relPosix(job.studyDir, job.sampleDir),
      ...(saved ? { outPath: relPosix(job.studyDir, saved.file) } : {}),
    },
  );
}
