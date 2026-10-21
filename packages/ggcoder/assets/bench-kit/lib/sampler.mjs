// @ts-check
// Peak memory of a child process by polling. This is a SAMPLED value: a spike
// shorter than the poll interval can be missed, and only the direct process
// is watched (not processes it spawns). Reports always carry that label.
//
// Probes per platform (each returns bytes, or undefined when unreadable):
//   linux  /proc/<pid>/status VmHWM (the kernel's own peak, so polling only
//          has to catch it before exit)
//   darwin ps -o rss= (current resident size)
//   win32  one long-lived PowerShell loop printing PeakWorkingSet64; it takes
//          a moment to start, so very short processes may come back unmeasured
// Timers and probes are injectable for tests.
import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

export const DEFAULT_INTERVAL_MS = 50;

/**
 * @typedef {{ peakBytes: number | null, polls: number, readings: number, intervalMs: number, method: string, label: string }} MemoryReading
 * @typedef {(pid: number) => Promise<number | undefined>} Probe
 * @typedef {{ stop: () => Promise<MemoryReading> }} Sampler
 */

/** @type {Probe} */
async function linuxProbe(pid) {
  try {
    const text = await readFile(`/proc/${pid}/status`, "utf8");
    const kb = /^VmHWM:\s+(\d+)\s+kB/m.exec(text)?.[1] ?? /^VmRSS:\s+(\d+)\s+kB/m.exec(text)?.[1];
    return kb === undefined ? undefined : Number(kb) * 1024;
  } catch {
    return undefined;
  }
}

/** @type {Probe} */
function psProbe(pid) {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-o", "rss=", "-p", String(pid)],
      { windowsHide: true, timeout: 5_000 },
      (error, stdout) => {
        const kb = Number(String(stdout).trim());
        resolve(error || !Number.isFinite(kb) || kb <= 0 ? undefined : kb * 1024);
      },
    );
  });
}

/** @param {number} n */
const label = (n) => `sampled, ${n} ms resolution, direct process only`;

/**
 * Generic polling sampler around an async probe.
 * @param {number} pid
 * @param {{ intervalMs?: number, probe: Probe, method: string, setTimer?: (fn: () => void, ms: number) => unknown, clearTimer?: (handle: unknown) => void }} options
 * @returns {Sampler}
 */
export function pollPeakMemory(pid, options) {
  const {
    intervalMs = DEFAULT_INTERVAL_MS,
    probe,
    method,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (h) => clearTimeout(/** @type {any} */ (h)),
  } = options;
  /** @type {number | null} */
  let peak = null;
  let polls = 0;
  let readings = 0;
  let stopped = false;
  /** @type {unknown} */
  let handle;
  /** @type {Promise<void>} */
  let inFlight = Promise.resolve();

  const tick = () => {
    if (stopped) return;
    inFlight = (async () => {
      polls++;
      const bytes = await probe(pid);
      if (bytes !== undefined && Number.isFinite(bytes)) {
        readings++;
        if (peak === null || bytes > peak) peak = bytes;
      }
    })();
    inFlight.then(() => {
      if (!stopped) handle = setTimer(tick, intervalMs);
    });
  };
  tick();

  return {
    async stop() {
      stopped = true;
      clearTimer(handle);
      await inFlight;
      return { peakBytes: peak, polls, readings, intervalMs, method, label: label(intervalMs) };
    },
  };
}

/**
 * Windows: one PowerShell loop per watched process (spawning per poll would
 * cost more than most samples).
 * @param {number} pid
 * @param {number} intervalMs
 * @returns {Sampler}
 */
function windowsSampler(pid, intervalMs) {
  /** @type {number | null} */
  let peak = null;
  let readings = 0;
  const script = `$ErrorActionPreference='SilentlyContinue'; while ($true) { $p = Get-Process -Id ${pid}; if (-not $p) { break }; [Console]::Out.WriteLine($p.PeakWorkingSet64); Start-Sleep -Milliseconds ${intervalMs} }`;
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const bytes = Number(line.trim());
      if (Number.isFinite(bytes) && bytes > 0) {
        readings++;
        if (peak === null || bytes > peak) peak = bytes;
      }
    }
  });
  const exited = new Promise((resolve) => {
    child.once("exit", resolve);
    child.once("error", resolve);
  });
  return {
    async stop() {
      if (child.exitCode === null) child.kill();
      await exited;
      return {
        peakBytes: peak,
        polls: readings,
        readings,
        intervalMs,
        method: "win32-peak-working-set",
        label: label(intervalMs),
      };
    },
  };
}

/**
 * Start watching a child's memory with the platform's best probe.
 * @param {number} pid
 * @param {{ intervalMs?: number, platform?: NodeJS.Platform }} [options]
 * @returns {Sampler}
 */
export function samplePeakMemory(
  pid,
  { intervalMs = DEFAULT_INTERVAL_MS, platform = process.platform } = {},
) {
  if (platform === "win32") return windowsSampler(pid, intervalMs);
  if (platform === "linux")
    return pollPeakMemory(pid, { intervalMs, probe: linuxProbe, method: "linux-vmhwm" });
  return pollPeakMemory(pid, { intervalMs, probe: psProbe, method: "ps-rss" });
}

/**
 * Exact peak RSS of the current process (used by function workers, which
 * measure themselves). Includes the Node runtime baseline.
 * @returns {MemoryReading}
 */
export function selfPeakMemory() {
  return {
    peakBytes: process.resourceUsage().maxRSS * 1024,
    polls: 0,
    readings: 1,
    intervalMs: 0,
    method: "self-max-rss",
    label: "exact peak of the worker process (includes the Node runtime)",
  };
}
