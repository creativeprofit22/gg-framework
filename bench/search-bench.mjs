#!/usr/bin/env node
// search-bench — benchmark GG Coder's real grep/find tools (spec in
// bench/search/spec.mjs, docs in docs/search-performance/). This orchestrator
// owns the CLI and run order only; every measurement happens in a fresh
// `bench/search/worker.mjs` process per run.
// Usage:
//   node bench/search-bench.mjs --build-tree [--tree <dir>] [--force]
//   node bench/search-bench.mjs --target baseline=<worktree>@<sha> [--target cand=<wt>@<sha>]
//        [--profile pilot|quick|full] [--launches N] [--cold none|standby-purge|reboot]
//        [--session <name>] [--waves N] [--soak-ms N] [--open-step-ms N] [--only-cells <substr>]
//        [--wpr] [--mp-recording] [--fast-verify] [--dry-run]
//        --fast-verify: warm sessions only: size/mtime tree check instead of full hash
//   node bench/search-bench.mjs --report <sessionDir> [--report <dir>] [--out <dir>]
//        [--baseline-label baseline] [--candidate-label cand] [--update]
// Results go to bench/search-results/<session>/ (gitignored). --update rewrites
// bench/baseline/search.json from the report's baseline-label headlines.
import { execFile, spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  captureEnvironment,
  checkTarget,
  detectRg,
  parseTarget,
  treeVerifySchedule,
} from "./search/provenance.mjs";
import { writeReport } from "./search/report.mjs";
import { loadCounterNameMap, optionalRecorders, startTypeperf } from "./search/sampler.mjs";
import {
  COLD_METHODS,
  ENV_PAD_BYTES,
  HEADLINES,
  REBOOT_MAX_UPTIME_S,
  SPEC_VERSION,
  STATS,
  TREE,
  cellsForProfile,
  estimateCellSeconds,
} from "./search/spec.mjs";
import { buildTree, manifestCheck, verifyTree } from "./search/tree.mjs";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS_ROOT = path.join(REPO_ROOT, "bench", "search-results");
const BASELINE_PATH = path.join(REPO_ROOT, "bench", "baseline", "search.json");
const WORKER = path.join(REPO_ROOT, "bench", "search", "worker.mjs");

const BOOLEAN_FLAGS = new Set([
  "--build-tree",
  "--force",
  "--dry-run",
  "--update",
  "--wpr",
  "--mp-recording",
  "--fast-verify",
  "--help",
]);
const REPEATABLE = new Set(["--target", "--report"]);
const VALUE_FLAGS = new Set([
  "--target",
  "--report",
  "--tree",
  "--profile",
  "--launches",
  "--cold",
  "--session",
  "--waves",
  "--soak-ms",
  "--open-step-ms",
  "--only-cells",
  "--out",
  "--baseline-label",
  "--candidate-label",
]);

export function parseArgs(argv) {
  const opts = { target: [], report: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith("--"))
      throw new Error(`Unexpected positional argument "${flag}" (filters are flags only)`);
    const key = flag.slice(2);
    if (!BOOLEAN_FLAGS.has(flag) && !VALUE_FLAGS.has(flag))
      throw new Error(`Unknown flag "${flag}" (see --help)`);
    if (BOOLEAN_FLAGS.has(flag)) {
      opts[key] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    if (REPEATABLE.has(flag)) opts[key].push(value);
    else opts[key] = value;
  }
  return opts;
}

function positiveInt(value, name, fallback) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}

async function countRgProcesses() {
  if (process.platform !== "win32") return undefined;
  try {
    const { stdout } = await execFileAsync(
      "tasklist",
      ["/FI", "IMAGENAME eq rg.exe", "/FO", "CSV", "/NH"],
      { windowsHide: true },
    );
    return stdout.split(/\r?\n/).filter((l) => /^"rg\.exe"/i.test(l)).length;
  } catch {
    return undefined;
  }
}

