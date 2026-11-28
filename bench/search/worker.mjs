// One worker process = one run (one version, one cell). Started fresh by the
// orchestrator for every run so per-process caches (rg probe, module loads)
// and environment layout are part of the measured unit, not leaked between.
//
// Usage: node worker.mjs <config.json>
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { classifyOutcome } from "./classify.mjs";
import {
  cachedOracle,
  compareFind,
  compareGrep,
  findOracle,
  grepOracle,
  loadOracleDeps,
  parseFindOutput,
  parseGrepOutput,
} from "./oracle.mjs";
import { runClosedWaves, runOpenLoopStep, runSoak, uniqueArgs, withTimeout } from "./runner.mjs";
import { startProcessSampler } from "./sampler.mjs";
import { attributeEngine, callContext, installSpawnSpy } from "./spawn-spy.mjs";
import {
  AGENT_MIX,
  CANCEL,
  DEADLINE_OFF_MS,
  DEADLINE_ON_MS,
  MIN_WAVES_PER_LEVEL,
  OPEN_LOOP,
  QUERIES,
  queryById,
  RG_BASE_ARGS,
  SOAK,
  TOOL_LIMITS,
  WARMUP_WAVES,
  WAVE_TIMEOUT_MS,
} from "./spec.mjs";
import { TRACKED_TOKENS } from "./tree.mjs";

// The spy must wrap spawn BEFORE the target's modules bind it.
const spy = installSpawnSpy();

