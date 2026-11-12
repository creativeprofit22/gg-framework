// Report owner: loads a session's raw results, builds the summary (per-cell
// metrics, headline effect sizes with bootstrap CIs, A/A check, reliability,
// correctness, USE notes, cancel/soak/open-loop/calibration/ceiling results)
// and renders Markdown plus run-sequence and autocorrelation SVGs.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { coldSessionProblem, pilotSessionProblem, smokeSessionProblem } from "./provenance.mjs";
import { detectKnee } from "./runner.mjs";
import { parseTypeperfCsv, useNote } from "./sampler.mjs";
import { HEADLINES, KEEP_KILL, SPEC_VERSION } from "./spec.mjs";
import {
  autocorrelation,
  bootstrapRatio,
  linearSlope,
  mean,
  percentile,
  pilotRepetitions,
  proportionCi,
  summarize,
  verdict,
} from "./stats.mjs";

const COLD_METHODS_FOR_HEADLINE = new Set(["standby-purge", "reboot"]);

async function readJsonl(file) {
  try {
    const text = await readFile(file, "utf8");
    return text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function readOptional(file, encoding = "utf-8") {
  try {
    return new TextDecoder(encoding).decode(await readFile(file));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Load every run listed in each session's runs.jsonl index. */
export async function loadSessions(dirs) {
  const sessions = [];
  const runs = [];
  for (const dir of dirs) {
    const meta = JSON.parse(await readFile(path.join(dir, "session.json"), "utf8"));
    // A cold session whose tree was read before measuring, or whose content
    // was not verified afterwards, or any session run with smoke/debug
    // overrides, is listed but contributes no samples.
    const excluded =
      coldSessionProblem(meta) ?? smokeSessionProblem(meta) ?? pilotSessionProblem(meta);
    if (excluded) {
      sessions.push({ dir, meta: { ...meta, excluded } });
      continue;
    }
    sessions.push({ dir, meta });
    for (const entry of await readJsonl(path.join(dir, "runs.jsonl"))) {
      if (entry.type !== "run") continue;
      const calls = await readJsonl(path.join(dir, entry.files.calls));
      const summaryText = await readOptional(path.join(dir, entry.files.summary));
      // typeperf writes the CSV in the ANSI code page (Windows-1252 here).
      const typeperfText = entry.files.typeperf
        ? await readOptional(path.join(dir, entry.files.typeperf), "windows-1252")
        : undefined;
      runs.push({
        ...entry,
        session: meta.session,
        calls,
        summary: summaryText ? JSON.parse(summaryText) : undefined,
        typeperf:
          typeperfText && entry.workerPid
            ? parseTypeperfCsv(typeperfText, {
                workerPid: entry.workerPid,
                toLocal: meta.counterNames?.toLocal,
              })
            : undefined,
      });
    }
  }
  return { sessions, runs };
}

/** Canonical identity of a cell (excludes levels and run-specific fields). */
export function cellKey(cell) {
  return [
    cell.mode,
    cell.mix,
    cell.engine,
    `deadline-${cell.deadline}`,
    `uv${cell.uv}`,
    cell.uniqueness ?? "unique",
  ].join("/");
}

/** seq → { concurrency, wave, warmup } from a closed-mode summary. */
export function waveIndex(summary) {
  const index = new Map();
  for (const level of summary?.levels ?? []) {
    for (const wave of level.waves) {
      for (const seq of wave.callSeqs)
        index.set(seq, { concurrency: level.concurrency, wave: wave.wave, warmup: wave.warmup });
    }
  }
  return index;
}

/** Measured (non-warm-up) waves and their calls at one concurrency level. */
export function measuredWaves(run, concurrency) {
  const level = run.summary?.levels?.find((l) => l.concurrency === concurrency);
  if (!level) return [];
  const bySeq = new Map(run.calls.map((c) => [c.seq, c]));
  return level.waves
    .filter((w) => !w.warmup)
    .map((w) => ({ ...w, calls: w.callSeqs.map((s) => bySeq.get(s)).filter(Boolean) }));
}

function matchesHeadlineCell(run, cell) {
  const c = run.cell;
  if (
    c.mode !== cell.mode ||
    c.mix !== cell.mix ||
    c.engine !== cell.engine ||
    c.deadline !== cell.deadline ||
    c.uv !== cell.uv
  )
    return false;
  if ((c.uniqueness ?? "unique") !== "unique") return false;
  if (cell.mode === "cold") return COLD_METHODS_FOR_HEADLINE.has(run.coldMethod);
  if (run.coldMethod !== "none") return false;
  return (c.levels ?? []).includes(cell.concurrency);
}

/** Leaf values for one run and headline metric. */
function runUnits(run, headline) {
  if (headline.cell.mode === "cold")
    return run.calls.filter((c) => c.outcome !== "error").map((c) => c.latencyMs);
  const waves = measuredWaves(run, headline.cell.concurrency).filter((w) => !w.timedOut);
  if (headline.metric === "calls_per_s") return waves.map((w) => w.callsPerSecond);
  // Latency: waves → calls, so the wave is resampled as a unit first.
  return waves.map((w) => w.calls.filter((c) => c.outcome !== "error").map((c) => c.latencyMs));
}

/**
 * Nested sessions → launches → units for one label and headline. `launchFilter`
 * selects a subset of launches (used by the A/A split).
 */
export function headlineGroups(runs, headline, label, launchFilter = () => true) {
  const bySession = new Map();
  for (const run of runs) {
    if (
      run.label !== label ||
      run.exitCode !== 0 ||
      !matchesHeadlineCell(run, headline.cell) ||
      !launchFilter(run)
    )
      continue;
    const units = runUnits(run, headline);
    if (units.length === 0) continue;
    if (!bySession.has(run.session)) bySession.set(run.session, []);
    bySession.get(run.session).push(units);
  }
  return [...bySession.keys()].sort().map((k) => bySession.get(k));
}

const flatDeep = (x) => (Array.isArray(x) ? x.flatMap(flatDeep) : [x]);

function metricValue(metric, values) {
  if (metric === "calls_per_s") return mean(values);
  const p = { p50_latency_ms: 50, p90_latency_ms: 90, p99_latency_ms: 99 }[metric];
  return percentile(values, p);
}

/** Per-launch metric values (for pilot sizing). */
function perLaunchValues(groups, metric) {
  return groups.flat().map((launch) => metricValue(metric, flatDeep(launch)));
}

function countBy(items, key) {
  const out = {};
  for (const item of items) {
    const k = key(item);
    if (k === undefined || k === null) continue;
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** Reliability, engine and correctness over a list of calls. */
export function callStats(calls) {
  const n = calls.length;
  const errors = calls.filter((c) => c.outcome === "error");
  const deadline = calls.filter((c) => c.partial?.includes("deadline"));
  const checked = calls.filter((c) => c.correctness);
  const complete = calls.filter((c) => c.outcome === "complete");
  const completeChecked = complete.filter((c) => c.correctness);
  return {
    calls: n,
    outcomes: countBy(calls, (c) => c.outcome),
    partials: countBy(
      calls.flatMap((c) => c.partial ?? []),
      (p) => p,
    ),
    errors: countBy(errors, (c) => c.error),
    errorRate: proportionCi(errors.length, n),
    deadlineHitRate: proportionCi(deadline.length, n),
    engines: countBy(calls, (c) => c.engine),
    fallbacks: countBy(calls, (c) => c.fallback),
    correctness: {
      checked: checked.length,
      failed: checked.filter((c) => !c.correctness.pass).length,
      completeChecked: completeChecked.length,
      completeFailed: completeChecked.filter((c) => !c.correctness.pass).length,
      meanRecallPartial: mean(
        calls
          .filter((c) => c.outcome === "partial" && c.correctness)
          .map((c) => c.correctness.recall),
      ),
    },
    outputBytes: summarize(calls.map((c) => c.outputBytes)),
  };
}

/** Per label × cell × level metrics. */
export function cellSummaries(runs) {
  const groups = new Map();
  for (const run of runs) {
    if (run.exitCode !== 0 || !run.summary) continue;
    const levels = run.summary.levels?.map((l) => l.concurrency) ?? [null];
    for (const level of levels) {
      const key = `${run.label}|${cellKey(run.cell)}|${run.coldMethod}|${level ?? "-"}`;
      if (!groups.has(key))
        groups.set(key, {
          label: run.label,
          cell: cellKey(run.cell),
          cold: run.coldMethod,
          concurrency: level,
          runs: [],
        });
      groups.get(key).runs.push(run);
    }
  }
  const out = [];
  for (const key of [...groups.keys()].sort()) {
    const g = groups.get(key);
    let calls;
    let waves = [];
    if (g.concurrency === null) {
      calls = g.runs.flatMap((r) => r.calls);
    } else {
      waves = g.runs.flatMap((r) => measuredWaves(r, g.concurrency));
      calls = waves.flatMap((w) => w.calls);
    }
    const throughput = waves.filter((w) => !w.timedOut);
    const perWave = (field) =>
      throughput.map((w) => w.calls.reduce((s, c) => s + (c[field] ?? 0), 0) / (w.wallMs / 1000));
    out.push({
      label: g.label,
      cell: g.cell,
      cold: g.cold,
      concurrency: g.concurrency,
      launches: g.runs.length,
      waves: waves.length,
      timedOutWaves: waves.filter((w) => w.timedOut).length,
      latencyMs: summarize(calls.filter((c) => c.outcome !== "error").map((c) => c.latencyMs)),
      callsPerSecond: summarize(throughput.map((w) => w.callsPerSecond)),
      filesPerSecond: summarize(perWave("workFiles")),
      mbPerSecond: summarize(perWave("workBytes").map((b) => b / 1048576)),
      ...callStats(calls),
    });
  }
  return out;
}

/** Headline values for one label, plus pilot sizing from per-launch noise. */
export function headlineValues(runs, label) {
  return HEADLINES.map((h) => {
    const groups = headlineGroups(runs, h, label);
    const all = flatDeep(groups);
    if (all.length === 0)
      return { id: h.id, description: h.description, metric: h.metric, status: "no-data" };
    const perLaunch = perLaunchValues(groups, h.metric);
    return {
      id: h.id,
      description: h.description,
      metric: h.metric,
      status: "ok",
      value: metricValue(h.metric, all),
      units: all.length,
      launches: perLaunch.length,
      sessions: groups.length,
      perLaunch,
      pilot: perLaunch.length >= 2 ? pilotRepetitions(perLaunch) : undefined,
    };
  });
}

/** Headline comparison baseline → candidate (ratio > 1 = candidate better). */
export function compareHeadlines(runs, baselineLabel, candidateLabel, options = {}) {
  return HEADLINES.map((h) => {
    const base = headlineGroups(runs, h, baselineLabel);
    const cand = headlineGroups(runs, h, candidateLabel);
    if (!flatDeep(base).length || !flatDeep(cand).length) return { id: h.id, status: "no-data" };
    return {
      id: h.id,
      status: "ok",
      ...bootstrapRatio(base, cand, { metric: h.metric, better: h.better, ...options }),
    };
  });
}

/**
 * A/A: the same label split into two halves by launch parity. A trustworthy
 * harness gives a CI that contains 1.0.
 */
export function aaCheck(runs, label, options = {}) {
  return HEADLINES.map((h) => {
    const even = headlineGroups(runs, h, label, (r) => r.launch % 2 === 0);
    const odd = headlineGroups(runs, h, label, (r) => r.launch % 2 === 1);
    if (!flatDeep(even).length || !flatDeep(odd).length) return { id: h.id, status: "no-data" };
    const ci = bootstrapRatio(even, odd, { metric: h.metric, better: h.better, ...options });
    return { id: h.id, status: "ok", ...ci, containsOne: ci.lower <= 1 && ci.upper >= 1 };
  });
}

/** Keep/kill verdicts for a comparison (reliability against the baseline CI). */
export function verdicts(comparison, { correctnessIdentical, reliabilityOk }) {
  return comparison.map((c) => ({
    id: c.id,
    verdict:
      c.status === "ok" ? verdict(c, { correctnessIdentical, reliabilityOk }) : "inconclusive",
  }));
}

/** Per-run extras: USE note, independence, cancel, soak, open loop, ceiling, leftovers. */
export function runDetails(run) {
  const latencies = run.calls
    .filter((c) => c.outcome !== "error")
    .sort((a, b) => a.seq - b.seq)
    .map((c) => c.latencyMs);
  const errors = countBy(
    run.calls.filter((c) => c.outcome === "error"),
    (c) => c.error,
  );
  const detail = {
    runId: run.runId,
    label: run.label,
    cell: cellKey(run.cell),
    cold: run.coldMethod,
    launch: run.launch,
    exitCode: run.exitCode,
    envPadBytes: run.envPadBytes,
    leftoverRgAfterExit: run.leftoverRg,
    acf: autocorrelation(latencies),
    use: useNote({
      system: run.typeperf?.samples ?? [],
      process: run.summary?.processSamples ?? [],
      errors,
      cpus: run.cpus,
    }),
    countersUnavailable: run.typeperf?.unavailable ?? ["typeperf not recorded"],
  };
  const s = run.summary;
  if (!s) return { ...detail, note: "no summary (worker failed)", stderrTail: run.stderrTail };
  detail.rgChildrenTotal = s.rgChildrenTotal;
  detail.rgLiveAtEnd = s.rgLiveAtEnd;
  detail.distinctOutputsPerQuery = s.distinctOutputsPerQuery;
  if (s.cancel) detail.cancel = s.cancel;
  if (s.ceiling) {
    detail.ceiling =
      s.ceiling.status === "ok"
        ? {
            status: "ok",
            perQuery: s.ceiling.results.map((r) => ({
              query: r.query,
              status: r.status ?? "ok",
              ms: r.samples
                ? summarize(r.samples.filter((x) => !x.warmup).map((x) => x.ms))
                : undefined,
            })),
          }
        : s.ceiling;
  }
  if (s.soakSamples) {
    const minutes = s.soakSamples.map((x) => x.t / 60_000);
    detail.soak = {
      rssBytesPerMin: linearSlope(
        minutes,
        s.soakSamples.map((x) => x.rss),
      ),
      handlesPerMin: linearSlope(
        minutes,
        s.soakSamples.map((x) => x.handles),
      ),
      samples: s.soakSamples.length,
    };
  }
  if (s.steps) {
    const p = (xs, q) => percentile(xs, q * 100);
    detail.openLoop = {
      steps: s.steps.map((step) => {
        const done = step.records.filter((r) => !r.overflow);
        return {
          ratePerSecond: step.ratePerSecond,
          scheduled: step.scheduled,
          overflow: step.overflow,
          completionRate: step.completionRate,
          latencyMs: summarize(done.map((r) => r.latencyMs)),
          serviceMs: summarize(done.map((r) => r.serviceMs)),
          generatorLagMs: step.generatorLagMs,
        };
      }),
      knee: detectKnee(s.steps, p),
    };
  }
  return detail;
}

// ---------- SVG ----------

function esc(text) {
  return String(text).replace(
    /[&<>"]/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch],
  );
}

/** Run-sequence plot: latency in call order (drift, warm-up and periodicity show up here). */
export function sequenceSvg(values, title, { width = 640, height = 220 } = {}) {
  const pad = 36;
  const xs = values.filter((v) => Number.isFinite(v));
  const maxV = xs.length ? Math.max(...xs) : 1;
  const pts = xs
    .map((v, i) => {
      const x = pad + (xs.length > 1 ? (i / (xs.length - 1)) * (width - 2 * pad) : 0);
      const y = height - pad - (v / (maxV || 1)) * (height - 2 * pad);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="sans-serif" font-size="11">`,
    `<rect width="100%" height="100%" fill="#fff"/>`,
    `<text x="${pad}" y="16">${esc(title)} — latency (ms) by call order, n=${xs.length}</text>`,
    `<line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" stroke="#888"/>`,
    `<line x1="${pad}" y1="${pad}" x2="${pad}" y2="${height - pad}" stroke="#888"/>`,
    `<text x="4" y="${pad + 4}">${maxV.toFixed(0)}</text>`,
    `<text x="4" y="${height - pad}">0</text>`,
    xs.length ? `<polyline fill="none" stroke="#2563eb" stroke-width="1" points="${pts}"/>` : "",
    `</svg>`,
  ].join("\n");
}

/** Lag 1..k autocorrelation bars with the ±1.96/√n white-noise band. */
export function acfSvg(acf, title, { width = 640, height = 220 } = {}) {
  const pad = 36;
  const mid = height / 2;
  const scale = (height - 2 * pad) / 2;
  const n = acf.lags.length || 1;
  const barW = (width - 2 * pad) / n;
  const bars = acf.lags
    .map((l, i) => {
      if (l.r === undefined) return "";
      const h = Math.abs(l.r) * scale;
      const y = l.r >= 0 ? mid - h : mid;
      const outside = acf.band !== undefined && Math.abs(l.r) > acf.band;
      return `<rect x="${(pad + i * barW + 2).toFixed(1)}" y="${y.toFixed(1)}" width="${(barW - 4).toFixed(1)}" height="${h.toFixed(1)}" fill="${outside ? "#dc2626" : "#2563eb"}"/><text x="${(pad + i * barW + barW / 2 - 3).toFixed(1)}" y="${height - 8}">${l.lag}</text>`;
    })
    .join("\n");
  const band = acf.band ?? 0;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="sans-serif" font-size="11">`,
    `<rect width="100%" height="100%" fill="#fff"/>`,
    `<text x="${pad}" y="16">${esc(title)} — autocorrelation, n=${acf.n}, band ±${band.toFixed(3)}</text>`,
    `<line x1="${pad}" y1="${mid}" x2="${width - pad}" y2="${mid}" stroke="#888"/>`,
    `<line x1="${pad}" y1="${(mid - band * scale).toFixed(1)}" x2="${width - pad}" y2="${(mid - band * scale).toFixed(1)}" stroke="#aaa" stroke-dasharray="4"/>`,
    `<line x1="${pad}" y1="${(mid + band * scale).toFixed(1)}" x2="${width - pad}" y2="${(mid + band * scale).toFixed(1)}" stroke="#aaa" stroke-dasharray="4"/>`,
    bars,
    `</svg>`,
  ].join("\n");
}

// ---------- Markdown ----------

const fmt = (v, digits = 1) =>
  v === undefined || v === null || Number.isNaN(v)
    ? "–"
    : typeof v === "number"
      ? v.toFixed(digits)
      : String(v);
const pct = (ci) =>
  ci?.rate === undefined
    ? "–"
    : `${(ci.rate * 100).toFixed(2)}% [${(ci.lower * 100).toFixed(2)}, ${(ci.upper * 100).toFixed(2)}]`;

export function renderMarkdown(summary) {
  const lines = [];
  lines.push(`# Search benchmark report`, "");
  lines.push(
    `Spec version ${summary.specVersion}. Sessions: ${summary.sessions.map((s) => s.session).join(", ")}. Generated ${summary.generatedAt}.`,
    "",
  );
  lines.push("## Provenance", "");
  for (const s of summary.sessions) {
    lines.push(
      `- **${s.session}** (cold: ${s.coldMethod}, profile: ${s.profile}, rg: ${s.rg?.available ? `${s.rg.version} at ${s.rg.path}` : "not on PATH"})${s.excluded ? ` — **excluded, no samples used**: ${s.excluded}` : ""}`,
    );
    for (const t of s.targets ?? [])
      lines.push(
        `  - ${t.label}: ${t.commit} at ${t.worktree}, dirty ${t.dirty}, grep.js ${t.toolHashes?.grep?.dist?.slice(0, 12) ?? "–"}`,
      );
    const e = s.environment ?? {};
    lines.push(
      `  - Node ${e.node}, ${e.cpus}× ${e.cpuModel}, free RAM ${e.freeMemMB} MB, power ${e.powerPlan}, AC ${e.acPower}, SysMain ${e.sysMain}, Search ${e.windowsSearch}, Defender RT ${e.defenderRealtime}, CPU temp ${e.cpuTempC}, admin ${e.admin}`,
    );
    if (s.skipped?.length)
      lines.push(`  - Skipped: ${s.skipped.map((k) => `${k.cell} (${k.reason})`).join("; ")}`);
  }
  lines.push("", "## Headlines (pre-registered)", "");
  for (const [label, values] of Object.entries(summary.headlines)) {
    lines.push(
      `### ${label}`,
      "",
      "| ID | Metric | Value | Launches | Sessions | Pilot CV | Suggested launches |",
      "|---|---|---|---|---|---|---|",
    );
    for (const h of values) {
      lines.push(
        h.status === "ok"
          ? `| ${h.id} | ${h.metric} | ${fmt(h.value, 2)} | ${h.launches} | ${h.sessions} | ${fmt(h.pilot?.cv, 3)} | ${h.pilot?.launches ?? "–"} |`
          : `| ${h.id} | ${h.metric} | no data | – | – | – | – |`,
      );
    }
    lines.push("");
  }
  if (summary.comparison) {
    lines.push(
      `## Comparison ${summary.comparison.baseline} → ${summary.comparison.candidate}`,
      "",
      "Ratio > 1 means the candidate is better. Keep rule: point ≥ " +
        `${KEEP_KILL.minSpeedup}, CI lower > ${KEEP_KILL.ciLowerAbove}, identical correctness, no reliability regression.`,
      "",
      "| ID | Ratio | 95% CI | Verdict |",
      "|---|---|---|---|",
    );
    for (const c of summary.comparison.headlines) {
      const v = summary.comparison.verdicts.find((x) => x.id === c.id)?.verdict;
      lines.push(
        c.status === "ok"
          ? `| ${c.id} | ${fmt(c.point, 3)} | [${fmt(c.lower, 3)}, ${fmt(c.upper, 3)}] | ${v} |`
          : `| ${c.id} | no data | – | ${v} |`,
      );
    }
    lines.push("");
  }
  lines.push(
    "## A/A check",
    "",
    "Same version, launches split by parity; the CI should contain 1.0.",
    "",
  );
  for (const [label, rows] of Object.entries(summary.aa)) {
    lines.push(
      `- ${label}: ${rows.map((r) => (r.status === "ok" ? `${r.id} ${fmt(r.point, 3)} [${fmt(r.lower, 3)}, ${fmt(r.upper, 3)}] ${r.containsOne ? "contains 1" : "**excludes 1**"}` : `${r.id} no data`)).join("; ")}`,
    );
  }
  lines.push("", "## Cells (exploratory unless headline)", "");
  lines.push(
    "| Label | Cell | Cold | Conc | Launches | p50 | p90 | p99 | max | calls/s | MB/s | errors | deadline-hit | engines | correctness fail (complete) |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const c of summary.cells) {
    lines.push(
      `| ${c.label} | ${c.cell} | ${c.cold} | ${c.concurrency ?? "–"} | ${c.launches} | ${fmt(c.latencyMs.p50)} | ${fmt(c.latencyMs.p90)} | ${fmt(c.latencyMs.p99)} | ${fmt(c.latencyMs.max)} | ${fmt(c.callsPerSecond.mean, 2)} | ${fmt(c.mbPerSecond.mean, 1)} | ${pct(c.errorRate)} | ${pct(c.deadlineHitRate)} | ${Object.entries(
        c.engines,
      )
        .map(([k, v]) => `${k}:${v}`)
        .join(" ")} | ${c.correctness.completeFailed}/${c.correctness.completeChecked} |`,
    );
  }
  lines.push("", "## Runs", "");
  for (const r of summary.runs) {
    const bits = [
      `${r.runId} ${r.label} ${r.cell} launch ${r.launch} pad ${r.envPadBytes}B exit ${r.exitCode}`,
      `USE: ${r.use.note}`,
      `ACF outside band at lags [${r.acf.outsideBand.join(",")}]`,
      `rg left after exit: ${r.leftoverRgAfterExit ?? "–"}`,
    ];
    if (r.cancel)
      bits.push(
        `cancel: ${r.cancel.map((c) => `${c.query} returned ${fmt(c.returnAfterAbortMs, 0)} ms after abort (engine ${c.engine}, rg live +100ms ${c.rgLiveAtAbortPlus100ms}, after return ${c.rgLiveAfterReturnPlus1s})`).join("; ")}`,
      );
    if (r.soak)
      bits.push(
        `soak: RSS ${fmt((r.soak.rssBytesPerMin ?? 0) / 1048576, 2)} MB/min, handles ${fmt(r.soak.handlesPerMin, 2)}/min`,
      );
    if (r.openLoop)
      bits.push(
        `open-loop knee: ${r.openLoop.knee?.ratePerSecond ?? "none"} /s (${r.openLoop.knee?.reason})`,
      );
    if (r.ceiling)
      bits.push(
        `rg CLI ceiling: ${r.ceiling.status === "ok" ? r.ceiling.perQuery.map((q) => `${q.query} ${q.status === "ok" ? `${fmt(q.ms?.p50)} ms` : q.status}`).join(", ") : r.ceiling.status}`,
      );
    if (r.countersUnavailable?.length)
      bits.push(`counters unavailable: ${r.countersUnavailable.join(", ")}`);
    lines.push(`- ${bits.join(" · ")}`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Build the full summary object. */
export function buildSummary({ sessions, runs, baselineLabel, candidateLabel, bootstrap = {} }) {
  const labels = [...new Set(runs.map((r) => r.label))].sort();
  const summary = {
    type: "search-bench-report",
    specVersion: SPEC_VERSION,
    generatedAt: new Date().toISOString(),
    sessions: sessions.map((s) => s.meta),
    labels,
    headlines: Object.fromEntries(labels.map((l) => [l, headlineValues(runs, l)])),
    aa: Object.fromEntries(labels.map((l) => [l, aaCheck(runs, l, bootstrap)])),
    cells: cellSummaries(runs),
    runs: runs.map(runDetails),
  };
  const specVersions = new Set(sessions.map((s) => s.meta.specVersion));
  if (specVersions.size > 1)
    summary.warning = `sessions mix spec versions ${[...specVersions].join(", ")}; comparisons are invalid`;
  if (baselineLabel && candidateLabel && specVersions.size <= 1) {
    const headlines = compareHeadlines(runs, baselineLabel, candidateLabel, bootstrap);
    const candCalls = runs.filter((r) => r.label === candidateLabel).flatMap((r) => r.calls);
    const baseCalls = runs.filter((r) => r.label === baselineLabel).flatMap((r) => r.calls);
    const cand = callStats(candCalls);
    const base = callStats(baseCalls);
    const correctnessIdentical = cand.correctness.completeFailed === 0;
    const reliabilityOk =
      (cand.errorRate.rate ?? 0) <= (base.errorRate.upper ?? 0) &&
      (cand.deadlineHitRate.rate ?? 0) <= (base.deadlineHitRate.upper ?? 0);
    summary.comparison = {
      baseline: baselineLabel,
      candidate: candidateLabel,
      headlines,
      correctnessIdentical,
      reliabilityOk,
      verdicts: verdicts(headlines, { correctnessIdentical, reliabilityOk }),
    };
  }
  return summary;
}

/** Load sessions, write report.json, report.md and SVGs into outDir. */
export async function writeReport({ dirs, outDir, baselineLabel, candidateLabel }) {
  const { sessions, runs } = await loadSessions(dirs);
  const summary = buildSummary({ sessions, runs, baselineLabel, candidateLabel });
  const svgDir = path.join(outDir, "svg");
  await mkdir(svgDir, { recursive: true });
  for (const run of runs) {
    const latencies = run.calls
      .filter((c) => c.outcome !== "error")
      .sort((a, b) => a.seq - b.seq)
      .map((c) => c.latencyMs);
    if (latencies.length < 2) continue;
    const title = `${run.runId} ${run.label} ${cellKey(run.cell)}`;
    await writeFile(path.join(svgDir, `${run.runId}-sequence.svg`), sequenceSvg(latencies, title));
    await writeFile(
      path.join(svgDir, `${run.runId}-acf.svg`),
      acfSvg(autocorrelation(latencies), title),
    );
  }
  await writeFile(path.join(outDir, "report.json"), `${JSON.stringify(summary, null, 1)}\n`);
  await writeFile(path.join(outDir, "report.md"), renderMarkdown(summary));
  return summary;
}

/** Session directories under a results root, sorted. */
export async function listSessionDirs(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory() && e.name !== "oracle-cache")
    .map((e) => path.join(root, e.name))
    .sort();
}
