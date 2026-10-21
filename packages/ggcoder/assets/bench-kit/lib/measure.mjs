// @ts-check
// In-process timing for function candidates (runs inside a fresh worker).
// Warm-up first, then measure until BOTH the minimum sample count and the
// minimum time are met (a fast function gets many iterations, a slow one at
// least `minSamples`), bounded by hard caps. When the worker was started with
// --expose-gc, garbage is collected before the loop so earlier allocations
// don't land inside it, and the heap change across the loop is reported.
// Clock and memory readers are injectable so the stop rule is testable.
import { performance } from "node:perf_hooks";

export const MEASURE_DEFAULTS = Object.freeze({
  warmup: 2,
  minSamples: 10,
  minTimeMs: 300,
  maxSamples: 100_000,
  maxTimeMs: 30_000,
});

/**
 * @typedef {{
 *   samplesMs: number[],
 *   warmupMs: number[],
 *   totalMs: number,
 *   stoppedBy: "min-samples-and-time" | "max-samples" | "max-time" | "aborted",
 *   gcForced: boolean,
 *   heapDeltaBytes: number | null,
 *   cpuMs: number,
 * }} Measurement
 */

/**
 * @param {() => unknown} fn  Called once per iteration; may return a promise.
 * @param {{
 *   warmup?: number, minSamples?: number, minTimeMs?: number, maxSamples?: number, maxTimeMs?: number,
 *   clock?: () => number, gc?: (() => void) | undefined, heapUsed?: () => number, signal?: AbortSignal,
 *   cpuUsage?: () => { user: number, system: number },
 * }} [options]
 * @returns {Promise<Measurement>}
 */
export async function measureFunction(fn, options = {}) {
  const {
    warmup = MEASURE_DEFAULTS.warmup,
    minSamples = MEASURE_DEFAULTS.minSamples,
    minTimeMs = MEASURE_DEFAULTS.minTimeMs,
    maxSamples = MEASURE_DEFAULTS.maxSamples,
    maxTimeMs = MEASURE_DEFAULTS.maxTimeMs,
    clock = () => performance.now(),
    gc = /** @type {(() => void) | undefined} */ (/** @type {any} */ (globalThis).gc),
    heapUsed = () => process.memoryUsage().heapUsed,
    cpuUsage = () => process.cpuUsage(),
    signal,
  } = options;

  /** @type {number[]} */
  const warmupMs = [];
  for (let i = 0; i < warmup && !signal?.aborted; i++) {
    const t0 = clock();
    await fn();
    warmupMs.push(clock() - t0);
  }

  const gcForced = typeof gc === "function";
  if (gcForced) gc();
  const heapBefore = gcForced ? heapUsed() : null;

  /** @type {number[]} */
  const samplesMs = [];
  /** @type {Measurement["stoppedBy"]} */
  let stoppedBy = "min-samples-and-time";
  const cpu0 = cpuUsage();
  const start = clock();
  for (;;) {
    if (signal?.aborted) {
      stoppedBy = "aborted";
      break;
    }
    const t0 = clock();
    await fn();
    const t1 = clock();
    samplesMs.push(t1 - t0);
    const elapsed = t1 - start;
    if (samplesMs.length >= minSamples && elapsed >= minTimeMs) break;
    if (samplesMs.length >= maxSamples) {
      stoppedBy = "max-samples";
      break;
    }
    if (elapsed >= maxTimeMs) {
      stoppedBy = "max-time";
      break;
    }
  }
  const totalMs = clock() - start;
  const cpu1 = cpuUsage();
  // CPU time of the whole loop in ms (user + system, all threads of this process).
  const cpuMs = (cpu1.user - cpu0.user + cpu1.system - cpu0.system) / 1000;
  let heapDeltaBytes = null;
  if (gcForced && heapBefore !== null) {
    gc();
    heapDeltaBytes = heapUsed() - heapBefore;
  }
  return { samplesMs, warmupMs, totalMs, stoppedBy, gcForced, heapDeltaBytes, cpuMs };
}
