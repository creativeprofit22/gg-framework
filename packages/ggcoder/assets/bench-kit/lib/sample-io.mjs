// @ts-check
// Read what a recorded sample left behind (output file, stdout) and pull
// fields out of it. Shared by gates and metrics. Paths recorded in
// samples.jsonl are relative to the study folder and must stay inside it.
import { readFile } from "node:fs/promises";
import path from "node:path";

import { err, ok } from "./result.mjs";

/** Output sources a gate or metric can read. */
export const SOURCES = Object.freeze(["output", "stdout"]);

/**
 * Resolve a study-relative path recorded in a sample; refuse escapes.
 * @param {string} studyDir
 * @param {unknown} relative
 * @returns {import("./result.mjs").Result<string>}
 */
export function resolveInside(studyDir, relative) {
  if (typeof relative !== "string" || relative.length === 0)
    return err("PATH_MISSING", "the sample recorded no path");
  const full = path.resolve(studyDir, relative);
  const rel = path.relative(path.resolve(studyDir), full);
  if (rel.startsWith("..") || path.isAbsolute(rel))
    return err("PATH_OUTSIDE", `recorded path ${relative} leaves the study folder`);
  return ok(full);
}

/**
 * Absolute path of a sample's output file, when it recorded one.
 * @param {any} sample
 * @param {string} studyDir
 */
export const outputPath = (sample, studyDir) => resolveInside(studyDir, sample?.info?.outPath);

/**
 * Bytes of a sample's output or stdout. Stdout falls back to the captured
 * tail only when no full capture file exists, and says so.
 * @param {any} sample
 * @param {string} studyDir
 * @param {"output" | "stdout"} source
 * @returns {Promise<import("./result.mjs").Result<{ bytes: Buffer, from: string }>>}
 */
export async function readSource(sample, studyDir, source) {
  if (source === "stdout") {
    const file = resolveInside(studyDir, sample?.info?.stdoutPath);
    if (file.ok) {
      try {
        return ok({ bytes: await readFile(file.value), from: "stdout" });
      } catch {
        // fall through to the tail
      }
    }
    if (typeof sample?.info?.stdoutTail === "string")
      return ok({ bytes: Buffer.from(sample.info.stdoutTail, "utf8"), from: "stdout (last 8 KB)" });
    return err("SOURCE_MISSING", "this adapter recorded no stdout");
  }
  const file = outputPath(sample, studyDir);
  if (!file.ok) return err("SOURCE_MISSING", "this sample saved no output file");
  try {
    return ok({ bytes: await readFile(file.value), from: "output" });
  } catch (error) {
    return err(
      "SOURCE_MISSING",
      `output file is gone (${/** @type {NodeJS.ErrnoException} */ (error).code ?? "unreadable"}); a cleanup hook may have deleted it`,
    );
  }
}

/**
 * Parse JSON from tool output: the whole text, else the last line that is a
 * JSON object or array (tools often log before printing their result).
 * @param {string} text
 * @returns {import("./result.mjs").Result<unknown>}
 */
export function parseJsonOutput(text) {
  const trimmed = text.trim();
  if (!trimmed) return err("JSON_MISSING", "output is empty");
  try {
    return ok(JSON.parse(trimmed));
  } catch {
    const lines = trimmed.split(/\r?\n/).reverse();
    for (const line of lines) {
      const t = line.trim();
      if (!/^[[{]/.test(t)) continue;
      try {
        return ok(JSON.parse(t));
      } catch {
        // keep looking
      }
    }
    return err("JSON_MISSING", "output contains no JSON object");
  }
}

const FIELD = /^[A-Za-z_$][\w$-]*(\[\d+\])*(\.[A-Za-z_$][\w$-]*(\[\d+\])*)*$/;

/** @param {unknown} field */
export const isFieldPath = (field) => typeof field === "string" && FIELD.test(field);

/**
 * Read a dotted path such as `pooled_metrics.vmaf.mean` or `frames[0].vmaf`.
 * @param {unknown} value
 * @param {string} field
 * @returns {unknown}
 */
export function getField(value, field) {
  /** @type {any} */
  let cur = value;
  for (const part of field.split(".")) {
    const m = /^([^[]+)((?:\[\d+\])*)$/.exec(part);
    if (!m) return undefined;
    cur =
      cur !== null && typeof cur === "object" && Object.hasOwn(cur, /** @type {string} */ (m[1]))
        ? cur[/** @type {string} */ (m[1])]
        : undefined;
    for (const idx of (m[2] ?? "").matchAll(/\[(\d+)\]/g))
      cur = Array.isArray(cur) ? cur[Number(idx[1])] : undefined;
    if (cur === undefined) return undefined;
  }
  return cur;
}

/**
 * A finite number from a JSON value (numeric strings accepted).
 * @param {unknown} v
 * @returns {number | undefined}
 */
export function toNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}
