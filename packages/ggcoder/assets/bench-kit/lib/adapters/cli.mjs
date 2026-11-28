// @ts-check
// CLI adapter: run a command per sample, hyperfine-style. `prepare` runs
// before every sample and `cleanup` after it; neither is timed. Commands are
// split into argv and run WITHOUT a shell; slots are filled per argument:
//
//   {input} {inputDir}  copy of the workload item     {out} {outDir}  output file / folder
//   {expected}          the item's expected file       {tmp}           private temp folder
//   {item} {candidate} {repeat}                        {project} {workload}
//
// A non-zero exit is the candidate's behaviour, not a harness error: it is
// recorded (exitCode) and judged by the exit-code gate. Harness problems
// (command not found, timeout, prepare/cleanup failing) make the sample
// errored, which counts against the candidate's error rate.
import { performance } from "node:perf_hooks";
import path from "node:path";

import { fillSlots, splitCommand } from "../argv.mjs";
import { CONTAINER, dockerRunArgv } from "../sandbox/docker.mjs";
import { prepareSample, runProcess, scrubEnv, treeSize } from "../sandbox/process.mjs";
import {
  done,
  fail,
  isContainedRelative,
  relPosix,
  validateCommand,
  validateEnv,
  validateNames,
} from "./common.mjs";

export const CLI_SLOTS = Object.freeze([
  "input",
  "inputDir",
  "out",
  "outDir",
  "expected",
  "tmp",
  "item",
  "candidate",
  "repeat",
  "project",
  "workload",
]);

/** @param {any} a @returns {string[]} */
export function validate(a) {
  /** @type {string[]} */
  const e = [];
  if (a.command === undefined) e.push("command: required");
  else e.push(...validateCommand(a.command, "command", CLI_SLOTS));
  for (const hook of ["prepare", "cleanup"])
    if (a[hook] !== undefined) e.push(...validateCommand(a[hook], hook, CLI_SLOTS));
  if (a.cwd !== undefined && !(a.cwd === "." || isContainedRelative(a.cwd)))
    e.push("cwd: expected a folder relative to the project");
  if (
    a.outputExt !== undefined &&
    !(typeof a.outputExt === "string" && /^(\.[A-Za-z0-9]{1,12})?$/.test(a.outputExt))
  )
    e.push("outputExt: expected an extension such as .mp4");
  e.push(...validateEnv(a.env, "env"), ...validateNames(a.passEnv, "passEnv"));
  return e;
}

/**
 * @param {import("./common.mjs").AdapterJob} job
 * @returns {Promise<import("./common.mjs").SampleResult>}
 */
