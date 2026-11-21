// @ts-check
// Gate registry and engine. Gates are pass/fail conditions applied to the
// recorded samples before any number is compared: a candidate that fails one
// is GATED-OUT; a gate that could not be checked makes it INCONCLUSIVE.
// Every check is recorded, in a stable order, with its reason. A gate with
// "severity": "record" is checked and recorded (its value can feed a metric)
// but never rules a candidate out: e.g. whether an agent resolved a task is
// the outcome being measured, not a disqualification.
import path from "node:path";

import { baseCandidateId } from "../runner.mjs";
import { gatesFor } from "../study.mjs";
import * as command from "./command.mjs";
import { errored, scopeOf } from "./common.mjs";
import * as equals from "./equals.mjs";
import * as exitCode from "./exit-code.mjs";
import * as honesty from "./honesty.mjs";
import * as quality from "./quality.mjs";
import * as schema from "./schema.mjs";
import * as scope from "./scope.mjs";
import * as sideEffects from "./side-effects.mjs";
import * as tests from "./tests.mjs";
import * as tolerance from "./tolerance.mjs";

/**
 * @typedef {{ validate: (g: any) => string[], check: (ctx: import("./common.mjs").GateContext) => Promise<import("./common.mjs").GateResult> }} GateModule
 * @typedef {{ gate: string, type: string, candidate: string, scope: "sample" | "candidate", status: "pass" | "fail" | "errored", reason: string, value?: number, item?: string, repeat?: number, runId?: string, index?: number, severity?: "record" }} GateCheck
 * @typedef {{ gate: string, item?: string, reason: string }} GateNote
 * @typedef {import("../compare.mjs").GateSummary & { checked: number, notRun?: GateNote[], recorded?: (GateNote & { status: string })[] }} CandidateGates
 */

/** @type {Readonly<Record<string, GateModule>>} */
export const GATES = Object.freeze({
  "exit-code": exitCode,
  equals,
  tolerance,
  schema,
  command,
  quality,
  tests,
  scope,
  "side-effects": sideEffects,
  honesty,
});

/** Validators for validateStudy's `registries.gates`. @param {Record<string, GateModule>} [extra] */
export function gateValidators(extra = {}) {
  return Object.fromEntries(
    Object.entries({ ...GATES, ...extra }).map(([type, m]) => [
      type,
      { validate: (/** @type {any} */ g) => [...sharedErrors(g), ...m.validate(g)] },
    ]),
  );
}

/** Checks for options every gate type shares. @param {any} g */
function sharedErrors(g) {
  if (g.samples === undefined) return [];
  if (g.samples !== "all" && g.samples !== "first") return ["samples: expected all or first"];
  return scopeOf(g) === "sample" ? [] : ['samples: only applies to "scope": "sample" gates'];
}

/** @param {any} a @param {any} b */
const bySampleOrder = (a, b) =>
  String(a.runId ?? "").localeCompare(String(b.runId ?? "")) || (a.index ?? 0) - (b.index ?? 0);

/**
 * Samples a sample-scope gate looks at: every completed measured sample, or
 * with `"samples": "first"` only the first one per item (for expensive
 * checks such as VMAF; the report says so).
 * @param {any} gate
 * @param {any[]} samples
 */
function samplesFor(gate, samples) {
  if (gate.samples !== "first") return samples;
  /** @type {Map<string, any>} */
  const first = new Map();
  for (const s of samples) if (!first.has(s.item)) first.set(s.item, s);
  return [...first.values()];
}

/**
 * Run every applicable gate for every candidate.
 * @param {{
 *   study: any,
 *   samples: any[],
 *   studyDir: string,
 *   projectDir: string,
 *   workDir: string,
 *   registry?: Record<string, GateModule>,
 *   env?: NodeJS.ProcessEnv,
 *   signal?: AbortSignal,
 *   onCheck?: (check: GateCheck) => void,
 * }} options
 * @returns {Promise<{ summaries: Record<string, CandidateGates>, checks: GateCheck[] }>}
 */
