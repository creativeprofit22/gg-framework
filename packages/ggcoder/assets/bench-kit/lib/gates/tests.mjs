// @ts-check
// tests: run the task's hidden checks against what the agent left behind.
// Resolved only if EVERY fail-to-pass test (broken before, must pass now) and
// EVERY pass-to-pass test (worked before, must still work) passes. A listed
// test that did not run counts as not passing. A task that lists no tests at
// all is invalid (zero tests would make every attempt look resolved), and a
// run whose results cannot be read is errored, never passed.
//
// The checks run on a COPY of the agent's workspace with oracle/ placed in
// it, so the recorded workspace stays as the agent left it. Usually declared
// with "severity": "record": an unresolved task is the outcome being
// measured (feed it into a metric with source "gate"), not a disqualification.
//
//   { "id": "hidden-tests", "type": "tests", "severity": "record" }
//   optional: "command" / "format" / "reportFile" override task.json's
//   testCommand / testFormat / testReport; slots {workspace} {oracle} {project}
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { fillSlots, slotsIn, splitCommand } from "../argv.mjs";
import { parseResults, statusOf } from "../check-results.mjs";
import { resolveInside } from "../sample-io.mjs";
import { runProcess, scrubEnv } from "../sandbox/process.mjs";
import { isContained, loadTask, ORACLE_DIR, RESULT_FORMATS } from "../task.mjs";
import {
  DEFAULT_GATE_TIMEOUT_MS,
  errored,
  failed,
  lastLines,
  pass,
  scopeOf,
  unknownKeys,
  validateTimeout,
  withValue,
} from "./common.mjs";

export const TESTS_SLOTS = Object.freeze(["workspace", "oracle", "project"]);

/** @param {any} g */
export function validate(g) {
  const e = unknownKeys(g, ["command", "format", "reportFile", "timeoutMs", "passEnv"]);
  if (scopeOf(g) !== "sample")
    e.push('scope: tests gates check one agent sample at a time ("sample")');
  if (g.command !== undefined) {
    const argv = splitCommand(g.command);
    if (!argv.ok) e.push(`command: ${argv.error.message}`);
    else {
      const unknown = slotsIn(argv.value).filter((s) => !TESTS_SLOTS.includes(s));
      if (unknown.length)
        e.push(
          `command: unknown slot(s) ${unknown.map((s) => `{${s}}`).join(", ")} (allowed: ${TESTS_SLOTS.map((s) => `{${s}}`).join(", ")})`,
        );
    }
  }
  if (g.format !== undefined && !RESULT_FORMATS.includes(g.format))
    e.push(`format: expected one of ${RESULT_FORMATS.join("|")}`);
  if (g.reportFile !== undefined && !isContained(g.reportFile))
    e.push("reportFile: expected a path relative to the workspace");
  e.push(...validateTimeout(g.timeoutMs));
  if (
    g.passEnv !== undefined &&
    !(
      Array.isArray(g.passEnv) &&
      g.passEnv.every((/** @type {unknown} */ n) => typeof n === "string")
    )
  )
    e.push("passEnv: expected an array of variable names");
  return e;
}

/** @param {string} s */
const safe = (s) => s.replace(/[^A-Za-z0-9_.-]/g, "_");

/** @param {string[]} names @param {(name: string) => string} statusFor */
function tally(names, statusFor) {
  const bad = names.filter((n) => statusFor(n) !== "pass");
  return { passed: names.length - bad.length, total: names.length, bad };
}

/** @param {string[]} bad @param {(name: string) => string} statusFor */
const listBad = (bad, statusFor) =>
  bad
    .slice(0, 5)
    .map((n) => `${n} (${statusFor(n) === "missing" ? "did not run" : statusFor(n)})`)
    .join(", ") + (bad.length > 5 ? `, and ${bad.length - 5} more` : "");