export async function runSample(job) {
  const a = job.adapter;
  const docker = job.sandbox.type === "docker";
  if (docker && !job.sandbox.available)
    return fail(
      "SANDBOX_UNAVAILABLE",
      job.sandbox.reason ?? "docker sandbox requested but docker was not detected",
    );
  if (docker && !job.sandbox.image)
    return fail("SANDBOX_UNAVAILABLE", "docker sandbox needs an image");
  const deadline = performance.now() + job.timeoutMs;
  const remaining = () => Math.max(1, Math.round(deadline - performance.now()));

  const s = await prepareSample({
    sampleDir: job.sampleDir,
    item: job.item,
    outputExt: a.outputExt ?? "",
  });
  const base = path.resolve(job.projectDir, a.cwd ?? ".");
  const inContainer = (
    /** @type {string | undefined} */ hostPath,
    /** @type {string} */ root,
    /** @type {string} */ mount,
  ) =>
    hostPath === undefined ? undefined : `${mount}/${relPosix(root, hostPath)}`.replace(/\/$/, "");
  /** @type {Record<string, string | undefined>} */
  const slots = docker
    ? {
        input: inContainer(s.inputPath, s.inputDir, CONTAINER.input),
        inputDir: CONTAINER.input,
        out: inContainer(s.outPath, s.outDir, CONTAINER.out),
        outDir: CONTAINER.out,
        expected: s.expectedPath
          ? `${CONTAINER.expected}/${path.basename(s.expectedPath)}`
          : undefined,
        tmp: "/tmp",
        project: CONTAINER.project,
        workload: undefined,
      }
    : {
        input: s.inputPath,
        inputDir: s.inputDir,
        out: s.outPath,
        outDir: s.outDir,
        expected: s.expectedPath,
        tmp: s.tmpDir,
        project: job.projectDir,
        workload: job.workloadDir,
      };
  Object.assign(slots, {
    item: job.item.id,
    candidate: job.candidate.id,
    repeat: String(job.repeat),
  });

  const env = scrubEnv(/** @type {Record<string, string | undefined>} */ (process.env), {
    pass: a.passEnv ?? [],
    set: a.env ?? {},
    tmpDir: s.tmpDir,
  });
  /** @param {unknown} template */
  const argvFor = (template) => {
    const split = splitCommand(/** @type {any} */ (template));
    if (!split.ok) return split;
    const filled = fillSlots(split.value, slots);
    if (!filled.ok || !docker) return filled;
    const workdir = `${CONTAINER.project}/${relPosix(job.projectDir, base)}`.replace(/\/\.?$/, "");
    return {
      ok: /** @type {const} */ (true),
      value: dockerRunArgv({
        image: /** @type {string} */ (job.sandbox.image),
        argv: filled.value,
        projectDir: job.projectDir,
        inputDir: s.inputDir,
        outDir: s.outDir,
        expectedDir: s.expectedPath ? path.dirname(s.expectedPath) : undefined,
        workdir,
        network: job.sandbox.network,
        memory: job.sandbox.memory,
        pids: job.sandbox.pids,
        cpus: job.sandbox.cpus,
        env: a.env ?? {},
        passEnv: a.passEnv ?? [],
      }),
    };
  };
  /** @param {string} name @param {unknown} template */
  const hook = async (name, template) => {
    const argv = argvFor(template);
    if (!argv.ok) return fail("SLOT_UNAVAILABLE", `${name}: ${argv.error.message}`);
    const r = await runProcess(argv.value, {
      cwd: base,
      env,
      timeoutMs: remaining(),
      stdoutFile: path.join(job.sampleDir, `${name}.stdout.txt`),
      stderrFile: path.join(job.sampleDir, `${name}.stderr.txt`),
    });
    if (r.spawnError) return fail(r.spawnError.code, `${name}: ${r.spawnError.message}`);
    if (r.timedOut) return fail("TIMEOUT", `${name} ran past the ${job.timeoutMs} ms sample limit`);
    if (r.exitCode !== 0)
      return fail(
        `${name.toUpperCase()}_FAILED`,
        `${name} exited ${r.exitCode ?? r.signal}: ${r.stderrTail.trim().split("\n").slice(-3).join(" | ")}`,
      );
    return undefined;
  };

  if (a.prepare !== undefined) {
    const problem = await hook("prepare", a.prepare);
    if (problem) return problem;
  }
  const argv = argvFor(a.command);
  if (!argv.ok) return fail("SLOT_UNAVAILABLE", `command: ${argv.error.message}`);
  const r = await runProcess(argv.value, {
    cwd: base,
    env,
    timeoutMs: remaining(),
    stdoutFile: path.join(job.sampleDir, "stdout.txt"),
    stderrFile: path.join(job.sampleDir, "stderr.txt"),
    sampleMemory: !docker,
  });
  if (r.spawnError) return fail(r.spawnError.code, r.spawnError.message);
  if (r.timedOut) return fail("TIMEOUT", `command ran past the ${job.timeoutMs} ms sample limit`);
  const outputBytes = await treeSize(s.outDir);
  if (a.cleanup !== undefined) {
    const problem = await hook("cleanup", a.cleanup);
    if (problem) return problem;
  }
  const memory = r.memory;
  return done(
    {
      wallMs: r.wallMs,
      peakMemoryBytes: memory?.peakBytes,
      outputBytes,
      stdoutBytes: r.stdoutBytes,
      exitCode: r.exitCode ?? undefined,
    },
    {
      timing: "process wall time, spawn to exit",
      exitCode: r.exitCode,
      signal: r.signal,
      stdoutTail: r.stdoutTail,
      stderrTail: r.stderrTail,
      truncated: r.truncated,
      peakMemory: memory
        ? { method: memory.method, label: memory.label, readings: memory.readings }
        : { method: "none", label: docker ? "unmeasured in docker" : "unmeasured" },
      sampleDir: relPosix(job.studyDir, job.sampleDir),
      stdoutPath: relPosix(job.studyDir, path.join(job.sampleDir, "stdout.txt")),
      outPath: relPosix(job.studyDir, s.outPath),
      outDir: relPosix(job.studyDir, s.outDir),
    },
  );
}
