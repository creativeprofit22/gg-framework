// Search benchmark spec. This module is the single owner of WHAT is measured:
// queries, cells, load shapes, headline comparisons and the keep/kill rule.
// Results from different SPEC_VERSIONs are never compared directly; changing
// anything here that alters measurement requires a version bump and a re-run
// of the current best version first (docs/search-performance/spec.md).

export const SPEC_VERSION = 1;

/** Shared frozen search tree (outside the repo, same HDD). */
export const TREE = Object.freeze({
  defaultRoot: "E:/Projects/gg-search-bench/tree",
  repoCommit: "df1a3531b867f11393ce98ea9af1d4b6f1d66ceb",
  seed: 0x5eed_0001,
  manySmall: Object.freeze({
    files: 20_000,
    dirs: 100,
    minBytes: 200,
    maxBytes: 2_000,
    needleEvery: 97,
  }),
  large: Object.freeze({ bytes: 9 * 1024 * 1024, lineChars: 1_000, markerEvery: 1_000 }),
});

/** Literal planted in synthetic files; never present in the repo. */
export const NEEDLE = "zqNEEDLEsynth";
export const LARGE_MARKER = "zqLARGEMARK";

/** Nonce tokens: built from parts so this source file never contains a match. */
export const NONCE_PREFIX = "zq" + "BN";
export const NONCE_SUFFIX = "X" + "q";
export function nonce(seq) {
  return `${NONCE_PREFIX}${seq}${NONCE_SUFFIX}`;
}
/** Walk-only query that the tree manifest proves absent. */
export const NO_MATCH = "zq" + "NOMATCH" + "9f1" + "Xq";

/** Product constants mirrored from grep.ts / find.ts at the baseline commit. */
export const TOOL_LIMITS = Object.freeze({
  grepDefaultMaxResults: 50,
  grepMaxFileSize: 10 * 1024 * 1024,
  grepMaxCandidateFiles: 10_000,
  grepDeadlineMs: 5_000,
  grepScanConcurrency: 12,
  findMaxResults: 100,
});

/** "Deadline off" is a very large budget; 0 would scan nothing. */
export const DEADLINE_ON_MS = 5_000;
export const DEADLINE_OFF_MS = 1e9;

/**
 * Queries (spec v1). `path` is relative to the tree root (the tool cwd).
 * `capBinds` is the expected class; the oracle decides per tree hash and the
 * pilot may only confirm, never change, the class.
 */
export const QUERIES = Object.freeze([
  {
    id: "Q1",
    label: "rare literal",
    tool: "grep",
    args: { pattern: "detectExternalScanner", path: "repo" },
  },
  { id: "Q2", label: "common literal", tool: "grep", args: { pattern: "import", path: "repo" } },
  {
    id: "Q3",
    label: "regex",
    tool: "grep",
    args: { pattern: "export\\s+(async\\s+)?function\\s+\\w+", path: "repo" },
  },
  {
    id: "Q4",
    label: "include filter",
    tool: "grep",
    args: { pattern: "createGrepTool", path: "repo", include: "*.ts" },
  },
  { id: "Q5", label: "find glob", tool: "find", args: { pattern: "**/*.test.ts", path: "repo" } },
  {
    id: "Q6",
    label: "deadline-hitting (lookahead forces in-process)",
    tool: "grep",
    // Lookahead is unsupported by rg, so this always runs in-process. The
    // \w+\d+ tail backtracks quadratically on the large file's long word runs.
    args: { pattern: "(?=\\w)\\w+\\d+" + "zq" + "DEADLINE", path: "." },
    // Every match must contain this literal; the manifest proves it absent, so
    // the oracle is "no matches" without running the quadratic regex.
    provenAbsentToken: "deadlineTail",
  },
  { id: "Q7", label: "match-everything", tool: "grep", args: { pattern: ".", path: "repo" } },
  {
    id: "Q8",
    label: "match-nothing walk-only",
    tool: "grep",
    args: { pattern: NO_MATCH, path: "repo" },
    provenAbsentToken: "noMatch",
  },
  {
    id: "Q9",
    label: "one large file",
    tool: "grep",
    args: { pattern: LARGE_MARKER, path: "synthetic/large/large.txt" },
  },
  {
    id: "Q10",
    label: "many small files",
    tool: "grep",
    args: { pattern: NEEDLE, path: "synthetic/many-small" },
  },
]);

