// @ts-check
// Runner: repeats × workload items × rotated candidates, one sample per slot,
// each in a fresh worker. Every slot is recorded to samples.jsonl as it
// finishes (errored ones also to errors.jsonl), so a crash leaves an honest
// partial record. Nothing is ever retried: an errored sample stays errored
// and counts against the candidate's error rate. Selective reruns would bias
// the result toward whoever got the second chance.
//
//   runs/<runId>/run.json          plan + status (written first, updated last)
//   runs/<runId>/environment.json  machine, provenance and tool versions
//   runs/<runId>/samples.jsonl     one line per slot (warm-up included, marked)
//   runs/<runId>/errors.jsonl      errored slots only
import { fork } from "node:child_process";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { assertPoolable } from "./protocol.mjs";
import { err, ok } from "./result.mjs";
import { killTree } from "./sandbox/process.mjs";
import { buildSchedule } from "./schedule.mjs";

export { killTree };

/** Folder of one run. @param {string} studyDir @param {string} runId */
export const runDirFor = (studyDir, runId) => path.join(studyDir, "runs", runId);

export const RUN_KINDS = Object.freeze(["full", "pilot", "aa"]);
const WORKER = fileURLToPath(new URL("./worker.mjs", import.meta.url));
const RUN_ID = /^[A-Za-z0-9_.-]{1,80}$/;
const AA_SUFFIX = "~aa";

/**
 * @typedef {import("./schedule.mjs").Slot} Slot
 * @typedef {{ status: "ok", metrics: Record<string, number>, info?: Record<string, unknown>, gates?: Record<string, unknown> }
 *   | { status: "errored", error: { code: string, message: string } }} Outcome
 * @typedef {(slot: Slot, context: { timeoutMs: number, signal?: AbortSignal }) => Promise<Outcome>} Execute
 * @typedef {{ planned: number, completed: number, errored: number, notRun: number }} Counts
 * @typedef {{
 *   runId: string, kind: string, protocolVersion: number, protocolDigest: string, status: "running" | "complete" | "aborted",
 *   planned: Record<string, number>, counts?: Record<string, Counts>, startedAt: string, finishedAt?: string,
 * }} RunRecord
 */

