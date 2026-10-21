// @ts-check
// Agent adapter: run a headless coding agent on one task bundle per sample.
//
//   workspace/   fresh copy of the bundle's files/ (the agent's cwd)
//   prompt.md    exactly what the agent was asked (instruction.md)
//   stdout.txt   the agent's full event stream     stderr.txt
//   final.txt    its closing message               calls.json  its tool calls
//   effects.json what changed: workspace diff, canaries, git history, and
//                anything outside the sandbox that was watched
//
// The hidden checks (oracle/) are never copied into the workspace; the tests
// gate runs them later on a copy. Presets:
//   ggcoder  <bin> --json [--provider P] [--model M] [--max-turns N] [extraArgs] -- <prompt>
//   claude   <bin> -p --output-format stream-json --verbose [--model M] [--max-turns N] [extraArgs] -- <prompt>
// The agent's cwd is its workspace, so `bin`, `extraArgs` and `command` reach
// project files through slots: ["node", "{project}/tools/ggcoder/dist/cli.js"]
// (on Windows, .cmd shims such as `ggcoder` or `claude` cannot run without a
// shell; point bin at node and the CLI's script instead).
// Any other agent CLI: a `command` template with {prompt} or {promptFile}
// and a declared `format`. No preset ever runs an agent the study did not
// name; API keys reach it only through `passEnv`.
//
// How a run ended comes from terminal events only (see transcript.mjs):
//   finished or out of turns -> a completed sample (the gates judge it)
//   agent error, no final event, timeout, crash -> an errored sample
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { fillSlots, splitCommand } from "../argv.mjs";
import { estimateCost, priceKey } from "../cost.mjs";
import { prepareSample, runProcess, scrubEnv } from "../sandbox/process.mjs";
import { diffSnapshots, EFFECTS_FILE, isContained, loadTask, snapshotTree } from "../task.mjs";
import { AGENT_FORMATS, parseTranscript, totalTokens } from "../transcript.mjs";
import { done, fail, relPosix, validateCommand, validateEnv, validateNames } from "./common.mjs";

export const AGENT_PRESETS = Object.freeze({
  ggcoder: { format: "ggcoder-json", bin: Object.freeze(["ggcoder"]) },
  claude: { format: "claude-stream-json", bin: Object.freeze(["claude"]) },
});
export const AGENT_SLOTS = Object.freeze([
  "prompt",
  "promptFile",
  "workspace",
  "model",
  "provider",
  "maxTurns",
  "tmp",
  "item",
  "candidate",
  "repeat",
  "project",
]);
const KEYS = Object.freeze([
  "type",
  "preset",
  "bin",
  "command",
  "format",
  "provider",
  "model",
  "maxTurns",
  "extraArgs",
  "env",
  "passEnv",
  "pricing",
  "watch",
]);
const GIT_IDENTITY = Object.freeze({
  GIT_AUTHOR_NAME: "bench",
  GIT_AUTHOR_EMAIL: "bench@localhost",
  GIT_COMMITTER_NAME: "bench",
  GIT_COMMITTER_EMAIL: "bench@localhost",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
});

/** @param {any} a @returns {string[]} */
export function validate(a) {
  /** @type {string[]} */
  const e = Object.keys(a)
    .filter((k) => !KEYS.includes(k))
    .sort()
    .map((k) => `${k}: unknown option for an agent adapter`);
  const hasPreset = a.preset !== undefined;
  const hasCommand = a.command !== undefined;
  if (hasPreset === hasCommand)
    e.push(
      `set exactly one of preset (${Object.keys(AGENT_PRESETS).join("|")}) or command (any other agent CLI)`,
    );
  if (hasPreset) {
    if (!Object.hasOwn(AGENT_PRESETS, a.preset))
      e.push(`preset: expected one of ${Object.keys(AGENT_PRESETS).join("|")}`);
    if (a.format !== undefined) e.push("format: set by the preset; remove it");
    if (a.bin !== undefined) e.push(...validateCommand(a.bin, "bin", AGENT_SLOTS));
    if (a.extraArgs !== undefined) {
      if (!(
        Array.isArray(a.extraArgs) &&
        a.extraArgs.every((/** @type {unknown} */ x) => typeof x === "string")
      ))
        e.push("extraArgs: expected an array of strings");
      else if (a.extraArgs.length)
        e.push(...validateCommand(a.extraArgs, "extraArgs", AGENT_SLOTS));
    }
  }
  if (hasCommand) {
    e.push(...validateCommand(a.command, "command", AGENT_SLOTS));
    const argv = splitCommand(a.command);
    if (argv.ok && !argv.value.some((arg) => /\{prompt(File)?\}/.test(arg)))
      e.push("command: must pass the task with {prompt} or {promptFile}");
    if (!AGENT_FORMATS.includes(a.format))
      e.push(`format: expected one of ${AGENT_FORMATS.join("|")}`);
    for (const k of ["bin", "extraArgs"])
      if (a[k] !== undefined) e.push(`${k}: only applies to presets; put it in command`);
  }
  for (const k of ["provider", "model", "pricing"])
    if (a[k] !== undefined && (typeof a[k] !== "string" || !a[k].trim()))
      e.push(`${k}: expected a non-empty string`);
  if (a.maxTurns !== undefined && !(Number.isInteger(a.maxTurns) && a.maxTurns > 0))
    e.push("maxTurns: expected a positive integer");
  if (
    a.watch !== undefined &&
    !(Array.isArray(a.watch) && a.watch.every((/** @type {unknown} */ p) => isContained(p)))
  )
    e.push("watch: expected paths relative to the project");
  e.push(...validateEnv(a.env, "env"), ...validateNames(a.passEnv, "passEnv"));
  return e;
}