/** Standby cache counters, recorded when the operator declares a standby purge. */
async function standbyCounters() {
  if (process.platform !== "win32") return "not-windows";
  try {
    const { stdout } = await execFileAsync(
      "typeperf",
      [
        "\\Memory\\Standby Cache Normal Priority Bytes",
        "\\Memory\\Standby Cache Reserve Bytes",
        "\\Memory\\Standby Cache Core Bytes",
        "-sc",
        "1",
      ],
      { windowsHide: true, timeout: 20_000 },
    );
    const rows = stdout.split(/\r?\n/).filter((l) => l.startsWith('"'));
    return rows.length >= 2 ? { header: rows[0], values: rows[1] } : "unreadable";
  } catch {
    return "unreadable";
  }
}

function cellLabel(cell) {
  return `${cell.mode}/${cell.mix}/${cell.engine}/dl-${cell.deadline}/uv${cell.uv}${cell.uniqueness ? `/${cell.uniqueness}` : ""} @ ${cell.levels.join(",") || "-"}`;
}

/** Latin-square style rotation of target order per round. */
export function targetOrder(targets, round) {
  return targets.map((_, i) => targets[(i + round) % targets.length]);
}

export function envPadFor(round, targetIndex) {
  return ENV_PAD_BYTES[(round + targetIndex) % ENV_PAD_BYTES.length];
}

/** Plan which cells run and which are skipped for this cold method. */
export function planCells(profile, coldMethod) {
  const cells = cellsForProfile(profile);
  const run = [];
  const skipped = [];
  for (const cell of cells) {
    if (coldMethod === "none" && cell.mode === "cold")
      skipped.push({
        cell: cellLabel(cell),
        reason: "skipped-cold-not-declared (run with --cold standby-purge or --cold reboot)",
      });
    else if (coldMethod !== "none" && cell.mode !== "cold")
      skipped.push({ cell: cellLabel(cell), reason: "cold session runs cold cells only" });
    else run.push(cell);
  }
  return { run, skipped };
}

async function runWorker({ config, configFile, env, typeperfFile, toLocal }) {
  await writeFile(configFile, JSON.stringify(config, null, 1));
  const child = spawn(process.execPath, [WORKER, configFile], {
    env,
    windowsHide: true,
    stdio: ["ignore", "inherit", "pipe"],
  });
  const typeperf = typeperfFile
    ? startTypeperf({ outFile: typeperfFile, toLocal })
    : { status: "not-recorded", stop: async () => undefined };
  const stderr = [];
  child.stderr.on("data", (chunk) => {
    stderr.push(chunk);
    process.stderr.write(chunk);
  });
  const exitCode = await new Promise((resolve) => {
    child.once("error", (error) => {
      stderr.push(Buffer.from(String(error.message)));
      resolve(-1);
    });
    child.once("close", (code) => resolve(code ?? -1));
  });
  const typeperfStatus = typeperf.status;
  await typeperf.stop();
  return {
    exitCode,
    workerPid: child.pid,
    typeperfStatus,
    stderrTail: Buffer.concat(stderr).toString("utf8").slice(-2000),
  };
}

