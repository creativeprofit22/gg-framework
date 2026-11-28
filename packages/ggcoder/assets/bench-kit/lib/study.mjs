// @ts-check
// study.json: load and validate. Hand-written validator so every error names
// the exact field ("candidates[1].adapter.type: ...") and the kit stays
// dependency-free. Type-specific config is checked by the registries passed in.
import { readFile } from "node:fs/promises";
import path from "node:path";

import { validateSource } from "./provenance.mjs";
import { err, ok } from "./result.mjs";

export const STUDY_SCHEMA = 1;
export const ADAPTER_TYPES = Object.freeze(["function", "cli", "http", "agent", "manual"]);
export const GATE_TYPES = Object.freeze([
  "exit-code",
  "equals",
  "tolerance",
  "schema",
  "command",
  "quality",
  "tests",
  "scope",
  "side-effects",
  "honesty",
]);
export const METRIC_TYPES = Object.freeze([
  "wall-time",
  "cpu-time",
  "peak-memory",
  "output-size",
  "tokens-cost",
  "custom",
  "rating",
]);
export const STUDY_KINDS = Object.freeze([
  "code",
  "library",
  "engine",
  "cli",
  "service",
  "agent",
  "other",
]);
export const STATISTIC_NAMES = Object.freeze(["median", "mean", "min", "max", "p90", "p95", "p99"]);
const ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;

/**
 * @typedef {{ validate?: (config: any) => string[] }} Validatable
 * @typedef {{ adapters?: Record<string, Validatable>, gates?: Record<string, Validatable>, metrics?: Record<string, Validatable> }} Registries
 */

/** @param {unknown} v */
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
/** @param {unknown} v */
const isPosInt = (v) => Number.isInteger(v) && /** @type {number} */ (v) > 0;

/**
 * Validate a parsed study. Returns every problem, not just the first.
 * @param {any} study
 * @param {Registries} [registries]
 * @returns {string[]}
 */