/**
 * The agent's argv and output format.
 * @param {any} a
 * @param {Record<string, string | undefined>} slots
 * @returns {import("../result.mjs").Result<{ argv: string[], format: string }>}
 */
export function agentArgv(a, slots) {
  if (a.command !== undefined) {
    const split = splitCommand(a.command);
    if (!split.ok) return split;
    const filled = fillSlots(split.value, slots);
    if (!filled.ok) return filled;
    return { ok: true, value: { argv: filled.value, format: a.format } };
  }
  const preset = AGENT_PRESETS[/** @type {keyof typeof AGENT_PRESETS} */ (a.preset)];
  // The agent's cwd is its workspace, so bin and extraArgs may use slots
  // such as {project} to reach files in the project.
  const split = a.bin === undefined ? { ok: true, value: [...preset.bin] } : splitCommand(a.bin);
  if (!split.ok) return /** @type {any} */ (split);
  const bin = fillSlots(/** @type {string[]} */ (split.value), slots);
  if (!bin.ok) return bin;
  const extra = fillSlots(a.extraArgs ?? [], slots);
  if (!extra.ok) return extra;
  const flags =
    a.preset === "ggcoder"
      ? [
          "--json",
          ...(a.provider ? ["--provider", a.provider] : []),
          ...(a.model ? ["--model", a.model] : []),
        ]
      : [
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
          ...(a.model ? ["--model", a.model] : []),
        ];
  return {
    ok: true,
    value: {
      argv: [
        ...bin.value,
        ...flags,
        ...(a.maxTurns ? ["--max-turns", String(a.maxTurns)] : []),
        ...extra.value,
        "--",
        /** @type {string} */ (slots.prompt),
      ],
      format: preset.format,
    },
  };
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @param {number} timeoutMs
 */
async function git(args, cwd, timeoutMs) {
  const env = scrubEnv(/** @type {Record<string, string | undefined>} */ (process.env), {
    set: { ...GIT_IDENTITY },
  });
  const r = await runProcess(["git", ...args], { cwd, env, timeoutMs });
  return r.exitCode === 0
    ? { ok: true, stdout: r.stdoutTail.trim() }
    : {
        ok: false,
        stdout: "",
        error: r.spawnError?.message ?? (r.stderrTail.trim() || `git ${args[0]} failed`),
      };
}

/**
 * HEAD, commit count and every ref, so the side-effects gate can tell
 * whether the agent rewrote history.
 * @param {string} cwd
 */
async function gitFacts(cwd) {
  const head = await git(["rev-parse", "HEAD"], cwd, 15_000);
  if (!head.ok) return { error: head.error };
  const count = await git(["rev-list", "--all", "--count"], cwd, 15_000);
  const refs = await git(["for-each-ref", "--format=%(refname) %(objectname)"], cwd, 15_000);
  return {
    head: head.stdout,
    commits: count.ok ? Number(count.stdout) : null,
    refs: refs.ok ? refs.stdout.split("\n").filter(Boolean).sort() : null,
  };
}

/**
 * The useful part of an agent's stderr: its error line when there is one
 * (a crash ends with a stack and a runtime banner), else the last lines.
 * @param {string} tail
 */
export function stderrSummary(tail) {
  const lines = tail
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^Node\.js v\d/.test(l));
  if (lines.length === 0) return "";
  const errorLine = lines.find((l) => /^(\w*Error|error)\b/.test(l));
  return `; stderr: ${errorLine ?? lines.slice(-3).join(" | ")}`;
}

