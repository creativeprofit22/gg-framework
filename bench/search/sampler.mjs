// Resource sampling owner: built-in Windows counters (typeperf, 1 Hz), the
// worker's own process.resourceUsage(), optional admin-only recorders, and the
// USE-style note naming the observed limiting resource.
import { spawn } from "node:child_process";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

/** Counters sampled by typeperf. Process(*) is filtered to pids afterwards. */
export const TYPEPERF_COUNTERS = Object.freeze([
  "\\Processor(_Total)\\% Processor Time",
  "\\Process(*)\\% Processor Time",
  "\\Process(*)\\Working Set",
  "\\Process(*)\\Handle Count",
  "\\Process(*)\\ID Process",
  "\\PhysicalDisk(_Total)\\Disk Read Bytes/sec",
  "\\PhysicalDisk(_Total)\\Avg. Disk Queue Length",
  "\\PhysicalDisk(_Total)\\% Idle Time",
  "\\Memory\\Available MBytes",
]);

const BS = "\\";

/** Split `\Object(instance)\Counter` into parts; null when malformed. */
export function splitCounterPath(counterPath) {
  const m = /^\\([^(\\]+)(?:\(([^)]*)\))?\\(.+)$/.exec(counterPath);
  return m ? { object: m[1], instance: m[2] ?? null, counter: m[3] } : null;
}

/**
 * Build English↔localized maps from the Perflib name tables (`009` and
 * `CurrentLanguage` Counter values: alternating index/name lines). typeperf
 * only accepts localized names on non-English Windows.
 */
export function buildCounterNameMaps(englishLines, localLines, wanted) {
  const englishToIndex = new Map();
  for (let i = 0; i + 1 < englishLines.length; i += 2) {
    if (!englishToIndex.has(englishLines[i + 1]))
      englishToIndex.set(englishLines[i + 1], englishLines[i]);
  }
  const indexToLocal = new Map();
  for (let i = 0; i + 1 < localLines.length; i += 2)
    indexToLocal.set(localLines[i], localLines[i + 1]);
  const toLocal = {};
  for (const name of [...new Set(wanted)].sort()) {
    const local = indexToLocal.get(englishToIndex.get(name));
    toLocal[name] = local ?? name;
  }
  return toLocal;
}

/** Names (objects and counters) used by TYPEPERF_COUNTERS. */
export function counterNamesUsed(counters = TYPEPERF_COUNTERS) {
  const names = [];
  for (const c of counters) {
    const parts = splitCounterPath(c);
    if (parts) names.push(parts.object, parts.counter);
  }
  return names;
}

/** Translate English counter paths with a `toLocal` map (identity when absent). */
export function localizeCounters(counters, toLocal = {}) {
  return counters.map((c) => {
    const p = splitCounterPath(c);
    if (!p) return c;
    const object = toLocal[p.object] ?? p.object;
    const counter = toLocal[p.counter] ?? p.counter;
    return `${BS}${object}${p.instance === null ? "" : `(${p.instance})`}${BS}${counter}`;
  });
}

/**
 * Read the Perflib name tables (no admin needed) and return the
 * English→localized map for the counters we sample. Returns `{}` with a
 * status when unreadable; typeperf then gets English names.
 */