export function validateStudy(study, registries = {}) {
  /** @type {string[]} */
  const errors = [];
  /** @param {string} where @param {string} what */
  const bad = (where, what) => errors.push(`${where}: ${what}`);
  if (!isObject(study)) return ["study: expected a JSON object"];

  if (study.schema !== STUDY_SCHEMA)
    bad("schema", `expected ${STUDY_SCHEMA}, got ${JSON.stringify(study.schema)}`);
  if (typeof study.id !== "string" || !ID.test(study.id))
    bad("id", "expected letters, digits, '.', '_' or '-' (max 64)");
  for (const field of ["title", "question"])
    if (typeof study[field] !== "string" || study[field].trim() === "")
      bad(field, "expected a non-empty string");
  if (study.kind !== undefined && !STUDY_KINDS.includes(study.kind))
    bad("kind", `expected one of ${STUDY_KINDS.join("|")}, got ${JSON.stringify(study.kind)}`);
  if (!isPosInt(study.repeats) || study.repeats < 2)
    bad("repeats", "expected an integer of at least 2");
  if (
    study.warmupRepeats !== undefined &&
    !(Number.isInteger(study.warmupRepeats) && study.warmupRepeats >= 0)
  )
    bad("warmupRepeats", "expected an integer of at least 0");
  if (!Number.isInteger(study.seed) || study.seed < 0 || study.seed > 0xffffffff)
    bad("seed", "expected an integer between 0 and 4294967295");
  if (study.timeoutMs !== undefined && !isPosInt(study.timeoutMs))
    bad("timeoutMs", "expected a positive integer");
  if (
    study.maxErrorRate !== undefined &&
    !(typeof study.maxErrorRate === "number" && study.maxErrorRate >= 0 && study.maxErrorRate <= 1)
  )
    bad("maxErrorRate", "expected a number between 0 and 1");

  /** @type {Set<string>} */
  const candidateIds = new Set();
  if (!Array.isArray(study.candidates) || study.candidates.length < 2)
    bad("candidates", "expected at least 2 candidates");
  let anyPaid = false;
  (Array.isArray(study.candidates) ? study.candidates : []).forEach(
    (/** @type {any} */ c, /** @type {number} */ i) => {
      const at = `candidates[${i}]`;
      if (!isObject(c)) return bad(at, "expected an object");
      if (typeof c.id !== "string" || !ID.test(c.id))
        bad(`${at}.id`, "expected letters, digits, '.', '_' or '-' (max 64)");
      else if (candidateIds.has(c.id)) bad(`${at}.id`, `duplicate id "${c.id}"`);
      else candidateIds.add(c.id);
      if (c.paid !== undefined && typeof c.paid !== "boolean")
        bad(`${at}.paid`, "expected true or false");
      if (c.synthetic !== undefined && typeof c.synthetic !== "boolean")
        bad(`${at}.synthetic`, "expected true or false");
      if (c.paid === true) anyPaid = true;
      if (c.source !== undefined)
        for (const p of validateSource(c.source)) bad(`${at}.source${p.path}`, p.message);
      if (!isObject(c.adapter)) return bad(`${at}.adapter`, "expected an object with a type");
      if (!ADAPTER_TYPES.includes(c.adapter.type))
        return bad(
          `${at}.adapter.type`,
          `expected one of ${ADAPTER_TYPES.join("|")}, got ${JSON.stringify(c.adapter.type)}`,
        );
      if (c.adapter.type === "agent" && typeof c.paid !== "boolean")
        bad(
          `${at}.paid`,
          "agent candidates must say whether they cost money (paid: true or false)",
        );
      if (c.adapter.type === "agent" && c.source?.version === undefined)
        bad(
          `${at}.source.version`,
          'agent candidates must record their CLI version (e.g. "claude --version"), so a CLI update makes a new protocol version',
        );
      for (const e of registries.adapters?.[c.adapter.type]?.validate?.(c.adapter) ?? [])
        bad(`${at}.adapter`, e);
    },
  );

  /** @type {Set<string>} */
  const itemIds = new Set();
  if (!isObject(study.workload)) bad("workload", "expected an object with items");
  else {
    if (
      study.workload.dir !== undefined &&
      (typeof study.workload.dir !== "string" ||
        path.isAbsolute(study.workload.dir) ||
        study.workload.dir.split(/[\\/]/).includes(".."))
    )
      bad("workload.dir", "expected a relative path inside the study folder");
    if (!Array.isArray(study.workload.items) || study.workload.items.length === 0)
      bad("workload.items", "expected at least 1 item");
    (Array.isArray(study.workload.items) ? study.workload.items : []).forEach(
      (/** @type {any} */ item, /** @type {number} */ i) => {
        const at = `workload.items[${i}]`;
        if (!isObject(item)) return bad(at, "expected an object");
        if (typeof item.id !== "string" || !ID.test(item.id))
          bad(`${at}.id`, "expected letters, digits, '.', '_' or '-' (max 64)");
        else if (itemIds.has(item.id)) bad(`${at}.id`, `duplicate id "${item.id}"`);
        else itemIds.add(item.id);
        for (const key of ["input", "expectedFile"])
          if (
            item[key] !== undefined &&
            (typeof item[key] !== "string" ||
              path.isAbsolute(item[key]) ||
              item[key].split(/[\\/]/).includes(".."))
          )
            bad(`${at}.${key}`, "expected a relative path inside the workload folder");
      },
    );
  }

  /** @type {Map<string, any>} */
  const metrics = new Map();
  if (!Array.isArray(study.metrics) || study.metrics.length === 0)
    bad("metrics", "expected at least 1 metric");
  (Array.isArray(study.metrics) ? study.metrics : []).forEach(
    (/** @type {any} */ m, /** @type {number} */ i) => {
      const at = `metrics[${i}]`;
      if (!isObject(m)) return bad(at, "expected an object");
      if (typeof m.id !== "string" || !ID.test(m.id))
        bad(`${at}.id`, "expected letters, digits, '.', '_' or '-' (max 64)");
      else if (metrics.has(m.id)) bad(`${at}.id`, `duplicate id "${m.id}"`);
      else metrics.set(m.id, m);
      if (!METRIC_TYPES.includes(m.type))
        return bad(
          `${at}.type`,
          `expected one of ${METRIC_TYPES.join("|")}, got ${JSON.stringify(m.type)}`,
        );
      if (m.better !== undefined && m.better !== "lower" && m.better !== "higher")
        bad(`${at}.better`, "expected lower or higher");
      for (const e of registries.metrics?.[m.type]?.validate?.(m) ?? []) bad(at, e);
    },
  );

  /** @type {Set<string>} */
  const gateIds = new Set();
  /** @type {Map<string, unknown>} */
  const gateTypes = new Map();
  if (study.gates !== undefined && !Array.isArray(study.gates)) bad("gates", "expected an array");
  (Array.isArray(study.gates) ? study.gates : []).forEach(
    (/** @type {any} */ g, /** @type {number} */ i) => {
      const at = `gates[${i}]`;
      if (!isObject(g)) return bad(at, "expected an object");
      if (typeof g.id !== "string" || !ID.test(g.id))
        bad(`${at}.id`, "expected letters, digits, '.', '_' or '-' (max 64)");
      else if (gateIds.has(g.id)) bad(`${at}.id`, `duplicate id "${g.id}"`);
      else {
        gateIds.add(g.id);
        gateTypes.set(g.id, g.type);
      }
      if (g.judge !== undefined || /judge/i.test(String(g.type)))
        return bad(
          at,
          "LLM judges cannot gate a study; record an optional non-gating note instead",
        );
      if (!GATE_TYPES.includes(g.type))
        return bad(
          `${at}.type`,
          `expected one of ${GATE_TYPES.join("|")}, got ${JSON.stringify(g.type)}`,
        );
      if (g.scope !== undefined && g.scope !== "candidate" && g.scope !== "sample")
        bad(`${at}.scope`, "expected candidate or sample");
      if (g.severity !== undefined && g.severity !== "disqualify" && g.severity !== "record")
        bad(
          `${at}.severity`,
          "expected disqualify (default: a failure rules the candidate out) or record (checked and kept for metrics, never rules out)",
        );
      if (g.testsGate !== undefined && gateTypes.get(g.testsGate) !== "tests")
        bad(`${at}.testsGate`, "must name a tests gate listed before this one");
      if (g.appliesTo !== undefined) {
        if (!Array.isArray(g.appliesTo))
          bad(`${at}.appliesTo`, "expected an array of candidate ids");
        else
          for (const id of g.appliesTo)
            if (!candidateIds.has(id)) bad(`${at}.appliesTo`, `unknown candidate "${id}"`);
      }
      for (const e of registries.gates?.[g.type]?.validate?.(g) ?? []) bad(at, e);
    },
  );

  const d = study.decision;
  if (!isObject(d)) bad("decision", "expected the pre-registered decision rule");
  else {
    if (!candidateIds.has(d.reference))
      bad(
        "decision.reference",
        `expected one of the candidate ids, got ${JSON.stringify(d.reference)}`,
      );
    if (d.level !== undefined && !(typeof d.level === "number" && d.level > 0.5 && d.level < 1))
      bad("decision.level", "expected a number between 0.5 and 1");
    if (
      d.resamples !== undefined &&
      !(Number.isInteger(d.resamples) && d.resamples >= 1000 && d.resamples <= 1_000_000)
    )
      bad("decision.resamples", "expected a whole number from 1000 to 1000000");
    if (
      d.noise !== undefined &&
      !(
        isObject(d.noise) &&
        (d.noise.requireAA === undefined || typeof d.noise.requireAA === "boolean")
      )
    )
      bad("decision.noise", "expected { requireAA: true | false }");
    const p = d.primary;
    if (!isObject(p))
      bad("decision.primary", "expected { metric, better, minRatio, ciLowerAbove }");
    else {
      if (!metrics.has(p.metric))
        bad("decision.primary.metric", `unknown metric ${JSON.stringify(p.metric)}`);
      if (p.better !== undefined && p.better !== "lower" && p.better !== "higher")
        bad("decision.primary.better", "expected lower or higher");
      if (p.scale !== undefined && p.scale !== "ratio" && p.scale !== "difference")
        bad("decision.primary.scale", "expected ratio or difference");
      if (p.statistic !== undefined && !STATISTIC_NAMES.includes(p.statistic))
        bad("decision.primary.statistic", `expected one of ${STATISTIC_NAMES.join("|")}`);
      if ((p.scale ?? "ratio") === "ratio") {
        if (!(typeof p.minRatio === "number" && p.minRatio >= 1))
          bad(
            "decision.primary.minRatio",
            "expected a number of at least 1 (e.g. 1.3 = 30% better)",
          );
      } else if (!(typeof p.minDifference === "number" && p.minDifference >= 0))
        bad("decision.primary.minDifference", "expected a number of at least 0");
      if (p.ciLowerAbove !== undefined && typeof p.ciLowerAbove !== "number")
        bad("decision.primary.ciLowerAbove", "expected a number");
    }
    if (d.secondary !== undefined && !Array.isArray(d.secondary))
      bad("decision.secondary", "expected an array");
    (Array.isArray(d.secondary) ? d.secondary : []).forEach(
      (/** @type {any} */ s, /** @type {number} */ i) => {
        if (!isObject(s) || !metrics.has(s.metric))
          return bad(`decision.secondary[${i}].metric`, "expected a known metric id");
        if (s.better !== undefined && s.better !== "lower" && s.better !== "higher")
          bad(`decision.secondary[${i}].better`, "expected lower or higher");
        if (s.statistic !== undefined && !STATISTIC_NAMES.includes(s.statistic))
          bad(`decision.secondary[${i}].statistic`, `expected one of ${STATISTIC_NAMES.join("|")}`);
        if (
          s.mustNotRegressBeyond !== undefined &&
          !(typeof s.mustNotRegressBeyond === "number" && s.mustNotRegressBeyond >= 1)
        )
          bad(`decision.secondary[${i}].mustNotRegressBeyond`, "expected a number of at least 1");
      },
    );
    if (
      d.tieBreak !== undefined &&
      !(
        Array.isArray(d.tieBreak) &&
        d.tieBreak.every((/** @type {unknown} */ t) => typeof t === "string")
      )
    )
      bad("decision.tieBreak", "expected an array of strings");
  }

  if (study.sandbox !== undefined) {
    if (!isObject(study.sandbox) || !["process", "docker"].includes(study.sandbox.type))
      bad("sandbox.type", "expected process or docker");
    else if (study.sandbox.type === "docker") {
      const s = study.sandbox;
      if (typeof s.image !== "string" || s.image === "")
        bad("sandbox.image", "expected a docker image name");
      if (s.network !== undefined && s.network !== "none" && s.network !== "bridge")
        bad("sandbox.network", "expected none (default) or bridge");
      if (
        s.memory !== undefined &&
        !(typeof s.memory === "string" && /^\d+[bkmg]?$/i.test(s.memory))
      )
        bad("sandbox.memory", 'expected a docker memory size such as "2g" or "512m"');
      if (s.pids !== undefined && !(Number.isInteger(s.pids) && s.pids > 0))
        bad("sandbox.pids", "expected a whole number above 0");
      if (s.cpus !== undefined && !(typeof s.cpus === "number" && s.cpus > 0))
        bad("sandbox.cpus", "expected a number above 0");
      // Refuse up front what docker cannot honour, instead of a run of errored
      // samples or a candidate that silently runs outside the sandbox.
      (Array.isArray(study.candidates) ? study.candidates : []).forEach(
        (/** @type {any} */ c, /** @type {number} */ i) => {
          const type = isObject(c) && isObject(c.adapter) ? c.adapter.type : undefined;
          if (type === "agent" || type === "function")
            bad(
              `candidates[${i}].adapter.type`,
              `${type} candidates run only in the process sandbox; use "sandbox": { "type": "process" }`,
            );
          if (type === "cli")
            for (const key of ["command", "prepare", "cleanup"])
              if (typeof c.adapter[key] === "string" && c.adapter[key].includes("{workload}"))
                bad(
                  `candidates[${i}].adapter.${key}`,
                  "the {workload} slot is not available inside docker; use {input} or {inputDir}",
                );
        },
      );
    }
  }

  if (anyPaid) {
    const w = study.budget?.perSampleWorstCase;
    if (!isObject(w) || !(typeof w.usd === "number" && w.usd > 0))
      bad(
        "budget.perSampleWorstCase.usd",
        "paid candidates need a worst-case cost per sample so spend can be reserved",
      );
  }
  if (
    study.unmeasured !== undefined &&
    !(
      Array.isArray(study.unmeasured) &&
      study.unmeasured.every(
        (/** @type {any} */ u) =>
          isObject(u) &&
          typeof u.what === "string" &&
          (u.how === undefined || typeof u.how === "string"),
      )
    )
  )
    bad("unmeasured", "expected an array of { what, how }");
  return errors;
}