export async function evaluateGates(options) {
  const {
    study,
    samples,
    studyDir,
    projectDir,
    workDir,
    registry = GATES,
    env,
    signal,
    onCheck,
  } = options;
  const workloadDir = path.join(studyDir, study.workload?.dir ?? "workload");
  const items = new Map((study.workload?.items ?? []).map((/** @type {any} */ i) => [i.id, i]));
  const ids = [
    ...new Set([
      ...study.candidates.map((/** @type {any} */ c) => c.id),
      ...samples.map((s) => s.candidate),
    ]),
  ].sort();

  /** @type {GateCheck[]} */
  const checks = [];
  /** @type {Record<string, CandidateGates>} */
  const summaries = {};

  for (const id of ids) {
    const mine = samples
      .filter((s) => s.candidate === id && s.phase === "measure" && s.status === "ok")
      .sort(bySampleOrder);
    const gates = gatesFor(study, baseCandidateId(id));
    /** @type {CandidateGates} */
    const summary = { status: "pass", checked: 0 };
    /** @type {GateNote[]} */
    const failures = [];
    /** @type {GateNote[]} */
    const erroredNotes = [];
    /** @type {GateNote[]} */
    const notRun = [];
    /** @type {(GateNote & { status: string })[]} */
    const recorded = [];
    /** @type {GateCheck[]} */
    const mineChecks = [];

    for (const gate of gates) {
      const module = registry[gate.type];
      const scope = scopeOf(gate);
      const recordOnly = gate.severity === "record";
      /** @param {import("./common.mjs").GateResult} r @param {any} [sample] */
      const record = (r, sample) => {
        /** @type {GateCheck} */
        const c = {
          gate: gate.id,
          type: gate.type,
          candidate: id,
          scope,
          status: r.status,
          reason: r.reason,
          ...(r.value !== undefined ? { value: r.value } : {}),
          ...(recordOnly ? { severity: /** @type {const} */ ("record") } : {}),
          ...(sample
            ? { item: sample.item, repeat: sample.repeat, runId: sample.runId, index: sample.index }
            : {}),
        };
        checks.push(c);
        mineChecks.push(c);
        onCheck?.(c);
        summary.checked++;
        const note = {
          gate: gate.id,
          ...(sample ? { item: String(sample.item) } : {}),
          reason: r.reason,
        };
        if (recordOnly) {
          if (r.status !== "pass") recorded.push({ ...note, status: r.status });
          return;
        }
        if (r.status === "fail") failures.push(note);
        if (r.status === "errored") erroredNotes.push(note);
      };
      /** @param {any} [sample] @returns {Promise<import("./common.mjs").GateResult>} */
      const run = async (sample) => {
        if (!module) return errored(`gate type ${gate.type} is not available in this kit version`);
        if (signal?.aborted) return errored("gate check was stopped");
        try {
          return await module.check({
            gate,
            candidate: baseCandidateId(id),
            sample,
            item: sample ? items.get(sample.item) : undefined,
            studyDir,
            projectDir,
            workloadDir,
            workDir,
            env,
            signal,
            earlier: [...mineChecks],
          });
        } catch (error) {
          return errored(`gate crashed: ${error instanceof Error ? error.message : String(error)}`);
        }
      };

      if (scope === "candidate") {
        record(await run());
        continue;
      }
      const targets = samplesFor(gate, mine);
      if (targets.length === 0) {
        notRun.push({ gate: gate.id, reason: "no completed samples to check" });
        continue;
      }
      for (const sample of targets) record(await run(sample), sample);
    }

    if (failures.length) {
      summary.status = "fail";
      summary.failures = failures;
    }
    if (erroredNotes.length) {
      if (!failures.length) summary.status = "errored";
      summary.errored = erroredNotes;
    }
    if (recorded.length) summary.recorded = recorded;
    if (notRun.length) {
      summary.notRun = notRun;
      if (summary.status === "pass" && summary.checked === 0) summary.status = "not-run";
    }
    summaries[id] = summary;
  }
  return { summaries, checks };
}