export const AGENT_MIX = Object.freeze(["Q1", "Q2", "Q3", "Q4", "Q5"]);

export function queryById(id) {
  const query = QUERIES.find((q) => q.id === id);
  if (!query) throw new Error(`Unknown query ${id}`);
  return query;
}

/** Engine cells for grep queries. find has a single engine. */
export const ENGINES = Object.freeze(["rg-enabled", "in-process"]);

export const LADDER = Object.freeze([1, 4, 16, 32, 64, 100]);
export const MIN_WAVES_PER_LEVEL = 10;
export const WARMUP_WAVES = 2;
export const WAVE_TIMEOUT_MS = 10 * 60_000;

export const OPEN_LOOP = Object.freeze({
  ratesPerSecond: Object.freeze([1, 2, 4, 8, 16, 32, 64]),
  stepSeconds: 30,
  maxOutstanding: 1_000,
  kneeP99Factor: 2,
  kneeCompletionRatio: 0.95,
});

export const CANCEL = Object.freeze({
  queries: Object.freeze(["Q6", "Q2"]),
  abortAfterMs: 50,
  checkAfterMs: 100,
});
export const SOAK = Object.freeze({ concurrency: 16, durationMs: 10 * 60_000 });

export const THREADPOOL_SIZES = Object.freeze({ default: 4, large: 16 });
/** Dummy environment padding rotated across launches (Mytkowicz et al.). */
export const ENV_PAD_BYTES = Object.freeze([0, 1024, 4096, 16_384]);

export const COLD_METHODS = Object.freeze({
  none: "warm: no purge; first iterations discarded as warm-up",
  "standby-purge":
    "mostly-cold: operator ran RAMMap 'Empty Standby List' (admin) just before the launch; file-system metadata stays cached by Windows",
  reboot:
    "reboot-cold: first launch after a reboot (os.uptime() < 15 min), no other disk-heavy work started",
});
export const REBOOT_MAX_UPTIME_S = 15 * 60;

/**
 * Exact rg argument list used by grep.ts runExternalScan at the baseline
 * commit, for the raw-CLI ceiling. `--ignore-file` is appended when the scan
 * root has a .gitignore, then optional flags, then `--regexp <p> -- .`.
 */
export const RG_BASE_ARGS = Object.freeze([
  "--no-config",
  "--line-number",
  "--no-heading",
  "--with-filename",
  "--color",
  "never",
  "--no-messages",
  "--hidden",
  "--no-ignore",
  "--max-filesize",
  String(10 * 1024 * 1024),
  "--max-count",
  "<maxResults>",
  "--glob",
  "!**/.git/**",
  "--glob",
  "!**/node_modules/**",
]);

/** Pre-registered headline comparisons. Everything else is exploratory. */
export const HEADLINES = Object.freeze([
  {
    id: "H1",
    metric: "calls_per_s",
    description:
      "warm closed-wave calls/s at concurrency 100, agent mix, rg enabled, deadline on, UV 4",
    cell: {
      mode: "closed",
      concurrency: 100,
      mix: "agent",
      engine: "rg-enabled",
      deadline: "on",
      uv: 4,
      cold: "none",
    },
    better: "higher",
  },
  {
    id: "H2",
    metric: "p99_latency_ms",
    description: "warm p99 latency at concurrency 16, agent mix, rg enabled, deadline on, UV 4",
    cell: {
      mode: "closed",
      concurrency: 16,
      mix: "agent",
      engine: "rg-enabled",
      deadline: "on",
      uv: 4,
      cold: "none",
    },
    better: "lower",
  },
  {
    id: "H3",
    metric: "p50_latency_ms",
    description: "warm p50 latency of Q2 in-process at concurrency 1, deadline on, UV 4",
    cell: {
      mode: "closed",
      concurrency: 1,
      mix: "Q2",
      engine: "in-process",
      deadline: "on",
      uv: 4,
      cold: "none",
    },
    better: "lower",
  },
  {
    id: "H4",
    metric: "p50_latency_ms",
    description:
      "cold p50 latency of the agent mix at concurrency 1, rg enabled, deadline on, UV 4",
    cell: {
      mode: "cold",
      concurrency: 1,
      mix: "agent",
      engine: "rg-enabled",
      deadline: "on",
      uv: 4,
      cold: "any",
    },
    better: "lower",
  },
]);