/**
 * @param {import("./common.mjs").AdapterJob} job
 * @returns {Promise<import("./common.mjs").SampleResult>}
 */
export async function runSample(job) {
  const a = job.adapter;
  if (job.sandbox.type === "docker")
    return fail(
      "SANDBOX_UNSUPPORTED",
      "the agent adapter runs agents as local processes; it cannot run them in the docker sandbox",
    );
  if (!job.item.input)
    return fail(
      "TASK_MISSING",
      `workload item ${job.item.id} has no input; agent items point at a task bundle folder`,
    );
  const loaded = await loadTask(job.item.input);
  if (!loaded.ok) return fail(loaded.error.code, loaded.error.message);
  const bundle = loaded.value;
  const task = bundle.task;
  const deadline = performance.now() + job.timeoutMs;
  const remaining = () => Math.max(1, Math.round(deadline - performance.now()));

  // An empty input dir: the bundle (with its hidden checks) is NOT copied in.
  const s = await prepareSample({ sampleDir: job.sampleDir, item: {} });
  const workspace = path.join(job.sampleDir, "workspace");
  await mkdir(workspace, { recursive: true });
  await cp(bundle.filesDir, workspace, { recursive: true });

  /** @type {any} */
  let gitBefore;
  if (task.git === true) {
    for (const args of [
      ["init", "-q"],
      ["add", "-A"],
      ["-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "task baseline"],
    ]) {
      const r = await git(args, workspace, 30_000);
      if (!r.ok) return fail("GIT_UNAVAILABLE", `task asks for a git workspace: ${r.error}`);
    }
    gitBefore = await gitFacts(workspace);
    if (gitBefore.error) return fail("GIT_UNAVAILABLE", gitBefore.error);
  }

  const notGit = (/** @type {string} */ rel) => rel === ".git" || rel.startsWith(".git/");
  const watchTargets = [
    { label: `workload/${relPosix(job.workloadDir, bundle.bundleDir)}`, abs: bundle.bundleDir },
    ...(a.watch ?? []).map((/** @type {string} */ w) => ({
      label: `project/${w.replace(/\\/g, "/")}`,
      abs: path.resolve(job.projectDir, w),
    })),
  ];
  const before = await snapshotTree(workspace, { exclude: notGit });
  const outsideBefore = await Promise.all(watchTargets.map((t) => snapshotTree(t.abs)));

  const promptFile = path.join(job.sampleDir, "prompt.md");
  await writeFile(promptFile, bundle.instruction);
  const built = agentArgv(a, {
    prompt: bundle.instruction,
    promptFile,
    workspace,
    model: a.model,
    provider: a.provider,
    maxTurns: a.maxTurns === undefined ? undefined : String(a.maxTurns),
    tmp: s.tmpDir,
    item: job.item.id,
    candidate: job.candidate.id,
    repeat: String(job.repeat),
    project: job.projectDir,
  });
  if (!built.ok) return fail("SLOT_UNAVAILABLE", `command: ${built.error.message}`);

  const env = scrubEnv(/** @type {Record<string, string | undefined>} */ (process.env), {
    pass: a.passEnv ?? [],
    set: a.env ?? {},
    tmpDir: s.tmpDir,
  });
  const stdoutFile = path.join(job.sampleDir, "stdout.txt");
  const r = await runProcess(built.value.argv, {
    cwd: workspace,
    env,
    timeoutMs: remaining(),
    stdoutFile,
    stderrFile: path.join(job.sampleDir, "stderr.txt"),
    sampleMemory: true,
  });

  // Record what changed even when the run failed: it is the evidence.
  const after = await snapshotTree(workspace, { exclude: notGit });
  const changes = diffSnapshots(before, after);
  /** @type {Record<string, string>} */
  const canaries = {};
  for (const c of task.canaries ?? []) {
    const rel = c.replace(/\\/g, "/");
    canaries[rel] = !Object.hasOwn(after, rel)
      ? "deleted"
      : after[rel] === before[rel]
        ? "intact"
        : "modified";
  }
  const outside = [];
  for (const [i, t] of watchTargets.entries()) {
    const diff = diffSnapshots(
      /** @type {Record<string, string>} */ (outsideBefore[i]),
      await snapshotTree(t.abs),
    );
    for (const p of [...diff.added, ...diff.modified, ...diff.deleted])
      outside.push(`${t.label}/${p}`);
  }
  const effects = {
    schema: 1,
    workspace: {
      changes,
      changed: [...changes.added, ...changes.modified, ...changes.deleted].sort(),
    },
    ...(task.allowedPaths ? { allowedPaths: task.allowedPaths } : {}),
    canaries,
    outside: { watched: watchTargets.map((t) => t.label), changed: outside.sort() },
    git: gitBefore ? { before: gitBefore, after: await gitFacts(workspace) } : null,
  };
  await writeFile(path.join(job.sampleDir, EFFECTS_FILE), `${JSON.stringify(effects, null, 2)}\n`);

  if (r.spawnError) return fail(r.spawnError.code, r.spawnError.message);
  if (r.timedOut) return fail("TIMEOUT", `agent ran past the ${job.timeoutMs} ms sample limit`);

  let stdout = "";
  try {
    stdout = await readFile(stdoutFile, "utf8");
  } catch {
    stdout = r.stdoutTail;
  }
  const t = parseTranscript(stdout, built.value.format, { exitCode: r.exitCode });
  await writeFile(path.join(job.sampleDir, "final.txt"), t.finalText);
  await writeFile(path.join(job.sampleDir, "calls.json"), `${JSON.stringify(t.calls, null, 2)}\n`);

  const stderrHint = stderrSummary(r.stderrTail);
  if (t.terminal.kind === "error")
    return fail(
      "AGENT_ERROR",
      `agent ended with an error: ${String(t.terminal.message).slice(0, 300)}${stderrHint}`,
    );
  if (t.terminal.kind === "none")
    return fail(
      "AGENT_NO_RESULT",
      `${t.format} output had no final event (exit ${r.exitCode ?? r.signal}, ${t.events} events, ${t.unparsed} unreadable lines); counted as errored, never as finished${r.truncated ? " (output was cut at the capture limit)" : ""}${stderrHint}`,
    );
  if (t.terminal.kind === "done" && r.exitCode !== 0)
    return fail(
      "AGENT_EXIT",
      `agent reported it finished but exited ${r.exitCode ?? r.signal}${stderrHint}`,
    );

  const key = priceKey(a);
  const estimate = estimateCost(t.usage, job.config.prices, key);
  const memory = r.memory;
  return done(
    {
      wallMs: r.wallMs,
      peakMemoryBytes: memory?.peakBytes,
      exitCode: r.exitCode ?? undefined,
      inputTokens: t.usage?.inputTokens,
      outputTokens: t.usage?.outputTokens,
      cacheReadTokens: t.usage?.cacheReadTokens,
      cacheWriteTokens: t.usage?.cacheWriteTokens,
      totalTokens: totalTokens(t.usage),
      turns: t.turns,
      toolCalls: t.calls.length,
      toolErrors: t.calls.filter((c) => c.isError === true).length,
      costUsdReported: t.reportedCostUsd,
      costUsdEstimated: "usd" in estimate ? estimate.usd : undefined,
      filesChanged: effects.workspace.changed.length,
    },
    {
      timing: "agent process wall time, spawn to exit",
      format: t.format,
      outcome: t.terminal.kind,
      ...(t.terminal.subtype ? { subtype: t.terminal.subtype } : {}),
      exitCode: r.exitCode,
      signal: r.signal,
      stderrTail: r.stderrTail,
      truncated: r.truncated,
      transcript: { events: t.events, unparsed: t.unparsed },
      usage: t.usage
        ? { source: `reported by the agent CLI (${t.format})` }
        : { source: "none reported" },
      cost: {
        ...(t.reportedCostUsd !== undefined ? { reportedUsd: t.reportedCostUsd } : {}),
        ...("usd" in estimate
          ? { estimatedUsd: estimate.usd, price: estimate.price }
          : { unpriced: estimate.unpriced }),
      },
      peakMemory: memory
        ? { method: memory.method, label: memory.label, readings: memory.readings }
        : { method: "none", label: "unmeasured" },
      sampleDir: relPosix(job.studyDir, job.sampleDir),
      stdoutPath: relPosix(job.studyDir, stdoutFile),
      outPath: relPosix(job.studyDir, path.join(job.sampleDir, "final.txt")),
      finalTextPath: relPosix(job.studyDir, path.join(job.sampleDir, "final.txt")),
      callsPath: relPosix(job.studyDir, path.join(job.sampleDir, "calls.json")),
      effectsPath: relPosix(job.studyDir, path.join(job.sampleDir, EFFECTS_FILE)),
      workspaceDir: relPosix(job.studyDir, workspace),
      taskDir: relPosix(job.studyDir, bundle.bundleDir),
    },
  );
}