async function runSession(opts) {
  if (opts.target.length === 0) throw new Error("At least one --target label=path@sha is required");
  const targets = opts.target.map(parseTarget);
  if (new Set(targets.map((t) => t.label)).size !== targets.length)
    throw new Error("Target labels must be unique");
  const profile = opts.profile ?? "quick";
  const coldMethod = opts.cold ?? "none";
  if (!(coldMethod in COLD_METHODS))
    throw new Error(`--cold must be one of ${Object.keys(COLD_METHODS).join(", ")}`);
  const launches =
    coldMethod === "none" ? positiveInt(opts.launches, "--launches", STATS.launchesMin) : 1;
  if (coldMethod !== "none" && targets.length > 1) {
    throw new Error(
      "A cold session measures one target only: the first target would warm the cache for the next. Run one session per target after each purge/reboot.",
    );
  }
  const treeRoot = path.resolve(opts.tree ?? TREE.defaultRoot);
  const planned = planCells(profile, coldMethod);
  // --only-cells <substring>, --waves, --soak-ms, --open-step-ms: smoke/debug
  // overrides. They are recorded in session.json `overrides`, and the report
  // excludes such sessions from headlines (smokeSessionProblem).
  const only = opts["only-cells"];
  const cells = only ? planned.run.filter((c) => cellLabel(c).includes(only)) : planned.run;
  const skipped = planned.skipped;
  const waves = opts.waves === undefined ? undefined : positiveInt(opts.waves, "--waves");
  const soakMs =
    opts["soak-ms"] === undefined ? undefined : positiveInt(opts["soak-ms"], "--soak-ms");
  const openStepMs =
    opts["open-step-ms"] === undefined
      ? undefined
      : positiveInt(opts["open-step-ms"], "--open-step-ms");
  const overrides = Object.fromEntries(
    Object.entries({
      onlyCells: only,
      waves,
      soakMs,
      openStepMs,
      fastVerify: opts["fast-verify"] ? true : undefined,
    }).filter(([, v]) => v !== undefined),
  );

  // ---- Refusals before anything runs ----
  const coldCheck = {
    method: coldMethod,
    description: COLD_METHODS[coldMethod],
    uptimeS: Math.round(os.uptime()),
  };
  if (coldMethod === "reboot" && os.uptime() > REBOOT_MAX_UPTIME_S) {
    throw new Error(
      `--cold reboot requires uptime under ${REBOOT_MAX_UPTIME_S / 60} min (now ${Math.round(os.uptime() / 60)} min). Reboot first.`,
    );
  }
  if (coldMethod === "standby-purge") coldCheck.standbyCountersAfterPurge = await standbyCounters();

  const treeSchedule = treeVerifySchedule(coldMethod, { fastVerify: Boolean(opts["fast-verify"]) });
  const verifyLabel = {
    "manifest-only": "manifest only; full content hash runs after the cold measurement",
    fast: "fast",
    full: "full hash",
  }[treeSchedule.before];
  console.log(`Verifying tree at ${treeRoot} (${verifyLabel})…`);
  const treeCheck =
    treeSchedule.before === "manifest-only"
      ? await manifestCheck(treeRoot)
      : await verifyTree(treeRoot, { full: treeSchedule.before === "full" });
  const checks = [];
  for (const target of targets) checks.push(await checkTarget(target, { treeCheck }));
  const refused = checks.filter((c) => !c.ok);
  if (refused.length) {
    for (const c of refused)
      console.error(`REFUSED ${c.facts.label}:\n  - ${c.reasons.join("\n  - ")}`);
    process.exitCode = 2;
    return;
  }

  const totalSeconds =
    cells.reduce((s, c) => s + estimateCellSeconds(c), 0) * launches * targets.length;
  console.log(
    `Spec v${SPEC_VERSION}, profile ${profile}, cold ${coldMethod}, ${targets.length} target(s) × ${cells.length} cell(s) × ${launches} launch(es)`,
  );
  for (const cell of cells) console.log(`  ${cellLabel(cell)}`);
  for (const s of skipped) console.log(`  SKIP ${s.cell}: ${s.reason}`);
  console.log(
    `Estimated runtime: ~${Math.ceil(totalSeconds / 60)} min (rough; HDD scans may take longer)`,
  );
  if (opts["dry-run"]) return;

  const [rg, environment, counterNames] = await Promise.all([
    detectRg(),
    captureEnvironment(),
    loadCounterNameMap(),
  ]);
  const session =
    opts.session ?? `s${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "")}`;
  if (!/^[A-Za-z0-9_.-]+$/.test(session))
    throw new Error("--session may contain only letters, digits, _ . -");
  const dir = path.join(RESULTS_ROOT, session);
  if (existsSync(dir)) throw new Error(`Session directory already exists: ${dir}`);
  await mkdir(dir, { recursive: true });
  const meta = {
    type: "session",
    session,
    specVersion: SPEC_VERSION,
    profile,
    coldMethod,
    cold: coldCheck,
    launches,
    argv: process.argv.slice(2),
    overrides,
    startedAt: new Date().toISOString(),
    tree: {
      root: treeRoot,
      hash: treeCheck.treeHash,
      verify: treeSchedule.before,
      before: treeSchedule.before,
    },
    targets: checks.map((c) => c.facts),
    rg,
    environment,
    counterNames,
    optionalRecorders: optionalRecorders({
      admin: environment.admin,
      wpr: opts.wpr,
      mpRecording: opts["mp-recording"],
    }),
    skipped,
  };
  await writeFile(path.join(dir, "session.json"), `${JSON.stringify(meta, null, 1)}\n`);
  const index = path.join(dir, "runs.jsonl");
  const log = createWriteStream(path.join(dir, "orchestrator.log"), { flags: "a" });
  const say = (line) => {
    console.log(line);
    log.write(`${new Date().toISOString()} ${line}\n`);
  };

  let runNo = 0;
  for (let round = 0; round < launches; round++) {
    const ordered = targetOrder(targets, round);
    for (let ti = 0; ti < ordered.length; ti++) {
      const target = ordered[ti];
      for (let ci = 0; ci < cells.length; ci++) {
        const cell = { ...cells[ci], cold: coldMethod };
        // Per-run provenance (fast tree check) so a mid-session change refuses the
        // rest. Cold sessions skip it: stat-ing the tree would warm its metadata.
        const check = await checkTarget(target, {
          treeCheck:
            treeSchedule.perRun === "fast"
              ? await verifyTree(treeRoot, { full: false })
              : treeCheck,
        });
        if (!check.ok) {
          say(`REFUSED mid-session ${target.label}: ${check.reasons.join("; ")}`);
          process.exitCode = 2;
          log.end();
          return;
        }
        const runId = `r${String(runNo++).padStart(4, "0")}`;
        const pad = envPadFor(round, targets.indexOf(target));
        const files = {
          calls: `${runId}.jsonl`,
          summary: `${runId}.summary.json`,
          typeperf: `${runId}.typeperf.csv`,
          config: `${runId}.config.json`,
        };
        const config = {
          runId,
          worktree: target.worktree,
          treeRoot,
          treeHash: treeCheck.treeHash,
          oracleCacheDir: path.join(RESULTS_ROOT, "oracle-cache"),
          outFile: path.join(dir, files.calls),
          summaryFile: path.join(dir, files.summary),
          cell,
          waves,
          soakMs,
          openStepMs,
        };
        const env = {
          ...process.env,
          UV_THREADPOOL_SIZE: String(cell.uv),
          GG_BENCH_ENV_PAD: "x".repeat(pad),
        };
        const rgBefore = await countRgProcesses();
        say(`${runId} round ${round} ${target.label} ${cellLabel(cell)} pad ${pad}B`);
        const started = Date.now();
        const result = await runWorker({
          config,
          configFile: path.join(dir, files.config),
          env,
          typeperfFile: path.join(dir, files.typeperf),
          toLocal: counterNames.toLocal,
        });
        await new Promise((r) => setTimeout(r, 1_000));
        const rgAfter = await countRgProcesses();
        const entry = {
          type: "run",
          runId,
          label: target.label,
          commit: check.facts.commit,
          worktree: target.worktree,
          dirty: check.facts.dirty,
          toolHashes: check.facts.toolHashes,
          round,
          launch: round,
          cellIndex: ci,
          cell,
          coldMethod,
          uv: cell.uv,
          envPadBytes: pad,
          cpus: os.cpus().length,
          wallMs: Date.now() - started,
          exitCode: result.exitCode,
          workerPid: result.workerPid,
          typeperfStatus: result.typeperfStatus,
          stderrTail: result.exitCode === 0 ? undefined : result.stderrTail,
          leftoverRg:
            rgBefore === undefined || rgAfter === undefined ? undefined : rgAfter - rgBefore,
          files,
        };
        await appendFile(index, `${JSON.stringify(entry)}\n`);
        say(
          `${runId} exit ${result.exitCode} in ${Math.round(entry.wallMs / 1000)} s${entry.leftoverRg ? `, ${entry.leftoverRg} rg left running` : ""}`,
        );
      }
    }
  }
  if (treeSchedule.after === "full") {
    say("Verifying tree content after the cold measurement (full hash)…");
    const post = await verifyTree(treeRoot, { full: true });
    meta.tree.after = { ok: post.ok, problems: post.problems };
    if (!post.ok) {
      say(`REFUSED: post-run tree hash failed; the report excludes this session's samples.`);
      process.exitCode = 2;
    }
  }
  meta.endedAt = new Date().toISOString();
  await writeFile(path.join(dir, "session.json"), `${JSON.stringify(meta, null, 1)}\n`);
  log.end();
  const summary = await writeReport({
    dirs: [dir],
    outDir: dir,
    baselineLabel: opts["baseline-label"],
    candidateLabel: opts["candidate-label"],
  });
  console.log(`\nReport: ${path.join(dir, "report.md")}`);
  printHeadlines(summary);
}

