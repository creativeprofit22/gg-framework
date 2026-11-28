// @ts-check
// Adapter registry. Each adapter module exports `validate(config)` (used when
// study.json is checked) and `runSample(job)` (run inside a fresh worker).
// This file turns a schedule slot into the job a worker runs.
import path from "node:path";
import { fileURLToPath } from "node:url";

import { forkExecutor, runDirFor } from "../runner.mjs";
import * as agent from "./agent.mjs";
import * as cli from "./cli.mjs";
import * as fn from "./function.mjs";
import * as http from "./http.mjs";
import * as manual from "./manual.mjs";

/** @param {string} file */
const here = (file) => fileURLToPath(new URL(file, import.meta.url));

/** @type {Readonly<Record<string, { validate: (config: any) => string[], module: string }>>} */
export const ADAPTERS = Object.freeze({
  function: { validate: fn.validate, module: here("./function.mjs") },
  cli: { validate: cli.validate, module: here("./cli.mjs") },
  http: { validate: http.validate, module: here("./http.mjs") },
  manual: { validate: manual.validate, module: here("./manual.mjs") },
  agent: { validate: agent.validate, module: here("./agent.mjs") },
});

/** Validators in the shape study.validateStudy expects. */
export function adapterValidators() {
  /** @type {Record<string, { validate: (config: any) => string[] }>} */
  const out = {};
  for (const [type, entry] of Object.entries(ADAPTERS)) out[type] = { validate: entry.validate };
  return out;
}

/** @param {string} value */
const safeName = (value) => value.replace(/[^A-Za-z0-9_.-]/g, "_");

/**
 * Build the worker job for one slot.
 * @param {{
 *   study: any, slot: import("../schedule.mjs").Slot, studyDir: string, projectDir: string, runId: string,
 *   config?: { services?: Record<string, string>, prices?: Record<string, any> }, docker?: { available: boolean, reason?: string }, timeoutMs?: number,
 * }} options
 * @returns {import("./common.mjs").AdapterJob}
 */
export function buildJob({
  study,
  slot,
  studyDir,
  projectDir,
  runId,
  config = {},
  docker,
  timeoutMs,
}) {
  const candidate = study.candidates.find((/** @type {any} */ c) => c.id === slot.candidate);
  if (!candidate) throw new Error(`slot names unknown candidate ${slot.candidate}`);
  const entry = ADAPTERS[candidate.adapter.type];
  if (!entry) throw new Error(`no adapter registered for type ${candidate.adapter.type}`);
  const item = study.workload.items.find((/** @type {any} */ i) => i.id === slot.item);
  if (!item) throw new Error(`slot names unknown workload item ${slot.item}`);
  const workloadDir = path.join(studyDir, study.workload.dir ?? "workload");
  const sandboxType = study.sandbox?.type ?? "process";
  return {
    adapterModule: entry.module,
    adapter: candidate.adapter,
    candidate: { id: candidate.id, ...(candidate.label ? { label: candidate.label } : {}) },
    item: {
      id: item.id,
      ...(item.input ? { input: path.join(workloadDir, item.input) } : {}),
      ...(item.expectedFile ? { expected: path.join(workloadDir, item.expectedFile) } : {}),
    },
    phase: slot.phase,
    repeat: slot.repeat,
    projectDir,
    studyDir,
    workloadDir,
    sampleDir: path.join(
      runDirFor(studyDir, runId),
      "samples",
      `${String(slot.index).padStart(5, "0")}-${safeName(slot.candidate)}-${safeName(slot.item)}`,
    ),
    sandbox: {
      ...(study.sandbox ?? {}),
      type: sandboxType,
      ...(sandboxType === "docker"
        ? {
            available: docker?.available === true,
            ...(docker?.reason ? { reason: docker.reason } : {}),
          }
        : {}),
    },
    config: { services: config.services ?? {}, prices: config.prices ?? {} },
    timeoutMs: timeoutMs ?? study.timeoutMs ?? 600_000,
  };
}

/**
 * Executor that runs every slot through its adapter in a fresh worker.
 * @param {Omit<Parameters<typeof buildJob>[0], "slot"> & { env?: NodeJS.ProcessEnv, exposeGc?: boolean }} options
 */
export function adapterExecutor(options) {
  const { env, exposeGc, ...jobOptions } = options;
  return forkExecutor({
    jobFor: (slot) => buildJob({ ...jobOptions, slot }),
    env,
    exposeGc,
    cwd: options.projectDir,
  });
}
