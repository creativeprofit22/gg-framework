// @ts-check
// Shared gate helpers: the check context, result shapes, config checks and
// running a gate's own command (no shell, scrubbed env, timeout).
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { fillSlots, slotsIn, splitCommand } from "../argv.mjs";
import { resolveInside } from "../sample-io.mjs";
import { runProcess, scrubEnv } from "../sandbox/process.mjs";

export const DEFAULT_GATE_TIMEOUT_MS = 120_000;
/** Slots available to every gate command. */
export const CANDIDATE_SLOTS = Object.freeze([
  "candidate",
  "project",
  "study",
  "workload",
  "report",
]);
/** Extra slots available when the gate checks one sample. */
export const SAMPLE_SLOTS = Object.freeze([
  ...CANDIDATE_SLOTS,
  "out",
  "outDir",
  "input",
  "expected",
  "item",
  "repeat",
  "sampleDir",
  "stdout",
]);

/**
 * @typedef {"pass" | "fail" | "errored"} GateStatus
 * @typedef {{ status: GateStatus, reason: string, value?: number }} GateResult
 * @typedef {{
 *   gate: any,
 *   candidate: string,
 *   sample?: any,
 *   item?: { id: string, input?: string, expectedFile?: string },
 *   studyDir: string,
 *   projectDir: string,
 *   workloadDir: string,
 *   workDir: string,
 *   env?: NodeJS.ProcessEnv,
 *   signal?: AbortSignal,
 *   earlier?: import("./index.mjs").GateCheck[],
 * }} GateContext
 */

/** @param {string} reason @returns {GateResult} */
export const pass = (reason) => ({ status: "pass", reason });
/** @param {string} reason @returns {GateResult} */
export const failed = (reason) => ({ status: "fail", reason });
/** @param {string} reason @returns {GateResult} */
export const errored = (reason) => ({ status: "errored", reason });
/** @param {GateResult} r @param {number | undefined} value @returns {GateResult} */
export const withValue = (r, value) => (value === undefined ? r : { ...r, value });

/** @param {unknown} v @returns {v is Record<string, any>} */
export const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** @param {unknown} v */
export const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * Reject config keys the gate does not know (typos silently weaken a gate).
 * @param {Record<string, any>} g
 * @param {readonly string[]} own
 */
export function unknownKeys(g, own) {
  const shared = [
    "id",
    "type",
    "scope",
    "severity",
    "appliesTo",
    "label",
    "description",
    "samples",
  ];
  return Object.keys(g)
    .filter((k) => !shared.includes(k) && !own.includes(k))
    .sort()
    .map((k) => `${k}: unknown option for a ${g.type} gate`);
}

/** Scope of a gate (sample unless declared). @param {any} g @returns {"sample" | "candidate"} */
export const scopeOf = (g) => (g.scope === "candidate" ? "candidate" : "sample");

/**
 * Check a gate command template against the slots its scope offers.
 * @param {any} g
 * @param {string} field
 */
export function validateGateCommand(g, field = "command") {
  const argv = splitCommand(g[field]);
  if (!argv.ok) return [`${field}: ${argv.error.message}`];
  const allowed = scopeOf(g) === "candidate" ? CANDIDATE_SLOTS : SAMPLE_SLOTS;
  const unknown = slotsIn(argv.value).filter((s) => !allowed.includes(s));
  if (!unknown.length) return [];
  const sampleOnly = unknown.filter((s) => SAMPLE_SLOTS.includes(s));
  return [
    sampleOnly.length === unknown.length
      ? `${field}: slot(s) ${unknown.map((s) => `{${s}}`).join(", ")} need "scope": "sample" (a candidate-scope gate has no single sample output)`
      : `${field}: unknown slot(s) ${unknown.map((s) => `{${s}}`).join(", ")} (allowed: ${allowed.map((s) => `{${s}}`).join(", ")})`,
  ];
}

/** @param {unknown} v @param {string} field */
export function validateTimeout(v, field = "timeoutMs") {
  return v === undefined || (Number.isInteger(v) && /** @type {number} */ (v) > 0)
    ? []
    : [`${field}: expected a positive integer`];
}

/** @param {string} s */
const safe = (s) => s.replace(/[^A-Za-z0-9_.-]/g, "_");

/**
 * Slot values for a gate command run.
 * @param {GateContext} ctx
 * @returns {Record<string, string | undefined>}
 */
export function gateSlots(ctx) {
  const tag = ctx.sample
    ? `${String(ctx.sample.index ?? 0).padStart(5, "0")}-${safe(ctx.candidate)}-${safe(String(ctx.sample.item))}`
    : safe(ctx.candidate);
  /** @type {Record<string, string | undefined>} */
  const values = {
    candidate: ctx.candidate,
    project: ctx.projectDir,
    study: ctx.studyDir,
    workload: ctx.workloadDir,
    report: path.join(ctx.workDir, `${safe(ctx.gate.id)}-${tag}.report`),
  };
  if (!ctx.sample) return values;
  const info = ctx.sample.info ?? {};
  const resolved = (/** @type {unknown} */ p) => {
    const r = resolveInside(ctx.studyDir, p);
    return r.ok ? r.value : undefined;
  };
  return {
    ...values,
    out: resolved(info.outPath),
    outDir:
      resolved(info.outDir) ??
      (resolved(info.outPath)
        ? path.dirname(/** @type {string} */ (resolved(info.outPath)))
        : undefined),
    sampleDir: resolved(info.sampleDir),
    stdout: resolved(info.stdoutPath),
    input: ctx.item?.input ? path.join(ctx.workloadDir, ctx.item.input) : undefined,
    expected: ctx.item?.expectedFile
      ? path.join(ctx.workloadDir, ctx.item.expectedFile)
      : undefined,
    item: String(ctx.sample.item),
    repeat: String(ctx.sample.repeat ?? 0),
  };
}

/**
 * Run a gate's command and return its exit code, output and report path.
 * @param {GateContext} ctx
 * @param {string} field
 */
export async function runGateCommand(ctx, field = "command") {
  const argv = splitCommand(ctx.gate[field]);
  if (!argv.ok) return { problem: errored(`${field}: ${argv.error.message}`) };
  const slots = gateSlots(ctx);
  const filled = fillSlots(argv.value, slots);
  if (!filled.ok) return { problem: errored(`${field}: ${filled.error.message}`) };
  await mkdir(ctx.workDir, { recursive: true });
  const timeoutMs = ctx.gate.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  const r = await runProcess(filled.value, {
    cwd: ctx.projectDir,
    env: scrubEnv(ctx.env ?? process.env, { pass: ctx.gate.passEnv ?? [], tmpDir: ctx.workDir }),
    timeoutMs,
    signal: ctx.signal,
  });
  if (r.spawnError) return { problem: errored(r.spawnError.message) };
  if (r.timedOut) return { problem: errored(`gate command ran past ${timeoutMs} ms`) };
  if (r.aborted) return { problem: errored("gate check was stopped") };
  return { result: r, report: /** @type {string} */ (slots.report) };
}

/** Last few stderr lines, for reasons. @param {string} tail */
export const lastLines = (tail) => tail.trim().split(/\r?\n/).slice(-3).join(" | ");
