// @ts-check
// Pipeline: the operations behind each CLI subcommand. The CLI only parses
// arguments and prints JSON; everything that counts, compares or writes a
// file lives here so it can be tested without spawning the CLI.
//
// Order of a study:  validate → freeze → (aa) → (pilot) → run → report
// Every run re-checks provenance and the frozen protocol first, so a study
// that changed after freezing can never be measured or reported under the
// old version.
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { adapterExecutor, adapterValidators, ADAPTERS } from "./adapters/index.mjs";
import { BUDGET_FILE, checkApproval, createBroker, planSpend } from "./budget.mjs";
import { decide, noiseFromAA } from "./compare.mjs";
import { validatePrices } from "./cost.mjs";
import {
  addTerm,
  candidateName,
  describeRange,
  explainMetric,
  explainRule,
  explainTerm,
  KIT_GLOSSARY,
  mergeGlossaries,
  metricInfo,
  readGlossary,
  writeGlossary,
} from "./explain.mjs";
import { jsonText, readJson, readOptional, writeAtomic } from "./files.mjs";
import { evaluateGates, gateValidators, GATES } from "./gates/index.mjs";
import { buildVerdict, updateLedger, VERDICT_FILE, writeVerdict } from "./ledger.mjs";
import { extractMetrics, metricValidators } from "./metrics/index.mjs";
import {
  captureEnvironment,
  currentVersion,
  freezeProtocol,
  readProtocol,
  verifyProtocol,
} from "./protocol.mjs";
import { collectProvenance } from "./provenance.mjs";
import { createRatingPack, importScores, RATING_SCHEMA } from "./rating.mjs";
import { buildReport, REPORT_FILE, writeReport } from "./report.mjs";
import { err, ok } from "./result.mjs";
import { seedFrom } from "./rng.mjs";
import { aaStudy, baseCandidateId, collectRuns, runDirFor, runStudy } from "./runner.mjs";
import { detectDocker } from "./sandbox/docker.mjs";
import { DEFAULTS, pairedBootstrap } from "./stats.mjs";
import { loadStudy } from "./study.mjs";
import { loadTask } from "./task.mjs";

/** Folder of the kit this module belongs to (bench/kit in a project). */
export const KIT_DIR = fileURLToPath(new URL("..", import.meta.url));
const STUDY_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const RUN_ID = /^[A-Za-z0-9_.-]{1,80}$/;

/**
 * @typedef {{
 *   projectDir: string,
 *   kitDir?: string,
 *   now?: () => string,
 *   env?: NodeJS.ProcessEnv,
 *   exec?: import("./provenance.mjs").Exec,
 *   signal?: AbortSignal,
 *   onProgress?: (event: Record<string, unknown>) => void,
 * }} Context
 * @typedef {import("./runner.mjs").RunRecord} RunRecord
 */

/** Where things live inside a project. @param {string} projectDir */
export function projectPaths(projectDir) {
  const bench = path.join(projectDir, "bench");
  return {
    projectDir,
    bench,
    studies: path.join(bench, "studies"),
    results: path.join(bench, "RESULTS.md"),
    glossary: path.join(bench, "glossary.json"),
    config: path.join(projectDir, ".gg", "bench.config.json"),
  };
}

/** Validators for every adapter, gate and metric this kit version ships. */
export function registries() {
  return {
    adapters: adapterValidators(),
    gates: gateValidators(),
    metrics: metricValidators(),
  };
}

/** @param {Context} ctx */
const nowOf = (ctx) => (ctx.now ?? (() => new Date().toISOString()))();
/** @param {Context} ctx */
const kitOf = (ctx) => ctx.kitDir ?? KIT_DIR;

/** A run id from a timestamp: full-2026-10-20T03-15-00-000Z. @param {string} kind @param {string} iso */
export const defaultRunId = (kind, iso) => `${kind}-${iso.replace(/[:.]/g, "-")}`;

/**
 * Read `.gg/bench.config.json` (optional). Services are base URLs for the
 * http adapter; prices are only ever taken from here, never guessed.
 * @param {string} file
 * @returns {Promise<import("./result.mjs").Result<{ services: Record<string, string>, prices: Record<string, any>, [key: string]: unknown }>>}
 */