/** @param {import("./common.mjs").GateContext} ctx @returns {Promise<import("./common.mjs").GateResult>} */
export async function check(ctx) {
  const info = ctx.sample?.info ?? {};
  const workspace = resolveInside(ctx.studyDir, info.workspaceDir);
  const taskDir = resolveInside(ctx.studyDir, info.taskDir);
  if (!workspace.ok || !taskDir.ok)
    return errored("this sample has no agent workspace; tests gates need the agent adapter");
  const loaded = await loadTask(taskDir.value);
  if (!loaded.ok) return errored(loaded.error.message);
  const { task, oracleDir } = loaded.value;
  const f2p = /** @type {string[]} */ (task.failToPass ?? []);
  const p2p = /** @type {string[]} */ (task.passToPass ?? []);
  if (f2p.length + p2p.length === 0)
    return errored(
      "invalid task: it lists no fail-to-pass or pass-to-pass tests, and zero tests would count every attempt as resolved",
    );
  const command = ctx.gate.command ?? task.testCommand;
  const format = ctx.gate.format ?? task.testFormat;
  const reportFile = ctx.gate.reportFile ?? task.testReport;
  if (command === undefined)
    return errored("no test command: set command on the gate or testCommand in task.json");
  if (format === undefined)
    return errored("no result format: set format on the gate or testFormat in task.json");

  const tag = `${safe(ctx.gate.id)}-${String(ctx.sample?.index ?? 0).padStart(5, "0")}-${safe(ctx.candidate)}-${safe(String(ctx.sample?.item))}`;
  const root = path.join(ctx.workDir, tag);
  const copy = path.join(root, "workspace");
  const mount = path.join(copy, task.oracleMount ?? ORACLE_DIR);
  await rm(root, { recursive: true, force: true });
  await mkdir(path.join(root, "tmp"), { recursive: true });
  try {
    await cp(workspace.value, copy, { recursive: true });
    if (oracleDir) await cp(oracleDir, mount, { recursive: true, force: true });
  } catch (error) {
    return errored(
      `could not prepare the checks: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const argv = splitCommand(command);
  if (!argv.ok) return errored(`test command: ${argv.error.message}`);
  const filled = fillSlots(argv.value, {
    workspace: copy,
    oracle: mount,
    project: ctx.projectDir,
  });
  if (!filled.ok) return errored(`test command: ${filled.error.message}`);
  const timeoutMs = ctx.gate.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  const stdoutFile = path.join(root, "stdout.txt");
  const r = await runProcess(filled.value, {
    cwd: copy,
    env: scrubEnv(ctx.env ?? process.env, {
      pass: ctx.gate.passEnv ?? [],
      tmpDir: path.join(root, "tmp"),
    }),
    timeoutMs,
    signal: ctx.signal,
    stdoutFile,
    stderrFile: path.join(root, "stderr.txt"),
  });
  if (r.spawnError) return errored(`test command: ${r.spawnError.message}`);
  if (r.timedOut) return errored(`the hidden tests ran past ${timeoutMs} ms`);
  if (r.aborted) return errored("gate check was stopped");

  let text = "";
  try {
    text = await readFile(reportFile ? path.join(copy, reportFile) : stdoutFile, "utf8");
  } catch {
    if (reportFile)
      return errored(`the test run wrote no ${reportFile} (exit ${r.exitCode ?? r.signal})`);
    text = r.stdoutTail;
  }
  const parsed = parseResults(text, format);
  if (!parsed.ok) return errored(parsed.error.message);
  if (parsed.value.length === 0)
    return errored(
      `the test run produced no ${format} results it could read (exit ${r.exitCode ?? r.signal})${r.stderrTail.trim() ? `: ${lastLines(r.stderrTail)}` : ""}`,
    );
  const statusFor = (/** @type {string} */ n) => statusOf(parsed.value, n);
  const f = tally(f2p, statusFor);
  const p = tally(p2p, statusFor);
  const counts = `fail-to-pass ${f.passed}/${f.total}, pass-to-pass ${p.passed}/${p.total}`;
  if (f.bad.length === 0 && p.bad.length === 0)
    return withValue(pass(`resolved: ${counts} pass`), 1);
  return withValue(
    failed(`not resolved: ${counts}; not passing: ${listBad([...f.bad, ...p.bad], statusFor)}`),
    0,
  );
}