export const KEEP_KILL = Object.freeze({
  minSpeedup: 1.3,
  ciLowerAbove: 1.0,
  correctness: "identical to the oracle for every complete call",
  reliability: "error and deadline-hit rates no higher than the upper bound of the baseline 95% CI",
  verdicts: Object.freeze(["kept", "reverted", "inconclusive"]),
});

export const STATS = Object.freeze({
  bootstrapResamples: 10_000,
  bootstrapSeed: 0x0b00_75ed,
  ciLevel: 0.95,
  acfMaxLag: 10,
  pilotTargetRelativeError: 0.05,
  pilotZ: 1.96,
  launchesMin: 3,
  launchesMax: 30,
});

/**
 * Cells per profile. A cell is one worker launch: one version, one load shape.
 * `quick` covers every headline; `full` adds exploratory cells.
 */
export function cellsForProfile(profile) {
  const base = { deadline: "on", uv: THREADPOOL_SIZES.default, cold: "none" };
  const closed = (mix, engine, levels, extra = {}) => ({
    ...base,
    mode: "closed",
    mix,
    engine,
    levels,
    ...extra,
  });
  const headline = [
    closed("agent", "rg-enabled", [16, 100], { headline: ["H1", "H2"] }),
    closed("Q2", "in-process", [1], { headline: ["H3"] }),
    { ...base, mode: "cold", mix: "agent", engine: "rg-enabled", levels: [1], headline: ["H4"] },
    { ...base, mode: "calibration", mix: "noop", engine: "none", levels: [1, 16, 100] },
    { ...base, mode: "rg-ceiling", mix: "all", engine: "rg-cli", levels: [1] },
    { ...base, mode: "cancel", mix: "cancel", engine: "rg-enabled", levels: [1] },
  ];
  if (profile === "pilot") {
    return [
      closed("agent", "rg-enabled", [1, 16], { waves: 5 }),
      closed("Q2", "in-process", [1], { waves: 5 }),
      closed("Q6", "in-process", [1], { waves: 3 }),
      { ...base, mode: "calibration", mix: "noop", engine: "none", levels: [1, 16], waves: 5 },
    ];
  }
  if (profile === "quick") return headline;
  if (profile !== "full") throw new Error(`Unknown profile ${profile}`);
  const perQuery = QUERIES.flatMap((q) =>
    (q.tool === "find" ? ["find"] : ENGINES).map((engine) => closed(q.id, engine, [1, 16])),
  );
  return [
    ...headline,
    closed("agent", "rg-enabled", LADDER),
    closed("agent", "in-process", LADDER),
    closed("agent", "rg-enabled", LADDER, { uv: THREADPOOL_SIZES.large }),
    ...perQuery,
    closed("agent", "rg-enabled", [1, 16], { deadline: "off" }),
    closed("agent", "rg-enabled", [1, 16], { deadline: "off", uv: THREADPOOL_SIZES.large }),
    closed("agent", "rg-enabled", [16], { uniqueness: "fixed-args" }),
    { ...base, mode: "open", mix: "agent", engine: "rg-enabled", levels: [] },
    { ...base, mode: "soak", mix: "agent", engine: "rg-enabled", levels: [SOAK.concurrency] },
  ];
}

/** Rough per-launch duration estimate (seconds) used to print runtime before start. */
export function estimateCellSeconds(cell, assumedCallMs = 1_500) {
  if (cell.mode === "open") return OPEN_LOOP.ratesPerSecond.length * (OPEN_LOOP.stepSeconds + 10);
  if (cell.mode === "soak") return SOAK.durationMs / 1000 + 10;
  if (cell.mode === "cancel") return CANCEL.queries.length * 10;
  if (cell.mode === "rg-ceiling") return QUERIES.length * 3;
  if (cell.mode === "cold") return AGENT_MIX.length * (assumedCallMs / 1000) * 3;
  const waves = (cell.waves ?? MIN_WAVES_PER_LEVEL) + WARMUP_WAVES;
  const callMs = cell.mix === "noop" ? 1 : assumedCallMs;
  return cell.levels.reduce(
    (sum, level) =>
      sum + (waves * callMs * Math.max(1, level / TOOL_LIMITS.grepScanConcurrency)) / 1000,
    5,
  );
}