/** @param {string} file @param {unknown} value */
async function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
  try {
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/**
 * Same-vs-same variant of a study: the reference runs against a copy of
 * itself. Any "difference" it finds is noise, which sets the noise floor.
 * @param {any} study
 */
export function aaStudy(study) {
  const ref = study.candidates.find((/** @type {any} */ c) => c.id === study.decision.reference);
  return {
    ...study,
    candidates: [
      ref,
      { ...ref, id: `${ref.id}${AA_SUFFIX}`, label: `${ref.label ?? ref.id} (again)` },
    ],
    gates: (study.gates ?? []).map((/** @type {any} */ g) =>
      g.appliesTo?.includes(ref.id)
        ? { ...g, appliesTo: [...g.appliesTo, `${ref.id}${AA_SUFFIX}`] }
        : g,
    ),
  };
}

/** The real candidate behind an A/A copy id. @param {string} id */
export const baseCandidateId = (id) =>
  id.endsWith(AA_SUFFIX) ? id.slice(0, -AA_SUFFIX.length) : id;

/**
 * Execute the full schedule for one run.
 * @param {{
 *   study: any, studyDir: string, runId: string, kind?: string,
 *   protocol: { version: number, digest: string },
 *   execute: Execute, environment?: unknown,
 *   repeats?: number, clock?: () => number, now?: () => string, signal?: AbortSignal,
 *   onSample?: (record: Record<string, unknown>) => void,
 * }} options
 * @returns {Promise<import("./result.mjs").Result<RunRecord>>}
 */
export async function runStudy(options) {
  const {
    study,
    studyDir,
    runId,
    kind = "full",
    protocol,
    execute,
    environment = {},
    clock = () => performance.now(),
    now = () => new Date().toISOString(),
    signal,
    onSample,
  } = options;
  if (!RUN_ID.test(runId))
    return err("RUN_ID", `run id must be letters, digits, '.', '_' or '-': ${runId}`);
  if (!RUN_KINDS.includes(kind))
    return err("RUN_KIND", `run kind must be one of ${RUN_KINDS.join("|")}`);
  const runDir = runDirFor(studyDir, runId);
  if (
    await stat(runDir).then(
      () => true,
      () => false,
    )
  )
    return err(
      "RUN_EXISTS",
      `run ${runId} already exists; runs are never overwritten or topped up`,
    );
  await mkdir(runDir, { recursive: true });

  const candidates = study.candidates.map((/** @type {any} */ c) => c.id);
  const slots = buildSchedule({
    candidates,
    items: study.workload.items.map((/** @type {any} */ i) => i.id),
    repeats: options.repeats ?? study.repeats,
    warmupRepeats: study.warmupRepeats ?? 0,
    seed: study.seed,
  });
  /** @type {Record<string, Counts>} */
  const counts = {};
  for (const id of candidates) counts[id] = { planned: 0, completed: 0, errored: 0, notRun: 0 };
  for (const s of slots)
    if (s.phase === "measure") /** @type {Counts} */ (counts[s.candidate]).planned++;

  /** @type {RunRecord} */
  const record = {
    runId,
    kind,
    protocolVersion: protocol.version,
    protocolDigest: protocol.digest,
    status: "running",
    planned: Object.fromEntries(
      candidates.map((/** @type {string} */ id) => [
        id,
        /** @type {Counts} */ (counts[id]).planned,
      ]),
    ),
    startedAt: now(),
  };
  await writeJsonAtomic(path.join(runDir, "run.json"), record);
  await writeJsonAtomic(path.join(runDir, "environment.json"), environment);
  const samplesFile = path.join(runDir, "samples.jsonl");
  const errorsFile = path.join(runDir, "errors.jsonl");
  await writeFile(samplesFile, "");
  await writeFile(errorsFile, "");
  const timeoutMs = study.timeoutMs ?? 600_000;

  let aborted = false;
  for (const slot of slots) {
    if (signal?.aborted) {
      aborted = true;
      break;
    }
    const startedAt = now();
    const t0 = clock();
    /** @type {Outcome} */
    let outcome;
    try {
      outcome = await execute(slot, { timeoutMs, signal });
    } catch (error) {
      // An executor bug still must not silently drop the sample.
      outcome = {
        status: "errored",
        error: {
          code: "EXECUTOR_THREW",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    const durationMs = clock() - t0;
    const line = {
      runId,
      protocolVersion: protocol.version,
      protocolDigest: protocol.digest,
      ...slot,
      status: outcome.status,
      ...(outcome.status === "ok"
        ? {
            metrics: outcome.metrics,
            ...(outcome.info ? { info: outcome.info } : {}),
            ...(outcome.gates ? { gates: outcome.gates } : {}),
          }
        : { error: outcome.error }),
      startedAt,
      durationMs,
    };
    await appendFile(samplesFile, `${JSON.stringify(line)}\n`);
    if (outcome.status === "errored") await appendFile(errorsFile, `${JSON.stringify(line)}\n`);
    if (slot.phase === "measure") {
      const c = /** @type {Counts} */ (counts[slot.candidate]);
      if (outcome.status === "ok") c.completed++;
      else c.errored++;
    }
    onSample?.(line);
  }
  for (const c of Object.values(counts)) c.notRun = c.planned - c.completed - c.errored;
  /** @type {RunRecord} */
  const done = { ...record, status: aborted ? "aborted" : "complete", counts, finishedAt: now() };
  await writeJsonAtomic(path.join(runDir, "run.json"), done);
  return ok(done);
}

/**
 * Read one or more runs of the same protocol version into the shape the
 * decision rule expects: data[candidate][metric][item] = values. Warm-up
 * slots are dropped; pilot runs are excluded unless asked for (pilots size
 * the study, they are not evidence). Refuses to mix protocol versions,
 * duplicated runs, or a run whose plan was not balanced across candidates.
 * @param {string[]} runDirs
 * @param {{ includePilot?: boolean }} [options]
 */
export async function collectRuns(runDirs, { includePilot = false } = {}) {
  /** @type {RunRecord[]} */
  const runs = [];
  /** @type {any[]} */
  const samples = [];
  for (const dir of runDirs) {
    let run;
    try {
      run = /** @type {RunRecord} */ (
        JSON.parse(await readFile(path.join(dir, "run.json"), "utf8"))
      );
    } catch (error) {
      return err(
        "RUN_UNREADABLE",
        `cannot read ${path.join(dir, "run.json")}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (run.kind === "pilot" && !includePilot) continue;
    if (runs.some((r) => r.runId === run.runId))
      return err("RUN_DUPLICATE", `run ${run.runId} was given twice`);
    const planned = new Set(Object.values(run.planned ?? {}));
    if (planned.size !== 1)
      return err(
        "RUN_UNBALANCED",
        `run ${run.runId} did not plan the same number of samples for every candidate (selective reruns are not allowed)`,
      );
    runs.push(run);
    let text = "";
    try {
      text = await readFile(path.join(dir, "samples.jsonl"), "utf8");
    } catch {
      text = "";
    }
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      try {
        samples.push(JSON.parse(raw));
      } catch {
        return err("RUN_CORRUPT", `unreadable line in ${path.join(dir, "samples.jsonl")}`);
      }
    }
  }
  if (runs.length === 0)
    return err("POOL_EMPTY", includePilot ? "no runs found" : "no non-pilot runs found");
  const pool = assertPoolable(runs);
  if (!pool.ok) return pool;

  /** @type {Record<string, Record<string, Record<string, number[]>>>} */
  const data = {};
  /** @type {Record<string, Counts>} */
  const counts = {};
  for (const run of runs) {
    for (const [id, planned] of Object.entries(run.planned)) {
      const c = (counts[id] ??= { planned: 0, completed: 0, errored: 0, notRun: 0 });
      c.planned += planned;
    }
  }
  for (const s of samples) {
    if (s.phase !== "measure") continue;
    const c = (counts[s.candidate] ??= { planned: 0, completed: 0, errored: 0, notRun: 0 });
    if (s.status !== "ok") {
      c.errored++;
      continue;
    }
    c.completed++;
    const byMetric = (data[s.candidate] ??= {});
    for (const [metric, value] of Object.entries(s.metrics ?? {}))
      ((byMetric[metric] ??= {})[s.item] ??= []).push(value);
  }
  for (const c of Object.values(counts))
    c.notRun = Math.max(0, c.planned - c.completed - c.errored);
  const incomplete = runs
    .filter((r) => r.status !== "complete")
    .map((r) => `${r.runId} (${r.status})`);
  return ok({
    ...pool.value,
    data,
    counts,
    samples: samples.filter((s) => s.phase === "measure"),
    incomplete: incomplete.length ? `runs not finished: ${incomplete.join(", ")}` : undefined,
  });
}

/**
 * Default executor: one fresh worker process per sample.
 * @param {{
 *   jobFor: (slot: Slot) => { adapterModule: string, [key: string]: unknown },
 *   exposeGc?: boolean, env?: NodeJS.ProcessEnv, cwd?: string, graceMs?: number,
 * }} options
 * @returns {Execute}
 */
export function forkExecutor({ jobFor, exposeGc = true, env = process.env, cwd, graceMs = 5_000 }) {
  return (slot, { timeoutMs, signal }) =>
    new Promise((resolve) => {
      const job = { ...jobFor(slot), timeoutMs, slot };
      // fork forwards windowsHide to spawn; Node's ForkOptions type just omits it.
      /** @type {import("node:child_process").ForkOptions & { windowsHide?: boolean }} */
      const forkOptions = {
        cwd,
        env: { ...env, BENCH_KIT_WORKER: "1" },
        execArgv: exposeGc ? ["--expose-gc"] : [],
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        detached: process.platform !== "win32",
        windowsHide: true,
      };
      const child = fork(WORKER, [], forkOptions);
      let stderrTail = "";
      child.stdout?.resume();
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk) => {
        stderrTail = (stderrTail + chunk).slice(-2_000);
      });
      /** @type {Outcome | undefined} */
      let outcome;
      let settled = false;
      /** @param {Outcome} o */
      const finish = (o) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(o);
      };
      const timer = setTimeout(() => {
        killTree(child);
        finish({
          status: "errored",
          error: { code: "TIMEOUT", message: `sample exceeded ${timeoutMs} ms` },
        });
      }, timeoutMs + graceMs);
      const onAbort = () => {
        killTree(child);
        finish({ status: "errored", error: { code: "ABORTED", message: "run was stopped" } });
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      child.on("message", (/** @type {any} */ msg) => {
        if (msg?.type !== "result") return;
        const r = msg.result;
        outcome = r?.ok
          ? {
              status: "ok",
              metrics: r.metrics ?? {},
              ...(r.info ? { info: r.info } : {}),
              ...(r.gates ? { gates: r.gates } : {}),
            }
          : {
              status: "errored",
              error: {
                code: String(r?.error?.code ?? "SAMPLE_FAILED"),
                message: String(r?.error?.message ?? "sample failed"),
              },
            };
      });
      child.on("error", (error) =>
        finish({ status: "errored", error: { code: "WORKER_SPAWN", message: error.message } }),
      );
      child.on("exit", (code, sig) => {
        if (outcome) return finish(outcome);
        finish({
          status: "errored",
          error: {
            code: "WORKER_CRASH",
            message: `worker exited (${sig ?? code}) without a result${stderrTail ? `: ${stderrTail.trim().split("\n").slice(-3).join(" | ")}` : ""}`,
          },
        });
      });
      child.send({ type: "job", job });
    });
}