export async function readConfig(file) {
  const text = await readOptional(file);
  if (!text.ok) return text;
  if (text.value === undefined) return ok({ services: {}, prices: {} });
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(text.value);
  } catch (error) {
    return err(
      "CONFIG_INVALID",
      `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return err("CONFIG_INVALID", `${file}: expected a JSON object`);
  const services = parsed.services ?? {};
  if (
    typeof services !== "object" ||
    services === null ||
    Array.isArray(services) ||
    !Object.values(services).every((v) => typeof v === "string")
  )
    return err("CONFIG_INVALID", `${file}: services must map names to base URLs`);
  const priceProblems = validatePrices(parsed.prices);
  if (priceProblems.length)
    return err("CONFIG_INVALID", `${file}: ${priceProblems.join("; ")}`, priceProblems);
  return ok({ ...parsed, services, prices: parsed.prices ?? {} });
}

/**
 * Load and validate one study by id.
 * @param {Context} ctx
 * @param {string} id
 */
export async function openStudy(ctx, id) {
  if (typeof id !== "string" || !STUDY_ID.test(id))
    return err("STUDY_ID", `study id must be letters, digits, '.', '_' or '-': ${String(id)}`);
  const studyDir = path.join(projectPaths(ctx.projectDir).studies, id);
  const loaded = await loadStudy(studyDir, registries());
  if (!loaded.ok) return loaded;
  if (loaded.value.study.id !== id)
    return err(
      "STUDY_ID_MISMATCH",
      `folder ${id} holds study "${loaded.value.study.id}"; the folder name and id must match`,
    );
  return ok({ study: loaded.value.study, studyDir });
}

/**
 * Parts of a study this kit version cannot run (an adapter, gate or metric
 * type the study format knows but this kit does not ship yet).
 * @param {any} study
 */
export function unsupportedParts(study) {
  /** @type {string[]} */
  const out = [];
  const metricTypes = new Set(Object.keys(metricValidators()));
  for (const c of study.candidates)
    if (!Object.hasOwn(ADAPTERS, c.adapter.type))
      out.push(
        `candidate ${c.id}: adapter type ${c.adapter.type} is not available in this kit version`,
      );
  for (const g of study.gates ?? [])
    if (!Object.hasOwn(GATES, g.type))
      out.push(`gate ${g.id}: gate type ${g.type} is not available in this kit version`);
  for (const m of study.metrics)
    if (!metricTypes.has(m.type))
      out.push(`metric ${m.id}: metric type ${m.type} is not available in this kit version`);
  return out;
}

/**
 * Paid candidates never run without spend caps a person approved, and the
 * whole planned run must fit those caps at its worst case.
 * @param {any} study  the study actually run (an A/A study counts the copy)
 * @param {Partial<import("./budget.mjs").Approval>} [approval]
 * @param {{ repeats?: number }} [options]
 */
export function paidGuard(study, approval, options = {}) {
  const plan = planSpend(study, options);
  const checked = checkApproval(plan, approval);
  if (!checked.ok) return checked;
  return ok({ plan, approval: checked.value });
}

/**
 * Problems with the task bundles of a study that has agent candidates
 * (checked before anything runs, so no money is spent on a broken task).
 * @param {any} study
 * @param {string} studyDir
 */
export async function taskProblems(study, studyDir) {
  if (!study.candidates.some((/** @type {any} */ c) => c.adapter.type === "agent")) return [];
  const workloadDir = path.join(studyDir, study.workload.dir ?? "workload");
  /** @type {string[]} */
  const problems = [];
  for (const item of study.workload.items) {
    if (!item.input) {
      problems.push(`item ${item.id}: agent items need input pointing at a task bundle folder`);
      continue;
    }
    const loaded = await loadTask(path.join(workloadDir, item.input));
    if (!loaded.ok) problems.push(`item ${item.id}: ${loaded.error.message}`);
  }
  return problems;
}

// ---------------------------------------------------------------- validate

/** @param {Context} ctx @param {string} id */
export async function validate(ctx, id) {
  const opened = await openStudy(ctx, id);
  if (!opened.ok) return opened;
  const { study, studyDir } = opened.value;
  const tasks = await taskProblems(study, studyDir);
  if (tasks.length) return err("TASK_INVALID", tasks.join("; "), tasks);
  const warnings = unsupportedParts(study);
  return ok({
    study: study.id,
    title: study.title,
    candidates: study.candidates.map((/** @type {any} */ c) => c.id),
    items: study.workload.items.length,
    metrics: study.metrics.map((/** @type {any} */ m) => m.id),
    gates: (study.gates ?? []).map((/** @type {any} */ g) => g.id),
    warnings,
  });
}

// ---------------------------------------------------------------- freeze

/** @param {Context} ctx @param {any} study */
async function provenance(ctx, study) {
  return collectProvenance(study, {
    baseDir: ctx.projectDir,
    ...(ctx.exec ? { exec: ctx.exec } : {}),
  });
}

/** @param {Context} ctx @param {string} id */
export async function freeze(ctx, id) {
  const opened = await openStudy(ctx, id);
  if (!opened.ok) return opened;
  const { study, studyDir } = opened.value;
  const facts = await provenance(ctx, study);
  if (!facts.ok) return facts;
  const frozen = await freezeProtocol(studyDir, {
    kitDir: kitOf(ctx),
    provenance: facts.value,
    registries: registries(),
    now: () => nowOf(ctx),
    environment: captureEnvironment(),
  });
  if (!frozen.ok) return frozen;
  const v = frozen.value.version;
  return ok({
    study: study.id,
    status: frozen.value.status,
    version: v.version,
    digest: v.digest,
    changed: frozen.value.changed,
    file: path.join(studyDir, "protocol.json"),
  });
}

// ---------------------------------------------------------------- run / aa

/**
 * Everything a run or report needs, after the provenance and protocol checks.
 * @param {Context} ctx
 * @param {string} id
 */
async function prepare(ctx, id) {
  const opened = await openStudy(ctx, id);
  if (!opened.ok) return opened;
  const { study, studyDir } = opened.value;
  const facts = await provenance(ctx, study);
  if (!facts.ok) return facts;
  const protocol = await verifyProtocol(studyDir, {
    kitDir: kitOf(ctx),
    provenance: facts.value,
    registries: registries(),
  });
  if (!protocol.ok) return protocol;
  return ok({ study, studyDir, protocol: protocol.value, provenance: facts.value });
}

/**
 * Run one schedule: a full run, a pilot (sizing only, never evidence) or an
 * A/A run (the reference against itself, to measure noise).
 * @param {Context} ctx
 * @param {string} id
 * @param {{ kind?: "full" | "pilot" | "aa", runId?: string, repeats?: number, budget?: Partial<import("./budget.mjs").Approval> }} [options]
 */
export async function run(ctx, id, options = {}) {
  const kind = options.kind ?? "full";
  if (options.repeats !== undefined && kind !== "pilot")
    return err(
      "REPEATS_LOCKED",
      "repeats are fixed by the frozen study; only a pilot run may use fewer",
    );
  if (options.repeats !== undefined && !(Number.isInteger(options.repeats) && options.repeats >= 2))
    return err("REPEATS_INVALID", "a pilot needs at least 2 repeats");
  if (options.runId !== undefined && !RUN_ID.test(options.runId))
    return err("RUN_ID", `run id must be letters, digits, '.', '_' or '-': ${options.runId}`);
  const prepared = await prepare(ctx, id);
  if (!prepared.ok) return prepared;
  const { study, studyDir, protocol } = prepared.value;
  const unsupported = unsupportedParts(study).filter((p) => p.startsWith("candidate "));
  if (unsupported.length) return err("KIT_UNSUPPORTED", unsupported.join("; "), unsupported);
  const target = kind === "aa" ? aaStudy(study) : study;
  const paid = paidGuard(
    target,
    options.budget,
    options.repeats !== undefined ? { repeats: options.repeats } : {},
  );
  if (!paid.ok) return paid;
  const tasks = await taskProblems(study, studyDir);
  if (tasks.length) return err("TASK_INVALID", `nothing was run: ${tasks.join("; ")}`, tasks);
  const config = await readConfig(projectPaths(ctx.projectDir).config);
  if (!config.ok) return config;

  const wantsDocker = study.sandbox?.type === "docker";
  const docker = wantsDocker ? await detectDocker(ctx.exec ? { exec: ctx.exec } : {}) : undefined;
  if (wantsDocker && !docker?.available)
    return err(
      "SANDBOX_UNAVAILABLE",
      `${docker?.reason ?? "docker not available"}; the study asks for docker, so nothing was run`,
    );

  const runId = options.runId ?? defaultRunId(kind, nowOf(ctx));
  const total =
    target.candidates.length *
    target.workload.items.length *
    ((options.repeats ?? study.repeats) + (study.warmupRepeats ?? 0));
  let done = 0;
  const inner = adapterExecutor({
    study: target,
    studyDir,
    projectDir: ctx.projectDir,
    runId,
    config: { services: config.value.services, prices: config.value.prices },
    ...(docker ? { docker } : {}),
    ...(ctx.env ? { env: ctx.env } : {}),
  });
  const spend = paid.value.approval
    ? spendBroker(paid.value.approval, paid.value.plan, runDirFor(studyDir, runId), ctx)
    : undefined;
  const result = await runStudy({
    study: target,
    studyDir,
    runId,
    kind,
    protocol: { version: protocol.version, digest: protocol.digest },
    execute: spend ? spend.wrap(inner) : inner,
    environment: {
      ...captureEnvironment(),
      provenance: prepared.value.provenance,
      ...(docker ? { docker } : {}),
    },
    ...(options.repeats !== undefined ? { repeats: options.repeats } : {}),
    ...(ctx.now ? { now: ctx.now } : {}),
    ...(spend ? { signal: spend.signal } : ctx.signal ? { signal: ctx.signal } : {}),
    onSample: (line) => {
      done++;
      ctx.onProgress?.({
        type: "sample",
        done,
        total,
        candidate: line.candidate,
        item: line.item,
        phase: line.phase,
        status: line.status,
      });
    },
  });
  if (!result.ok) return result;
  const record = result.value;
  /** @type {Record<string, unknown>} */
  const out = {
    study: study.id,
    runId,
    kind,
    status: record.status,
    protocolVersion: protocol.version,
    counts: record.counts,
    runDir: runDirFor(studyDir, runId),
  };
  if (spend) {
    const ledger = spend.ledger();
    out.spend = {
      file: path.join(runDirFor(studyDir, runId), BUDGET_FILE),
      capUsd: ledger.caps.usd,
      committedUsd: ledger.committedUsd,
      knownUsd: ledger.knownUsd,
      unknownSamples: ledger.unknownSamples,
      ...(ledger.stopped ? { stopped: ledger.stopped } : {}),
    };
  }
  if (kind === "aa") {
    const aa = await noiseCheck(study, runDirFor(studyDir, runId));
    if (!aa.ok) return aa;
    out.aa = aa.value;
  }
  return ok(out);
}

/**
 * Wrap an executor with the spend broker: reserve before each paid sample,
 * write the ledger before dispatch, settle after, and stop the run when the
 * budget is exhausted or a sample costs more than its reservation.
 * @param {import("./budget.mjs").Approval} approval
 * @param {ReturnType<typeof planSpend>} plan
 * @param {string} runDir
 * @param {Context} ctx
 */
function spendBroker(approval, plan, runDir, ctx) {
  const broker = createBroker({
    approval,
    perSample: plan.perSample,
    ...(ctx.now ? { now: ctx.now } : {}),
  });
  const controller = new AbortController();
  if (ctx.signal?.aborted) controller.abort();
  ctx.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  const paid = new Set(plan.paid);
  const persist = async () => {
    const w = await writeAtomic(path.join(runDir, BUDGET_FILE), jsonText(broker.ledger()));
    // Losing the ledger means losing track of money: stop rather than guess.
    if (!w.ok) controller.abort();
    return w;
  };
  return {
    signal: controller.signal,
    ledger: () => broker.ledger(),
    /** @param {import("./runner.mjs").Execute} execute @returns {import("./runner.mjs").Execute} */
    wrap: (execute) => async (slot, context) => {
      if (!paid.has(slot.candidate)) return execute(slot, context);
      const reserved = broker.reserve(slot);
      if (!reserved.ok) {
        controller.abort();
        await persist();
        return {
          status: "errored",
          error: { code: reserved.error.code, message: reserved.error.message },
        };
      }
      const written = await persist();
      if (!written.ok)
        return {
          status: "errored",
          error: { code: "BUDGET_LEDGER", message: written.error.message },
        };
      const outcome = await execute(slot, context);
      const settled = broker.settle(reserved.value, outcome);
      await persist();
      if (!settled.ok) controller.abort();
      return outcome;
    },
  };
}

/**
 * Noise floor from an A/A run: compare the reference with its own copy using
 * the primary rule's statistic. Passing means the interval contains "no
 * difference"; its reach either way is the noise floor.
 * @param {any} study
 * @param {string} runDir
 */
export async function noiseCheck(study, runDir) {
  const collected = await collectRuns([runDir]);
  if (!collected.ok) return collected;
  const ref = study.decision.reference;
  const copy = `${ref}~aa`;
  const primary = study.decision.primary;
  const metric = (study.metrics ?? []).find((/** @type {any} */ m) => m.id === primary.metric);
  // The A/A run measures adapter metrics; map them onto study metrics first.
  const metrics = await extractMetrics({
    study,
    samples: collected.value.samples,
    studyDir: path.dirname(path.dirname(runDir)),
  });
  const data = metrics.data;
  const ci = pairedBootstrap(
    data[ref]?.[primary.metric] ?? {},
    data[copy]?.[primary.metric] ?? {},
    {
      statistic: primary.statistic ?? "median",
      better: primary.better ?? metric?.better ?? "lower",
      scale: primary.scale ?? "ratio",
      resamples: study.decision.resamples ?? DEFAULTS.resamples,
      level: study.decision.level ?? DEFAULTS.level,
      seed: seedFrom(`${study.seed}:aa:${primary.metric}`),
    },
  );
  const counts = collected.value.counts;
  const attempted = (/** @type {string} */ id) =>
    (counts[id]?.completed ?? 0) + (counts[id]?.errored ?? 0);
  const errored = (/** @type {string} */ id) => counts[id]?.errored ?? 0;
  const maxErrorRate = study.maxErrorRate ?? 0.1;
  const tooManyErrors = [ref, copy].some(
    (id) => attempted(id) === 0 || errored(id) / attempted(id) > maxErrorRate,
  );
  const verdict = noiseFromAA(ci);
  const passed = verdict.passed && !tooManyErrors && !collected.value.incomplete;
  const reason = tooManyErrors
    ? "too many A/A samples errored to measure noise"
    : collected.value.incomplete
      ? `the A/A run did not finish (${collected.value.incomplete})`
      : verdict.reason;
  return ok({
    runId: path.basename(runDir),
    passed,
    ...(verdict.noise !== undefined ? { noise: verdict.noise } : {}),
    reason,
    ci,
  });
}

// ---------------------------------------------------------------- runs on disk

/**
 * Every recorded run of a study, oldest first.
 * @param {string} studyDir
 * @returns {Promise<RunRecord[]>}
 */
export async function listRuns(studyDir) {
  /** @type {import("node:fs").Dirent[]} */
  let entries;
  try {
    entries = await readdir(path.join(studyDir, "runs"), { withFileTypes: true });
  } catch {
    return [];
  }
  /** @type {RunRecord[]} */
  const runs = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith("_")) continue;
    const r = await readJson(path.join(studyDir, "runs", e.name, "run.json"));
    if (r.ok) runs.push(/** @type {RunRecord} */ (r.value));
  }
  return runs.sort(
    (a, b) => a.startedAt.localeCompare(b.startedAt) || a.runId.localeCompare(b.runId),
  );
}

/**
 * Fill rating metrics from imported blind scores (ratings/<pack>.scores.json).
 * @param {any} study
 * @param {string} studyDir
 * @param {{ data: Record<string, Record<string, Record<string, number[]>>>, unmeasured: Record<string, Record<string, { count: number, reasons: string[] }>> }} metrics
 */
async function applyRatings(study, studyDir, metrics) {
  const ratingMetrics = study.metrics.filter((/** @type {any} */ m) => m.type === "rating");
  if (ratingMetrics.length === 0) return ok(/** @type {string[]} */ ([]));
  /** @type {string[]} */
  let files = [];
  try {
    files = (await readdir(path.join(studyDir, "ratings")))
      .filter((f) => f.endsWith(".scores.json"))
      .sort();
  } catch {
    files = [];
  }
  /** @type {string[]} */
  const used = [];
  for (const m of ratingMetrics) {
    let found = false;
    for (const f of files) {
      const scores = await readJson(path.join(studyDir, "ratings", f));
      if (!scores.ok) return scores;
      const s = /** @type {any} */ (scores.value);
      if (s?.schema !== RATING_SCHEMA || s.metric !== m.id) continue;
      if (m.packs && !m.packs.includes(s.packId)) continue;
      for (const [candidate, byMetric] of Object.entries(s.data ?? {}))
        for (const [item, values] of Object.entries(
          /** @type {Record<string, number[]>} */ (/** @type {any} */ (byMetric)[m.id] ?? {}),
        ))
          (((metrics.data[candidate] ??= {})[m.id] ??= {})[item] ??= []).push(...values);
      used.push(s.packId);
      found = true;
    }
    if (found) for (const byMetric of Object.values(metrics.unmeasured)) delete byMetric[m.id];
    else
      for (const c of study.candidates)
        (metrics.unmeasured[c.id] ??= {})[m.id] = {
          count: 0,
          reasons: ["no blind ratings have been imported yet (`rate import`)"],
        };
  }
  return ok([...new Set(used)].sort());
}

// ---------------------------------------------------------------- report

/**
 * Turn the current version's full runs into report.md, verdict.json and a
 * RESULTS.md entry. Refuses to write anything whose wording breaks the
 * honesty rules.
 * @param {Context} ctx
 * @param {string} id
 * @param {{ runs?: string[], aa?: string }} [options]
 */
export async function report(ctx, id, options = {}) {
  const prepared = await prepare(ctx, id);
  if (!prepared.ok) return prepared;
  const { study, studyDir, protocol } = prepared.value;
  const all = await listRuns(studyDir);

  /** @type {RunRecord[]} */
  let chosen;
  if (options.runs?.length) {
    chosen = [];
    for (const runId of options.runs) {
      const r = all.find((x) => x.runId === runId);
      if (!r) return err("RUN_UNKNOWN", `no run named ${runId}`);
      if (r.kind !== "full")
        return err(
          "RUN_KIND",
          `run ${runId} is a ${r.kind} run; only full runs are evidence for a verdict`,
        );
      chosen.push(r);
    }
  } else {
    chosen = all.filter((r) => r.kind === "full" && r.protocolDigest === protocol.digest);
    if (chosen.length === 0) {
      const others = [
        ...new Set(all.filter((r) => r.kind === "full").map((r) => r.protocolVersion)),
      ].sort((a, b) => a - b);
      return err(
        "NO_RUNS",
        others.length
          ? `no full runs for protocol v${protocol.version}; runs exist only for ${others.map((v) => `v${v}`).join(", ")} and results are never pooled across versions`
          : "no full runs yet; run the study first",
      );
    }
  }
  const collected = await collectRuns(chosen.map((r) => runDirFor(studyDir, r.runId)));
  if (!collected.ok) return collected;
  if (collected.value.protocolDigest !== protocol.digest)
    return err(
      "PROTOCOL_STALE",
      `those runs were made under protocol v${collected.value.protocolVersion}, but the study is now v${protocol.version}; results are never pooled across versions`,
    );

  const generatedAt = nowOf(ctx);
  const workDir = path.join(studyDir, "runs", "_gates", defaultRunId("report", generatedAt));
  const gates = await evaluateGates({
    study,
    samples: collected.value.samples,
    studyDir,
    projectDir: ctx.projectDir,
    workDir,
    ...(ctx.env ? { env: ctx.env } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  const metrics = await extractMetrics({
    study,
    samples: collected.value.samples,
    studyDir,
    gateChecks: gates.checks,
  });
  const ratings = await applyRatings(study, studyDir, metrics);
  if (!ratings.ok) return ratings;

  /** @type {RunRecord | undefined} */
  let aaRun;
  if (options.aa) {
    aaRun = all.find((r) => r.runId === options.aa);
    if (!aaRun || aaRun.kind !== "aa") return err("RUN_UNKNOWN", `no A/A run named ${options.aa}`);
    if (aaRun.protocolDigest !== protocol.digest)
      return err(
        "PROTOCOL_STALE",
        `A/A run ${options.aa} belongs to protocol v${aaRun.protocolVersion}, not v${protocol.version}`,
      );
  } else aaRun = all.filter((r) => r.kind === "aa" && r.protocolDigest === protocol.digest).at(-1);
  /** @type {{ passed: boolean, noise?: number, reason?: string } | undefined} */
  let aa;
  /** @type {any} */
  let aaDetail;
  if (aaRun) {
    const checked = await noiseCheck(study, runDirFor(studyDir, aaRun.runId));
    if (!checked.ok) return checked;
    aaDetail = checked.value;
    aa = {
      passed: checked.value.passed,
      ...(checked.value.noise !== undefined ? { noise: checked.value.noise } : {}),
      reason: checked.value.reason,
    };
  }

  const decision = decide({
    study,
    data: metrics.data,
    gates: gates.summaries,
    counts: collected.value.counts,
    ...(aa ? { aa } : {}),
    ...(collected.value.incomplete ? { incomplete: collected.value.incomplete } : {}),
  });
  const runIds = collected.value.runIds;
  // Choosing runs is allowed, but never silently: every full run of this
  // version that was left out is named in report.md and verdict.json.
  const excludedRunIds = all
    .filter(
      (r) => r.kind === "full" && r.protocolDigest === protocol.digest && !runIds.includes(r.runId),
    )
    .map((r) => r.runId)
    .sort();
  const built = buildReport({
    study,
    decision,
    metrics,
    gates: gates.summaries,
    counts: collected.value.counts,
    protocol: { version: protocol.version, digest: protocol.digest },
    runIds,
    excludedRunIds,
    ...(aa ? { aa } : {}),
    generatedAt,
  });
  if (built.problems.length)
    return err(
      "REPORT_WORDING",
      `the generated wording broke the honesty rules, so nothing was written: ${built.problems.join("; ")}`,
      built.problems,
    );
  const verdict = buildVerdict({
    study,
    decision,
    explained: built.explained,
    protocol: { version: protocol.version, digest: protocol.digest },
    runIds,
    excludedRunIds,
    generatedAt,
  });
  const paths = projectPaths(ctx.projectDir);
  for (const write of [
    () => writeAtomic(path.join(workDir, "checks.json"), jsonText(gates.checks)),
    () => writeReport(studyDir, built.markdown),
    () => writeVerdict(studyDir, verdict),
  ]) {
    const w = await write();
    if (!w.ok) return w;
  }
  const ledger = await updateLedger(paths.results, verdict, study);
  if (!ledger.ok) return ledger;
  return ok({
    study: study.id,
    protocolVersion: protocol.version,
    runs: runIds,
    ...(excludedRunIds.length ? { excludedRuns: excludedRunIds } : {}),
    verdict: decision.verdict,
    ...(decision.winner ? { winner: decision.winner } : {}),
    keep: decision.keep,
    headline: built.explained.verdict.headline,
    meaning: built.explained.verdict.meaning,
    nextSteps: built.explained.verdict.nextSteps,
    candidates: Object.fromEntries(
      built.explained.candidates.map((c) => [
        c.id,
        { verdict: c.verdict, headline: c.headline, meaning: c.meaning },
      ]),
    ),
    ...(aaDetail ? { aa: aaDetail } : {}),
    ratings: ratings.value,
    files: {
      report: path.join(studyDir, REPORT_FILE),
      verdict: path.join(studyDir, VERDICT_FILE),
      ledger: ledger.value.file,
      gateChecks: path.join(workDir, "checks.json"),
    },
    ledgerAction: ledger.value.action,
  });
}

// ---------------------------------------------------------------- explain

/** The study's own rule, before any run, in the shape explainRule reads. @param {any} study */
function ruleFromStudy(study) {
  const p = study.decision.primary;
  const scale = p.scale ?? "ratio";
  const neutral = scale === "ratio" ? 1 : 0;
  return {
    reference: study.decision.reference,
    tieBreak: study.decision.tieBreak ?? [],
    rule: {
      metric: p.metric,
      scale,
      bar: scale === "ratio" ? (p.minRatio ?? 1) : (p.minDifference ?? 0),
      floor: p.ciLowerAbove ?? neutral,
      level: study.decision.level ?? DEFAULTS.level,
    },
  };
}

/** Kit glossary plus the project's additions. @param {Context} ctx */
async function glossary(ctx) {
  const base = await readGlossary(KIT_GLOSSARY);
  if (!base.ok) return base;
  const project = await readGlossary(projectPaths(ctx.projectDir).glossary);
  if (!project.ok) return project;
  return ok(mergeGlossaries(base.value, project.value));
}

/**
 * Explain a study (its own numbers first), one of its metrics
 * (`study:metric`), or a glossary term.
 * @param {Context} ctx
 * @param {string} query
 */
export async function explain(ctx, query) {
  if (typeof query !== "string" || !query.trim())
    return err("USAGE", "explain needs a term, a study id or study:metric");
  const [studyPart, metricPart, ...rest] = query.split(":");
  const looksLikeStudy =
    rest.length === 0 &&
    STUDY_ID.test(studyPart ?? "") &&
    (metricPart === undefined || STUDY_ID.test(metricPart));
  if (looksLikeStudy) {
    const studyDir = path.join(
      projectPaths(ctx.projectDir).studies,
      /** @type {string} */ (studyPart),
    );
    const exists = await readOptional(path.join(studyDir, "study.json"));
    if (exists.ok && exists.value !== undefined) {
      const opened = await openStudy(ctx, /** @type {string} */ (studyPart));
      if (!opened.ok) return opened;
      const { study } = opened.value;
      const saved = await readJson(path.join(studyDir, VERDICT_FILE));
      /** @type {any} */
      const verdict = saved.ok ? saved.value : undefined;
      if (metricPart !== undefined) {
        if (!study.metrics.some((/** @type {any} */ m) => m.id === metricPart))
          return err("METRIC_UNKNOWN", `study ${study.id} has no metric ${metricPart}`);
        const info = metricInfo(study, metricPart);
        /** @type {string[]} */
        const results = [];
        if (verdict && verdict.rule?.metric === metricPart)
          for (const c of study.candidates) {
            const p = verdict.candidates?.[c.id]?.primary;
            if (c.id === verdict.reference) continue;
            results.push(
              p
                ? `${candidateName(study, c.id)} against ${candidateName(study, verdict.reference)}: ${describeRange({ lower: p.lower, upper: p.upper, level: p.level, scale: verdict.rule.scale }, info, verdict.rule)}.`
                : `${candidateName(study, c.id)}: not compared on this metric (${verdict.candidates?.[c.id]?.verdict ?? "no result"}).`,
            );
          }
        return ok({
          kind: "metric",
          study: study.id,
          metric: metricPart,
          meaning: explainMetric(study, metricPart),
          results,
          source: verdict ? "this study's verdict.json" : "the study definition (no verdict yet)",
        });
      }
      return ok({
        kind: "study",
        study: study.id,
        question: study.question,
        rule: explainRule(verdict ?? ruleFromStudy(study), study),
        metrics: study.metrics.map((/** @type {any} */ m) => explainMetric(study, m.id)),
        candidates: study.candidates.map((/** @type {any} */ c) => candidateName(study, c.id)),
        ...(verdict
          ? { verdict: verdict.verdict, headline: verdict.headline, meaning: verdict.meaning }
          : { verdict: null, meaning: "No verdict yet: the study has not been reported." }),
      });
    }
  }
  const g = await glossary(ctx);
  if (!g.ok) return g;
  const hit = explainTerm(g.value, query);
  if (!hit.ok) return hit;
  return ok({ kind: "term", ...hit.value });
}

/**
 * Add a plain-language term to the project glossary (bench/glossary.json).
 * @param {Context} ctx
 * @param {string} term
 * @param {{ plain: string, example?: string, aliases?: string[], replace?: boolean }} entry
 */
export async function addGlossaryTerm(ctx, term, entry) {
  const file = projectPaths(ctx.projectDir).glossary;
  const all = await glossary(ctx);
  if (!all.ok) return all;
  const project = await readGlossary(file);
  if (!project.ok) return project;
  const { replace = false, ...fields } = entry;
  // Check against kit + project terms so an alias never shadows a kit term.
  const clash = addTerm(all.value, term, fields, { replace });
  if (!clash.ok) return clash;
  const next = addTerm(project.value, term, fields, { replace: true });
  if (!next.ok) return next;
  const written = await writeGlossary(file, next.value);
  if (!written.ok) return written;
  return ok({ term: term.trim().toLowerCase().replace(/\s+/g, " "), file });
}

// ---------------------------------------------------------------- rate

/**
 * Build a blind rating pack from one full run's outputs (first completed
 * sample per candidate and item).
 * @param {Context} ctx
 * @param {string} id
 * @param {{ packId: string, runId?: string, scale?: { min: number, max: number }, prompt?: string }} options
 */
export async function rateCreate(ctx, id, options) {
  const opened = await openStudy(ctx, id);
  if (!opened.ok) return opened;
  const { study, studyDir } = opened.value;
  const protocol = await readProtocol(studyDir);
  if (!protocol.ok) return protocol;
  if (!protocol.value)
    return err("PROTOCOL_NOT_FROZEN", "no protocol.json yet; run `freeze` first");
  const digest = currentVersion(protocol.value).digest;
  const runs = await listRuns(studyDir);
  const run = options.runId
    ? runs.find((r) => r.runId === options.runId)
    : runs.filter((r) => r.kind === "full" && r.protocolDigest === digest).at(-1);
  if (!run)
    return err(
      "RUN_UNKNOWN",
      options.runId ? `no run named ${options.runId}` : "no full run to rate yet",
    );
  const collected = await collectRuns([runDirFor(studyDir, run.runId)], { includePilot: true });
  if (!collected.ok) return collected;
  /** @type {Map<string, Record<string, string>>} */
  const byItem = new Map();
  const ordered = [...collected.value.samples].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  for (const s of ordered) {
    if (s.status !== "ok" || typeof s.info?.outPath !== "string") continue;
    const candidate = baseCandidateId(String(s.candidate));
    const outputs = byItem.get(s.item) ?? {};
    outputs[candidate] ??= s.info.outPath;
    byItem.set(s.item, outputs);
  }
  /** @type {string[]} */
  const skipped = [];
  const entries = [];
  for (const item of study.workload.items.map((/** @type {any} */ i) => i.id)) {
    const outputs = byItem.get(item) ?? {};
    if (Object.keys(outputs).length < 2) skipped.push(item);
    else entries.push({ item, outputs });
  }
  const pack = await createRatingPack({
    studyDir,
    study,
    packId: options.packId,
    entries,
    ...(options.scale ? { scale: options.scale } : {}),
    ...(options.prompt ? { prompt: options.prompt } : {}),
  });
  if (!pack.ok) return pack;
  return ok({
    study: study.id,
    runId: run.runId,
    ...pack.value,
    warnings: [
      ...pack.value.warnings,
      ...skipped.map((i) => `item ${i} skipped: fewer than 2 candidates produced an output`),
    ],
  });
}

/**
 * Unblind filled-in scores. The metric defaults to the study's only rating metric.
 * @param {Context} ctx
 * @param {string} id
 * @param {{ packId: string, scoresFile: string, metric?: string }} options
 */
export async function rateImport(ctx, id, options) {
  const opened = await openStudy(ctx, id);
  if (!opened.ok) return opened;
  const { study, studyDir } = opened.value;
  const ratingMetrics = study.metrics
    .filter((/** @type {any} */ m) => m.type === "rating")
    .map((/** @type {any} */ m) => m.id);
  let metric = options.metric;
  if (metric === undefined) {
    if (ratingMetrics.length > 1)
      return err(
        "RATING_METRIC",
        `the study has several rating metrics (${ratingMetrics.join(", ")}); pass --metric`,
      );
    metric = ratingMetrics[0] ?? "rating";
  }
  const imported = await importScores({
    studyDir,
    packId: options.packId,
    scoresFile: path.resolve(ctx.projectDir, options.scoresFile),
    metric,
  });
  if (!imported.ok) return imported;
  const v = imported.value;
  return ok({
    study: study.id,
    packId: options.packId,
    metric: v.metric,
    raters: v.raters,
    rows: v.rows,
    skipped: v.skipped,
    summary: v.summary,
    file: v.file,
    usedByReport: ratingMetrics.includes(metric),
  });
}

// ---------------------------------------------------------------- list

/** Every study in the project with its latest state. @param {Context} ctx */
export async function list(ctx) {
  const dir = projectPaths(ctx.projectDir).studies;
  /** @type {import("node:fs").Dirent[]} */
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const studies = [];
  for (const e of entries
    .filter((x) => x.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const studyDir = path.join(dir, e.name);
    const opened = await openStudy(ctx, e.name);
    const protocol = await readProtocol(studyDir);
    const verdict = await readJson(path.join(studyDir, VERDICT_FILE));
    const runs = await listRuns(studyDir);
    const v = /** @type {any} */ (verdict.ok ? verdict.value : undefined);
    studies.push({
      id: e.name,
      valid: opened.ok,
      ...(opened.ok ? { title: opened.value.study.title } : { problem: opened.error.message }),
      protocolVersion: protocol.ok && protocol.value ? protocol.value.current : null,
      runs: runs.length,
      verdict: v?.verdict ?? null,
      ...(v?.keep ? { keep: v.keep } : {}),
    });
  }
  return ok({ studies });
}