/**
 * Read and validate `<studyDir>/study.json`. CRLF is rejected because the
 * bytes are hashed into the protocol.
 * @param {string} studyDir
 * @param {Registries} [registries]
 */
export async function loadStudy(studyDir, registries) {
  const file = path.join(studyDir, "study.json");
  /** @type {Buffer} */
  let bytes;
  try {
    bytes = await readFile(file);
  } catch (error) {
    return err("STUDY_MISSING", `cannot read ${file}: ${/** @type {Error} */ (error).message}`);
  }
  if (bytes.includes(13))
    return err(
      "STUDY_CRLF",
      `${file} contains CR line endings; save it with LF so its hash is stable`,
    );
  /** @type {any} */
  let study;
  try {
    study = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    return err("STUDY_JSON", `${file} is not valid JSON: ${/** @type {Error} */ (error).message}`);
  }
  const errors = validateStudy(study, registries);
  if (errors.length)
    return err("STUDY_INVALID", `${errors.length} problem(s) in study.json`, errors);
  return ok({ study, bytes, file });
}

/** Candidate by id. @param {any} study @param {string} id */
export const candidateById = (study, id) =>
  study.candidates.find((/** @type {any} */ c) => c.id === id);

/** Gates applying to one candidate. @param {any} study @param {string} candidateId */
export function gatesFor(study, candidateId) {
  return (study.gates ?? []).filter(
    (/** @type {any} */ g) => !g.appliesTo || g.appliesTo.includes(candidateId),
  );
}