export async function loadCounterNameMap() {
  if (process.platform !== "win32") return { status: "not-windows", toLocal: {} };
  const { execFile } = await import("node:child_process");
  const read = (sub) =>
    new Promise((resolve) => {
      const key = [
        "HKLM:",
        "SOFTWARE",
        "Microsoft",
        "Windows NT",
        "CurrentVersion",
        "Perflib",
        sub,
      ].join(BS);
      execFile(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-ItemProperty -LiteralPath '${key}' -Name Counter).Counter -join [char]10`,
        ],
        { encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 },
        (error, stdout) => resolve(error ? undefined : stdout.split(/\r?\n/)),
      );
    });
  const [english, local] = await Promise.all([read("009"), read("CurrentLanguage")]);
  if (!english || !local) return { status: "perflib-unreadable", toLocal: {} };
  return { status: "ok", toLocal: buildCounterNameMaps(english, local, counterNamesUsed()) };
}

/** In-worker sampler: CPU, memory, handles and event-loop delay at a fixed interval. */
export function startProcessSampler({ everyMs = 1_000 } = {}) {
  const t0 = performance.now();
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const samples = [];
  const take = () => {
    const usage = process.resourceUsage();
    const mem = process.memoryUsage();
    samples.push({
      t: Math.round(performance.now() - t0),
      userCpuUs: usage.userCPUTime,
      systemCpuUs: usage.systemCPUTime,
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      handles: process.getActiveResourcesInfo().length,
      fsRead: usage.fsRead,
      eventLoopP99Ms: loop.percentile(99) / 1e6,
      eventLoopMaxMs: loop.max / 1e6,
    });
    loop.reset();
  };
  take();
  const timer = setInterval(take, everyMs);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      take();
      loop.disable();
      return samples;
    },
  };
}

/** Start typeperf writing CSV to `outFile`. Returns a handle with stop(). */
export function startTypeperf({ outFile, intervalS = 1, toLocal = {} }) {
  if (process.platform !== "win32")
    return { status: "unavailable-not-windows", stop: async () => undefined };
  const args = [
    ...localizeCounters(TYPEPERF_COUNTERS, toLocal),
    "-si",
    String(intervalS),
    "-f",
    "CSV",
    "-o",
    outFile,
    "-y",
  ];
  let child;
  try {
    child = spawn("typeperf", args, { windowsHide: true, stdio: "ignore" });
  } catch (error) {
    return { status: `unavailable:${error.code ?? error.message}`, stop: async () => undefined };
  }
  let exited = false;
  let errorCode;
  child.once("error", (error) => {
    errorCode = error.code ?? error.message;
    exited = true;
  });
  child.once("exit", () => {
    exited = true;
  });
  return {
    get status() {
      return errorCode ? `unavailable:${errorCode}` : "running";
    },
    async stop() {
      if (!exited) {
        child.kill();
        await new Promise((resolve) => {
          if (exited) resolve();
          else child.once("exit", resolve);
        });
      }
    },
  };
}

/** Minimal RFC 4180 CSV line splitter (typeperf quotes every field). */
export function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function num(v) {
  const n = Number(String(v).trim());
  return v === undefined || String(v).trim() === "" || !Number.isFinite(n) ? undefined : n;
}

/**
 * Parse typeperf CSV into per-second samples for the worker pid, rg children
 * and MsMpEng. Counters missing from the file are reported as unavailable.
 */
export function parseTypeperfCsv(text, { workerPid, toLocal = {} }) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2)
    return {
      samples: [],
      unavailable: [
        "all (no typeperf rows; run shorter than typeperf start-up or counters rejected)",
      ],
    };
  const toEnglish = new Map(Object.entries(toLocal).map(([en, local]) => [local, en]));
  const english = (name) => toEnglish.get(name) ?? name;
  const header = splitCsvLine(lines[0]);
  const columns = header.map((h, i) => {
    const m = /\\\\[^\\]+\\([^(\\]+)(?:\(([^)]*)\))?\\(.+)$/.exec(h);
    return m
      ? { i, object: english(m[1]), instance: m[2] ?? null, counter: english(m[3]) }
      : { i, object: null };
  });
  const find = (object, instance, counter) =>
    columns.find((c) => c.object === object && c.instance === instance && c.counter === counter);
  const processInstances = [
    ...new Set(
      columns
        .filter(
          (c) =>
            c.object === "Process" &&
            c.instance &&
            c.instance !== "_Total" &&
            c.instance !== "Idle",
        )
        .map((c) => c.instance),
    ),
  ];
  const unavailable = [];
  if (!processInstances.some((n) => /^MsMpEng/i.test(n)))
    unavailable.push("MsMpEng (not visible to this user)");
  const total = {
    cpu: find("Processor", "_Total", "% Processor Time"),
    readBps: find("PhysicalDisk", "_Total", "Disk Read Bytes/sec"),
    queue: find("PhysicalDisk", "_Total", "Avg. Disk Queue Length"),
    idle: find("PhysicalDisk", "_Total", "% Idle Time"),
    availMB: find("Memory", null, "Available MBytes"),
  };
  for (const [k, v] of Object.entries(total)) if (!v) unavailable.push(k);
  const samples = [];
  for (const line of lines.slice(1)) {
    const row = splitCsvLine(line);
    const value = (col) => (col ? num(row[col.i]) : undefined);
    const sample = {
      time: row[0],
      cpuTotal: value(total.cpu),
      diskReadBps: value(total.readBps),
      diskQueue: value(total.queue),
      diskBusy: value(total.idle) === undefined ? undefined : Math.max(0, 100 - value(total.idle)),
      availableMB: value(total.availMB),
      worker: undefined,
      rg: { count: 0, cpu: 0, workingSet: 0 },
      msmpengCpu: undefined,
    };
    for (const instance of processInstances) {
      const pid = value(find("Process", instance, "ID Process"));
      const cpu = value(find("Process", instance, "% Processor Time"));
      const ws = value(find("Process", instance, "Working Set"));
      const handles = value(find("Process", instance, "Handle Count"));
      if (pid === undefined) continue;
      if (pid === workerPid) sample.worker = { cpu, workingSet: ws, handles };
      else if (/^rg(#\d+)?$/i.test(instance) && pid > 0) {
        sample.rg.count += 1;
        sample.rg.cpu += cpu ?? 0;
        sample.rg.workingSet += ws ?? 0;
      } else if (/^MsMpEng(#\d+)?$/i.test(instance))
        sample.msmpengCpu = (sample.msmpengCpu ?? 0) + (cpu ?? 0);
    }
    samples.push(sample);
  }
  return { samples, unavailable };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);
const max = (xs) => (xs.length ? Math.max(...xs) : undefined);
const defined = (xs) => xs.filter((x) => x !== undefined && Number.isFinite(x));

/**
 * USE-style note: utilisation and saturation per resource, then the most
 * saturated one is named as the observed limit. `cpus` normalises per-process
 * CPU (typeperf reports per-core sums).
 */
export function useNote({ system = [], process: proc = [], errors = {}, cpus }) {
  const resources = [];
  const cpuTotal = defined(system.map((s) => s.cpuTotal));
  if (cpuTotal.length)
    resources.push({
      resource: "cpu (system)",
      utilisation: mean(cpuTotal),
      peak: max(cpuTotal),
      saturated: mean(cpuTotal) > 85,
    });
  const workerCpu = defined(system.map((s) => s.worker?.cpu));
  if (workerCpu.length) {
    const oneCore = 100;
    resources.push({
      resource: "cpu (worker main thread proxy)",
      utilisation: mean(workerCpu),
      peak: max(workerCpu),
      saturated: mean(workerCpu) > 0.9 * oneCore,
    });
  }
  const busy = defined(system.map((s) => s.diskBusy));
  const queue = defined(system.map((s) => s.diskQueue));
  if (busy.length)
    resources.push({
      resource: "disk",
      utilisation: mean(busy),
      peak: max(busy),
      queueMean: mean(queue),
      saturated: mean(busy) > 80 || mean(queue) > 2,
    });
  const loopP99 = defined(proc.map((s) => s.eventLoopP99Ms));
  if (loopP99.length)
    resources.push({
      resource: "event loop / threadpool proxy",
      utilisation: mean(loopP99),
      peak: max(loopP99),
      unit: "ms delay p99",
      saturated: mean(loopP99) > 50,
    });
  const defender = defined(system.map((s) => s.msmpengCpu));
  if (defender.length)
    resources.push({
      resource: "defender (MsMpEng)",
      utilisation: mean(defender) / (cpus ?? 1),
      peak: max(defender),
      saturated: mean(defender) > 50,
    });
  const errorTotal = Object.values(errors).reduce((a, b) => a + b, 0);
  const saturated = resources.filter((r) => r.saturated);
  const ranked = (saturated.length ? saturated : resources)
    .slice()
    .sort((a, b) => (b.utilisation ?? 0) - (a.utilisation ?? 0));
  const limit = ranked[0]?.resource ?? "unknown (no samples)";
  return {
    resources,
    errors,
    observedLimit: saturated.length ? limit : `none saturated (highest: ${limit})`,
    note: `${saturated.length ? "Saturated" : "Highest utilised"}: ${limit}; errors: ${errorTotal}`,
  };
}

/** Optional admin-only recorders. Never attempted without admin. */
export function optionalRecorders({ admin, wpr, mpRecording }) {
  return {
    wpr: wpr ? (admin === true ? "requested" : "skipped-no-admin") : "not-requested",
    mpRecording: mpRecording
      ? admin === true
        ? "requested"
        : "skipped-no-admin"
      : "not-requested",
  };
}
