// @ts-check
// Agent task bundles, workspace snapshots and recorded side effects.
//
//   <bundle>/instruction.md   the prompt the agent gets (and nothing else)
//   <bundle>/task.json        which hidden checks decide "resolved", what may change
//   <bundle>/files/           the starting workspace, copied fresh for every sample
//   <bundle>/oracle/          hidden checks; never copied into the agent's workspace
//
// task.json:
//   {
//     "schema": 1,
//     "failToPass": ["add handles a negative second number"],  // fail before, must pass after
//     "passToPass": ["add handles positive numbers"],          // pass before, must still pass
//     "allowedPaths": ["src/**"],        // scope gate: changed files must match one of these
//     "canaries": ["config/keep.json"],  // side-effects gate: must stay byte-identical
//     "git": false,                      // true: workspace starts as a git repo with one commit
//     "testCommand": "node --test --test-reporter=tap oracle/add.check.mjs",
//     "testFormat": "tap",               // tap | junit | json
//     "testReport": "report.xml",        // optional: junit written to a file instead of stdout
//     "oracleMount": "oracle"            // where the hidden checks are placed for the tests gate
//   }
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { splitCommand } from "./argv.mjs";
import { readJson, readOptional } from "./files.mjs";
import { err, ok } from "./result.mjs";
import { resolveInside } from "./sample-io.mjs";

export const TASK_SCHEMA = 1;
export const TASK_FILE = "task.json";
export const INSTRUCTION_FILE = "instruction.md";
export const FILES_DIR = "files";
export const ORACLE_DIR = "oracle";
export const RESULT_FORMATS = Object.freeze(["tap", "junit", "json"]);
const TASK_KEYS = Object.freeze([
  "schema",
  "failToPass",
  "passToPass",
  "allowedPaths",
  "canaries",
  "git",
  "testCommand",
  "testFormat",
  "testReport",
  "oracleMount",
  "description",
]);

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** Relative path that stays inside its base. @param {unknown} p */
export const isContained = (p) =>
  typeof p === "string" &&
  p.length > 0 &&
  !path.isAbsolute(p) &&
  !path.win32.isAbsolute(p) &&
  !p.split(/[\\/]/).includes("..");

/** @param {unknown} v */
const isStringList = (v) =>
  Array.isArray(v) && v.every((s) => typeof s === "string" && s.trim() !== "");

/**
 * Check a parsed task.json. Returns every problem.
 * @param {unknown} task
 * @returns {string[]}
 */
export function validateTask(task) {
  if (!isObject(task)) return ["task.json: expected a JSON object"];
  /** @type {string[]} */
  const e = [];
  if (task.schema !== TASK_SCHEMA) e.push(`schema: expected ${TASK_SCHEMA}`);
  for (const key of Object.keys(task).sort())
    if (!TASK_KEYS.includes(key)) e.push(`${key}: unknown task option`);
  for (const key of ["failToPass", "passToPass"])
    if (task[key] !== undefined && !isStringList(task[key]))
      e.push(`${key}: expected an array of test names`);
  const f2p = isStringList(task.failToPass) ? task.failToPass : [];
  const p2p = isStringList(task.passToPass) ? task.passToPass : [];
  const both = f2p.filter((/** @type {string} */ t) => p2p.includes(t));
  if (both.length) e.push(`tests listed as both fail-to-pass and pass-to-pass: ${both.join(", ")}`);
  for (const key of ["allowedPaths", "canaries"])
    if (
      task[key] !== undefined &&
      !(isStringList(task[key]) && task[key].every((/** @type {string} */ p) => isContained(p)))
    )
      e.push(`${key}: expected an array of paths relative to the workspace`);
  if (task.git !== undefined && typeof task.git !== "boolean")
    e.push("git: expected true or false");
  if (task.testCommand !== undefined) {
    const argv = splitCommand(task.testCommand);
    if (!argv.ok) e.push(`testCommand: ${argv.error.message}`);
  }
  if (task.testFormat !== undefined && !RESULT_FORMATS.includes(task.testFormat))
    e.push(`testFormat: expected one of ${RESULT_FORMATS.join("|")}`);
  for (const key of ["testReport", "oracleMount"])
    if (task[key] !== undefined && !isContained(task[key]))
      e.push(`${key}: expected a path relative to the workspace`);
  if (task.description !== undefined && typeof task.description !== "string")
    e.push("description: expected a string");
  return e;
}

/** @param {string} p */
async function isDir(p) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * @typedef {{
 *   bundleDir: string, task: any, instruction: string,
 *   filesDir: string, oracleDir: string | undefined,
 * }} TaskBundle
 */

/**
 * Load and check one task bundle.
 * @param {string} bundleDir
 * @returns {Promise<import("./result.mjs").Result<TaskBundle>>}
 */