function printHeadlines(summary) {
  for (const [label, values] of Object.entries(summary.headlines)) {
    for (const h of values)
      console.log(
        `  ${label} ${h.id} ${h.metric}: ${h.status === "ok" ? `${h.value.toFixed(2)} (${h.launches} launches, pilot suggests ${h.pilot?.launches ?? "–"})` : "no data"}`,
      );
  }
  for (const c of summary.comparison?.headlines ?? []) {
    console.log(
      `  ${c.id} ratio ${c.status === "ok" ? `${c.point?.toFixed(3)} [${c.lower?.toFixed(3)}, ${c.upper?.toFixed(3)}]` : "no data"}`,
    );
  }
}

/** bench/baseline/search.json: the current best version's headline summary. */
export function baselineFile(summary, label) {
  const values = summary.headlines[label];
  if (!values) throw new Error(`No runs labelled "${label}" in the report`);
  // Excluded sessions contributed no samples, so they are not the baseline's provenance.
  const used = summary.sessions.filter((s) => !s.excluded);
  const targets = used.flatMap((s) => (s.targets ?? []).filter((t) => t.label === label));
  const commits = [...new Set(targets.map((t) => t.commit))];
  if (commits.length !== 1)
    throw new Error(
      `Label "${label}" maps to ${commits.length} commits; refusing to write a baseline`,
    );
  return {
    specVersion: summary.specVersion,
    label,
    commit: commits[0],
    sessions: used.map((s) => s.session),
    excludedSessions: summary.sessions
      .filter((s) => s.excluded)
      .map((s) => ({ session: s.session, reason: s.excluded })),
    recorded_at: new Date().toISOString(),
    headlines: Object.fromEntries(
      values.map((h) => [
        h.id,
        h.status === "ok"
          ? {
              metric: h.metric,
              value: h.value,
              launches: h.launches,
              sessions: h.sessions,
              cv: h.pilot?.cv ?? null,
              description: h.description,
            }
          : {
              metric: h.metric,
              status: h.status,
              description: HEADLINES.find((x) => x.id === h.id)?.description,
            },
      ]),
    ),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      await readFile(fileURLToPath(import.meta.url), "utf8").then((t) => {
        // The usage text is the leading `//` comment block after the shebang.
        const lines = t.split(/\r?\n/).slice(1);
        const end = lines.findIndex((l) => !l.startsWith("//"));
        return lines
          .slice(0, end === -1 ? lines.length : end)
          .map((l) => l.replace(/^\/\/ ?/, ""))
          .join("\n");
      }),
    );
    return;
  }
  if (opts["build-tree"]) {
    const manifest = await buildTree({
      root: path.resolve(opts.tree ?? TREE.defaultRoot),
      repoRoot: REPO_ROOT,
      force: Boolean(opts.force),
    });
    console.log(
      `Tree built: ${manifest.fileCount} files, ${(manifest.totalBytes / 1048576).toFixed(1)} MB, hash ${manifest.treeHash}`,
    );
    return;
  }
  if (opts.report.length) {
    const dirs = opts.report.map((d) => path.resolve(d));
    const outDir = path.resolve(opts.out ?? dirs[0]);
    const summary = await writeReport({
      dirs,
      outDir,
      baselineLabel: opts["baseline-label"],
      candidateLabel: opts["candidate-label"],
    });
    console.log(`Report: ${path.join(outDir, "report.md")}`);
    printHeadlines(summary);
    if (opts.update) {
      const file = baselineFile(summary, opts["baseline-label"] ?? "baseline");
      // Committed file: format with the repo's Prettier so format:check stays clean.
      const prettier = await import("prettier");
      const options = (await prettier.resolveConfig(BASELINE_PATH)) ?? {};
      const text = await prettier.format(JSON.stringify(file), {
        ...options,
        filepath: BASELINE_PATH,
      });
      await writeFile(BASELINE_PATH, text);
      console.log(`\nBaseline updated: ${path.relative(REPO_ROOT, BASELINE_PATH)}`);
    }
    return;
  }
  if (opts.update) throw new Error("--update requires --report <sessionDir>");
  await runSession(opts);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message ?? error);
    process.exitCode = 1;
  });
}
