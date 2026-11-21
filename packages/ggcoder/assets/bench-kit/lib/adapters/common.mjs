// @ts-check
// Small helpers shared by adapters: config checks, result shapes, paths.
import path from "node:path";

import { slotsIn, splitCommand } from "../argv.mjs";

/**
 * Everything an adapter needs for one sample (built by adapters/index.mjs).
 * @typedef {{
 *   adapterModule: string,
 *   adapter: any,
 *   candidate: { id: string, label?: string },
 *   item: { id: string, input?: string, expected?: string },
 *   phase: "warmup" | "measure",
 *   repeat: number,
 *   projectDir: string,
 *   studyDir: string,
 *   workloadDir: string,
 *   sampleDir: string,
 *   sandbox: { type: "process" | "docker", available?: boolean, reason?: string, image?: string, network?: "none" | "bridge", memory?: string, pids?: number, cpus?: number },
 *   config: { services?: Record<string, string>, prices?: Record<string, any> },
 *   timeoutMs: number,
 * }} AdapterJob
 * @typedef {import("../worker.mjs").SampleResult} SampleResult
 */

/** @param {unknown} v @returns {v is Record<string, any>} */
export const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** Relative path that stays inside its base. @param {unknown} p */
export const isContainedRelative = (p) =>
  typeof p === "string" &&
  p.length > 0 &&
  !path.isAbsolute(p) &&
  !path.win32.isAbsolute(p) &&
  !p.split(/[\\/]/).includes("..");

/** Path relative to `from`, with forward slashes. @param {string} from @param {string} to */
export const relPosix = (from, to) => path.relative(from, to).split(path.sep).join("/");

/** @param {string} code @param {string} message @returns {SampleResult} */
export const fail = (code, message) => ({ ok: false, error: { code, message } });

/**
 * @param {Record<string, number | null | undefined>} metrics  null/undefined values are dropped (unmeasured, not zero)
 * @param {Record<string, unknown>} [info]
 * @returns {SampleResult}
 */
export function done(metrics, info) {
  /** @type {Record<string, number>} */
  const clean = {};
  for (const [k, v] of Object.entries(metrics))
    if (typeof v === "number" && Number.isFinite(v)) clean[k] = v;
  return info ? { ok: true, metrics: clean, info } : { ok: true, metrics: clean };
}

/**
 * Check a command template (string or argv array) and its slots.
 * @param {unknown} value
 * @param {string} field
 * @param {readonly string[]} allowedSlots
 * @returns {string[]}
 */
export function validateCommand(value, field, allowedSlots) {
  const argv = splitCommand(/** @type {any} */ (value));
  if (!argv.ok) return [`${field}: ${argv.error.message}`];
  const unknown = slotsIn(argv.value).filter((s) => !allowedSlots.includes(s));
  return unknown.length
    ? [
        `${field}: unknown slot(s) ${unknown.map((s) => `{${s}}`).join(", ")} (allowed: ${allowedSlots.map((s) => `{${s}}`).join(", ")})`,
      ]
    : [];
}

/** @param {unknown} env @param {string} field */
export function validateEnv(env, field) {
  if (env === undefined) return [];
  if (!isObject(env) || !Object.values(env).every((v) => typeof v === "string"))
    return [`${field}: expected an object of string values`];
  return [];
}

/** @param {unknown} names @param {string} field */
export function validateNames(names, field) {
  if (names === undefined) return [];
  if (
    !Array.isArray(names) ||
    !names.every((n) => typeof n === "string" && /^[A-Za-z_][A-Za-z0-9_()]*$/.test(n))
  )
    return [`${field}: expected an array of environment variable names`];
  return [];
}