export async function loadTask(bundleDir) {
  const name = path.basename(bundleDir);
  const json = await readJson(path.join(bundleDir, TASK_FILE));
  if (!json.ok)
    return err(
      "TASK_INVALID",
      json.error.code === "NOT_FOUND"
        ? `task ${name}: no ${TASK_FILE} (a task bundle needs instruction.md, task.json and files/)`
        : `task ${name}: ${json.error.message}`,
    );
  const problems = validateTask(json.value);
  const instruction = await readOptional(path.join(bundleDir, INSTRUCTION_FILE));
  if (!instruction.ok) return instruction;
  if (instruction.value === undefined || instruction.value.trim() === "")
    problems.push(`${INSTRUCTION_FILE}: missing or empty`);
  const filesDir = path.join(bundleDir, FILES_DIR);
  if (!(await isDir(filesDir))) problems.push(`${FILES_DIR}/: missing (the starting workspace)`);
  else
    for (const c of isStringList(json.value?.canaries) ? json.value.canaries : [])
      if (
        !(await stat(path.join(filesDir, c)).then(
          (s) => s.isFile(),
          () => false,
        ))
      )
        problems.push(`canaries: ${c} is not a file in ${FILES_DIR}/`);
  if (problems.length) return err("TASK_INVALID", `task ${name}: ${problems.join("; ")}`, problems);
  const oracleDir = path.join(bundleDir, ORACLE_DIR);
  return ok({
    bundleDir,
    task: json.value,
    instruction: /** @type {string} */ (instruction.value),
    filesDir,
    oracleDir: (await isDir(oracleDir)) ? oracleDir : undefined,
  });
}

/** @param {Uint8Array} bytes */
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Hash every file under a path (a single file is hashed under its own name).
 * Unlike the protocol hash this accepts any bytes: it records what an agent
 * did, it does not freeze inputs. Missing paths give an empty snapshot.
 * @param {string} target
 * @param {{ exclude?: (rel: string) => boolean }} [options]
 * @returns {Promise<Record<string, string>>}
 */
export async function snapshotTree(target, { exclude = () => false } = {}) {
  /** @type {Record<string, string>} */
  const out = {};
  let info;
  try {
    info = await stat(target);
  } catch {
    return out;
  }
  if (info.isFile()) {
    out[path.basename(target)] = sha256(await readFile(target));
    return out;
  }
  /** @param {string} abs @param {string} rel */
  const walk = async (abs, rel) => {
    const entries = await readdir(abs, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (exclude(childRel)) continue;
      const childAbs = path.join(abs, entry.name);
      if (entry.isDirectory()) await walk(childAbs, childRel);
      else if (entry.isSymbolicLink()) out[childRel] = "symlink";
      else if (entry.isFile()) out[childRel] = sha256(await readFile(childAbs));
    }
  };
  await walk(target, "");
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * What changed between two snapshots.
 * @param {Record<string, string>} before
 * @param {Record<string, string>} after
 */
export function diffSnapshots(before, after) {
  const added = Object.keys(after).filter((p) => !Object.hasOwn(before, p));
  const deleted = Object.keys(before).filter((p) => !Object.hasOwn(after, p));
  const modified = Object.keys(after).filter(
    (p) => Object.hasOwn(before, p) && before[p] !== after[p],
  );
  /** @param {string[]} xs */
  const sorted = (xs) => xs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { added: sorted(added), modified: sorted(modified), deleted: sorted(deleted) };
}

/**
 * A glob as a regular expression over posix paths: `**` crosses folders,
 * `*` and `?` stay inside one. A pattern without wildcards also matches
 * everything under it ("src" = "src/**").
 * @param {string} glob
 */
export function globToRegExp(glob) {
  const g = glob.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const literal = !/[*?]/.test(g);
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const ch = /** @type {string} */ (g[i]);
    if (ch === "*" && g[i + 1] === "*") {
      const slash = g[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(literal ? `^${re}(?:/.*)?$` : `^${re}$`);
}

/** @param {string} file @param {readonly string[]} globs */
export const matchesAny = (file, globs) => globs.some((g) => globToRegExp(g).test(file));

/** Everything the agent adapter recorded about what a sample changed. */
export const EFFECTS_FILE = "effects.json";

/**
 * Read a sample's effects.json (written by the agent adapter).
 * @param {string} studyDir
 * @param {any} sample
 * @returns {Promise<import("./result.mjs").Result<any>>}
 */
export async function readEffects(studyDir, sample) {
  const file = resolveInside(studyDir, sample?.info?.effectsPath);
  if (!file.ok)
    return err(
      "EFFECTS_MISSING",
      "this sample recorded no workspace changes (only the agent adapter records them)",
    );
  return readJson(file.value);
}