function sha1(text) {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

function mixFor(cell) {
  if (cell.mix === "agent") return AGENT_MIX.map(queryById);
  if (cell.mix === "noop") return [{ id: "NOOP", tool: "noop", args: {} }];
  if (cell.mix === "all") return QUERIES.slice();
  if (cell.mix === "cancel") return CANCEL.queries.map(queryById);
  return [queryById(cell.mix)];
}

async function loadTarget(worktree) {
  const dist = path.join(worktree, "packages", "ggcoder", "dist", "tools");
  const grep = await import(pathToFileURL(path.join(dist, "grep.js")).href);
  const find = await import(pathToFileURL(path.join(dist, "find.js")).href);
  return { grep, find };
}

const NOOP_TOOL = Object.freeze({
  name: "noop",
  parameters: { parse: (args) => args },
  execute: async () => "ok",
});

/** Oracle per query (cached on disk per tree hash). */
async function buildOracles({ queries, config, deps, manifest }) {
  const oracles = new Map();
  for (const query of queries) {
    if (query.tool === "noop") continue;
    const absent = query.provenAbsentToken;
    if (absent && manifest.tokenFileCounts?.[absent] !== 0) {
      throw new Error(
        `Manifest does not prove ${absent} absent; cannot use the short oracle for ${query.id}`,
      );
    }
    const oracleArgs = absent ? { ...query.args, pattern: TRACKED_TOKENS[absent] } : query.args;
    const kind = query.tool === "find" ? "find" : "grep";
    const result = await cachedOracle({
      cacheDir: config.oracleCacheDir,
      treeHash: config.treeHash,
      kind,
      args: oracleArgs,
      compute: () =>
        kind === "find"
          ? findOracle({ cwd: config.treeRoot, args: query.args, deps })
          : grepOracle({
              cwd: config.treeRoot,
              args: oracleArgs,
              deps,
              candidateCap: TOOL_LIMITS.grepMaxCandidateFiles,
            }),
    });
    oracles.set(query.id, result);
  }
  return oracles;
}

function capBindsFor(query, oracle) {
  if (query.tool !== "grep" || !oracle) return false;
  return oracle.matches.length >= TOOL_LIMITS.grepDefaultMaxResults;
}

async function main() {
  const config = JSON.parse(await readFile(process.argv[2], "utf8"));
  const { cell } = config;
  const runStart = performance.now();
  const sampler = startProcessSampler({ everyMs: 1_000 });
  const target = await loadTarget(config.worktree);
  const deps = await loadOracleDeps(config.worktree);
  const manifest = JSON.parse(await readFile(path.join(config.treeRoot, "manifest.json"), "utf8"));
  const queries = mixFor(cell);
  const cold = cell.mode === "cold";

  // Probe once up front for warm runs (the daemon also probes once). Cold runs
  // leave it to the first call so its cost is part of the cold sample.
  if (!cold && cell.engine !== "none") await target.grep.detectExternalScanner();

  let oracles = cold ? new Map() : await buildOracles({ queries, config, deps, manifest });
  const deadlineMs = cell.deadline === "off" ? DEADLINE_OFF_MS : DEADLINE_ON_MS;
  const useExternal = cell.engine === "in-process" ? () => false : () => true;
  const tools = {
    grep: target.grep.createGrepTool(config.treeRoot, undefined, {
      deadlineMs,
      useExternalScanner: useExternal,
    }),
    find: target.find.createFindTool(config.treeRoot),
    noop: NOOP_TOOL,
  };

  const callsOut = createWriteStream(config.outFile, { flags: "w" });
  const raw = [];
  // Distinct outputs only (keyed by query/engine/hash): correctness is checked
  // once per distinct output after the load ends, so the check neither competes
  // with measured calls nor holds every output in memory during a soak.
  const distinctOutputs = new Map();
  let callCounter = 0;

  async function executeCall({ seq, slot, wave, query, signal }) {
    const callId = `${config.runId}:${callCounter++}`;
    // Cold runs call each query once (no repeats to suppress) and must not
    // build the oracle before measuring, so they use the plain arguments.
    const uniqueness = cold ? "fixed-args" : cell.uniqueness;
    const unique = uniqueArgs(query, seq, {
      capBinds: capBindsFor(query, oracles.get(query.id)),
      uniqueness,
    });
    const tool = tools[query.tool];
    const startedAt = performance.now();
    const ctx = { signal: signal ?? new AbortController().signal, toolCallId: callId };
    const attempt = callContext.run({ callId }, async () => {
      const parsed = tool.parameters.parse(unique.args);
      return tool.execute(parsed, ctx);
    });
    const settled = await withTimeout(
      attempt.then(
        (output) => ({ output: typeof output === "string" ? output : JSON.stringify(output) }),
        (error) => ({ error }),
      ),
      WAVE_TIMEOUT_MS,
    );
    const endedAt = performance.now();
    const result = settled.timedOut ? {} : settled.value;
    const outcome = classifyOutcome({
      tool: query.tool,
      output: result.output,
      error: result.error,
      harnessTimeout: settled.timedOut,
    });
    const children = spy.childrenFor(callId);
    const engine =
      query.tool === "grep"
        ? attributeEngine(children)
        : { engine: query.tool, fallback: undefined };
    const record = {
      type: "call",
      run: config.runId,
      seq,
      slot,
      wave,
      query: query.id,
      tool: query.tool,
      uniqueness: unique.uniqueness,
      startMs: startedAt - runStart,
      latencyMs: endedAt - startedAt,
      outcome: outcome.outcome,
      partial: outcome.partial,
      error: outcome.error,
      errorMessage: result.error
        ? String(result.error.message ?? result.error).slice(0, 300)
        : undefined,
      engine: engine.engine,
      fallback: engine.fallback,
      rgChildren: children.length,
      rgKilledByDeadline: engine.rgKilledByDeadline ?? false,
      outputBytes: result.output ? Buffer.byteLength(result.output) : 0,
      outputHash: result.output ? sha1(result.output) : null,
    };
    raw.push(record);
    if (result.output !== undefined) {
      const key = `${query.id}|${record.engine}|${record.outputHash}`;
      if (!distinctOutputs.has(key)) {
        distinctOutputs.set(key, {
          record: { partial: record.partial, engine: record.engine },
          output: result.output,
          query,
          maxResults: unique.args.max_results ?? TOOL_LIMITS.grepDefaultMaxResults,
        });
      }
      record.outputKey = key;
    }
    return record;
  }

  function checkCorrectness(entry) {
    const { record, output, query, maxResults } = entry;
    const oracle = oracles.get(query.id);
    if (!oracle || output === undefined) return;
    if (query.tool === "grep") {
      const parsed = parseGrepOutput(output);
      record.resultCount = parsed.records.length;
      record.correctness = compareGrep({
        records: parsed.records,
        oracle,
        maxResults,
        partial: record.partial,
        engine: record.engine,
      });
      record.workFiles = oracle.candidateCount;
      record.workBytes = oracle.candidateBytes;
    } else if (query.tool === "find") {
      const parsed = parseFindOutput(output);
      record.resultCount = parsed.files.length;
      record.correctness = compareFind({
        files: parsed.files,
        oracle,
        maxResults: TOOL_LIMITS.findMaxResults,
        truncated: record.partial.includes("find-cap"),
      });
    }
  }

  const mixCall = ({ seq, slot, wave }) =>
    executeCall({ seq, slot, wave, query: queries[seq % queries.length] });
  const summary = {
    type: "summary",
    runId: config.runId,
    cell,
    startedAt: new Date().toISOString(),
  };

  if (cell.mode === "closed" || cell.mode === "calibration") {
    summary.levels = [];
    let seqBase = 0;
    for (const concurrency of cell.levels) {
      const waves = await runClosedWaves({
        concurrency,
        waves: cell.waves ?? config.waves ?? MIN_WAVES_PER_LEVEL,
        warmupWaves: WARMUP_WAVES,
        waveTimeoutMs: WAVE_TIMEOUT_MS,
        makeCall: ({ seq, slot, wave }) => mixCall({ seq: seqBase + seq, slot, wave }),
      });
      seqBase += waves.reduce((n, w) => n + w.concurrency, 0);
      summary.levels.push({
        concurrency,
        waves: waves.map(({ calls, ...w }) => ({ ...w, callSeqs: calls.map((c) => c.seq) })),
      });
    }
  } else if (cell.mode === "cold") {
    // One cold sample per query: the first call of each query in a fresh process.
    for (let i = 0; i < queries.length; i++)
      await executeCall({ seq: i, slot: 0, wave: 0, query: queries[i] });
    oracles = await buildOracles({ queries, config, deps, manifest });
  } else if (cell.mode === "open") {
    summary.steps = [];
    let seqStart = 0;
    for (const rate of OPEN_LOOP.ratesPerSecond) {
      const step = await runOpenLoopStep({
        ratePerSecond: rate,
        durationMs: config.openStepMs ?? OPEN_LOOP.stepSeconds * 1000,
        makeCall: mixCall,
        seqStart,
      });
      seqStart += step.scheduled;
      summary.steps.push({ ...step, records: step.records.map(({ call, ...r }) => r) });
    }
  } else if (cell.mode === "soak") {
    const soak = await runSoak({
      concurrency: cell.levels[0] ?? SOAK.concurrency,
      durationMs: config.soakMs ?? SOAK.durationMs,
      makeCall: mixCall,
      sample: () => ({
        rss: process.memoryUsage().rss,
        handles: process.getActiveResourcesInfo().length,
      }),
    });
    summary.soakSamples = soak.samples;
  } else if (cell.mode === "cancel") {
    summary.cancel = [];
    for (const id of CANCEL.queries) {
      const query = queryById(id);
      const controller = new AbortController();
      const started = performance.now();
      const pending = executeCall({
        seq: 1_000_000 + summary.cancel.length,
        slot: 0,
        wave: null,
        query,
        signal: controller.signal,
      });
      await new Promise((r) => setTimeout(r, CANCEL.abortAfterMs));
      controller.abort();
      const abortedAt = performance.now();
      await new Promise((r) => setTimeout(r, CANCEL.checkAfterMs));
      const liveAtCheck = spy.liveChildren().length;
      const record = await pending;
      const returnedAt = performance.now();
      await new Promise((r) => setTimeout(r, 1_000));
      summary.cancel.push({
        query: id,
        abortAfterMs: abortedAt - started,
        returnAfterAbortMs: returnedAt - abortedAt,
        honouredAbort: returnedAt - abortedAt < CANCEL.checkAfterMs,
        rgLiveAtAbortPlus100ms: liveAtCheck,
        rgLiveAfterReturnPlus1s: spy.liveChildren().length,
        engine: record.engine,
        outcome: record.outcome,
        partial: record.partial,
      });
    }
  } else if (cell.mode === "rg-ceiling") {
    summary.ceiling = await rgCeiling({
      config,
      queries,
      waves: cell.waves ?? config.waves ?? MIN_WAVES_PER_LEVEL,
    });
  } else {
    throw new Error(`Unknown cell mode ${cell.mode}`);
  }

  for (const entry of distinctOutputs.values()) checkCorrectness(entry);
  const distinctPerQuery = {};
  for (const key of distinctOutputs.keys()) {
    const q = key.split("|")[0];
    distinctPerQuery[q] = (distinctPerQuery[q] ?? 0) + 1;
  }
  summary.distinctOutputsPerQuery = distinctPerQuery;
  for (const record of raw) {
    const checked = record.outputKey ? distinctOutputs.get(record.outputKey)?.record : undefined;
    if (checked) {
      record.resultCount = checked.resultCount;
      record.correctness = checked.correctness;
      record.workFiles = checked.workFiles;
      record.workBytes = checked.workBytes;
    }
    delete record.outputKey;
    callsOut.write(`${JSON.stringify(record)}\n`);
  }
  await new Promise((resolve) => callsOut.end(resolve));

  summary.probe = spy.probe;
  summary.rgChildrenTotal = spy.all().filter((c) => !c.probe).length;
  summary.rgLiveAtEnd = spy.liveChildren().length;
  summary.processSamples = sampler.stop();
  summary.durationMs = performance.now() - runStart;
  summary.calls = raw.length;
  await writeFile(config.summaryFile, `${JSON.stringify(summary)}\n`);
}

/** Raw rg CLI ceiling: the tool's exact argument list, no Node in the loop. */
async function rgCeiling({ config, queries, waves }) {
  if (!spy.probe.available) {
    // detectExternalScanner was not called in this mode; probe directly.
    const probe = await runRg(["--version"], config.treeRoot);
    if (!probe.ok) return { status: "skipped-no-rg", reason: probe.error ?? `exit ${probe.code}` };
  }
  const results = [];
  for (const query of queries) {
    if (query.tool !== "grep") continue;
    if (/\(\?=|\(\?!|\(\?</.test(query.args.pattern)) {
      results.push({ query: query.id, status: "skipped-unsupported-by-rg" });
      continue;
    }
    const dir = path.resolve(config.treeRoot, query.args.path ?? ".");
    const args = RG_BASE_ARGS.map((a) =>
      a === "<maxResults>" ? String(TOOL_LIMITS.grepDefaultMaxResults) : a,
    );
    if (existsSync(path.join(dir, ".gitignore")))
      args.push("--ignore-file", path.join(dir, ".gitignore"));
    if (query.args.include) args.push("--glob", query.args.include);
    args.push("--regexp", query.args.pattern, "--", ".");
    const samples = [];
    for (let i = 0; i < waves + WARMUP_WAVES; i++) {
      const r = await runRg(args, dir);
      samples.push({
        warmup: i < WARMUP_WAVES,
        ms: r.ms,
        code: r.code,
        stdoutBytes: r.stdoutBytes,
      });
    }
    results.push({ query: query.id, args, samples });
  }
  return { status: "ok", results };
}

function runRg(args, cwd) {
  return new Promise((resolve) => {
    const started = performance.now();
    let stdoutBytes = 0;
    let child;
    try {
      child = spawn("rg", args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch (error) {
      resolve({ ok: false, error: error.code ?? error.message });
      return;
    }
    child.stdout.on("data", (c) => {
      stdoutBytes += c.length;
    });
    child.once("error", (error) => resolve({ ok: false, error: error.code ?? error.message }));
    child.once("close", (code) =>
      resolve({ ok: code === 0 || code === 1, code, ms: performance.now() - started, stdoutBytes }),
    );
  });
}

main().then(
  () => process.exit(0),
  async (error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exit(1);
  },
);
