// Load owner: closed waves, open-loop fixed-rate arrivals (coordinated-
// omission corrected), soak, unique per-call arguments and harness timeouts.
// Pure over an injected clock/sleep so the timing rules are unit-testable.
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { nonce, OPEN_LOOP, TOOL_LIMITS } from "./spec.mjs";

export const realClock = Object.freeze({
  now: () => performance.now(),
  sleepUntil: async (t) => {
    const wait = t - performance.now();
    if (wait > 0) await delay(wait);
  },
});

/**
 * Make one call's arguments unique without changing the work it does.
 * - grep, cap does not bind: max_results = cap + seq (cap never reached)
 * - grep, cap binds: pattern (?:base|nonce) with a nonce proven absent
 * - find: brace nonce alternative
 * - fixed-args: unchanged (measures nonce overhead; only safe outside the agent loop)
 */
export function uniqueArgs(query, seq, { capBinds, uniqueness = "unique" }) {
  const args = { ...query.args };
  if (uniqueness === "fixed-args") return { args, uniqueness: "fixed-args" };
  if (query.tool === "find") {
    return {
      args: { ...args, pattern: `{${args.pattern},**/${nonce(seq)}}` },
      uniqueness: "find-brace-nonce",
    };
  }
  if (query.tool !== "grep") return { args, uniqueness: "none" };
  if (!capBinds) {
    return {
      args: { ...args, max_results: TOOL_LIMITS.grepDefaultMaxResults + seq },
      uniqueness: "max-results",
    };
  }
  return {
    args: { ...args, pattern: `(?:${args.pattern}|${nonce(seq)})` },
    uniqueness: "pattern-nonce",
  };
}

/** Race a promise against a hard timeout; the loser is reported, never hidden. */
export async function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    // Deliberately ref'd: a hung call with no other pending I/O must still
    // surface as a harness timeout instead of letting the process exit.
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  try {
    return await Promise.race([promise.then((value) => ({ timedOut: false, value })), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Closed waves: each wave starts `concurrency` calls at once and waits for all.
 * The wave is the independent unit: callsPerSecond = concurrency / wallMs.
 * `makeCall({ seq, slot, wave })` resolves to a call record (never rejects).
 */
export async function runClosedWaves({
  concurrency,
  waves,
  warmupWaves = 0,
  makeCall,
  waveTimeoutMs,
  clock = realClock,
  onWave,
}) {
  const results = [];
  let seq = 0;
  for (let wave = 0; wave < warmupWaves + waves; wave++) {
    const startedAt = clock.now();
    const calls = [];
    for (let slot = 0; slot < concurrency; slot++) calls.push(makeCall({ seq: seq++, slot, wave }));
    const settled = await withTimeout(Promise.all(calls), waveTimeoutMs);
    const wallMs = clock.now() - startedAt;
    const record = {
      wave,
      warmup: wave < warmupWaves,
      concurrency,
      startedAt,
      wallMs,
      timedOut: settled.timedOut,
      callsPerSecond: settled.timedOut ? 0 : concurrency / (wallMs / 1000),
      calls: settled.timedOut ? [] : settled.value,
    };
    results.push(record);
    await onWave?.(record);
    if (settled.timedOut) break;
  }
  return results;
}

/** Intended start times for a fixed arrival rate (ms offsets from t0). */
export function openLoopSchedule(ratePerSecond, durationMs) {
  const count = Math.floor((ratePerSecond * durationMs) / 1000);
  return Array.from({ length: count }, (_, i) => (i * 1000) / ratePerSecond);
}

/**
 * Open loop at a fixed rate. Each call keeps its INTENDED start, so a stalled
 * system accrues queueing delay in `latencyMs` instead of silently slowing the
 * generator (coordinated omission). Calls over `maxOutstanding` are counted as
 * overflow, not dropped silently.
 */
export async function runOpenLoopStep({
  ratePerSecond,
  durationMs,
  makeCall,
  clock = realClock,
  maxOutstanding = OPEN_LOOP.maxOutstanding,
  seqStart = 0,
}) {
  const t0 = clock.now();
  const schedule = openLoopSchedule(ratePerSecond, durationMs);
  const pending = [];
  const records = [];
  let outstanding = 0;
  let overflow = 0;
  for (let i = 0; i < schedule.length; i++) {
    const intendedStart = t0 + schedule[i];
    await clock.sleepUntil(intendedStart);
    if (outstanding >= maxOutstanding) {
      overflow++;
      records.push({
        seq: seqStart + i,
        intendedStart,
        actualStart: null,
        end: null,
        overflow: true,
      });
      continue;
    }
    const actualStart = clock.now();
    outstanding++;
    const seq = seqStart + i;
    pending.push(
      Promise.resolve(makeCall({ seq, slot: i, wave: null })).then((call) => {
        outstanding--;
        const end = clock.now();
        records.push({
          seq,
          intendedStart,
          actualStart,
          end,
          latencyMs: end - intendedStart,
          serviceMs: end - actualStart,
          startLagMs: actualStart - intendedStart,
          call,
        });
      }),
    );
  }
  const generatorEnd = clock.now();
  await Promise.all(pending);
  records.sort((a, b) => a.seq - b.seq);
  const completed = records.filter((r) => !r.overflow);
  const stepEnd = clock.now();
  return {
    ratePerSecond,
    durationMs,
    scheduled: schedule.length,
    overflow,
    generatorLagMs: generatorEnd - (t0 + durationMs),
    completionRate: completed.length / Math.max(1e-9, (stepEnd - t0) / 1000),
    records,
  };
}

/**
 * Knee = first step whose p99 exceeds factor × the lowest-rate p99, or whose
 * completion rate falls below ratio × the arrival rate.
 */
export function detectKnee(
  steps,
  percentile,
  { p99Factor = OPEN_LOOP.kneeP99Factor, completionRatio = OPEN_LOOP.kneeCompletionRatio } = {},
) {
  if (steps.length === 0) return null;
  const p99Of = (s) =>
    percentile(
      s.records.filter((r) => !r.overflow).map((r) => r.latencyMs),
      0.99,
    );
  const baseP99 = p99Of(steps[0]);
  for (const step of steps) {
    const p99 = p99Of(step);
    const reason =
      step.overflow > 0
        ? "overflow"
        : p99 > p99Factor * baseP99
          ? "p99"
          : step.completionRate < completionRatio * step.ratePerSecond
            ? "completion-rate"
            : null;
    if (reason) return { ratePerSecond: step.ratePerSecond, reason, p99, baseP99 };
  }
  return { ratePerSecond: null, reason: "no-knee-within-ladder", baseP99 };
}

/** Closed loop for a fixed duration with `concurrency` independent loops (soak). */
export async function runSoak({
  concurrency,
  durationMs,
  makeCall,
  clock = realClock,
  sample,
  sampleEveryMs = 1_000,
}) {
  const t0 = clock.now();
  const samples = [];
  let seq = 0;
  let done = false;
  const loops = Array.from({ length: concurrency }, async (_, slot) => {
    const calls = [];
    while (clock.now() - t0 < durationMs)
      calls.push(await makeCall({ seq: seq++, slot, wave: null }));
    return calls;
  });
  const sampler = (async () => {
    while (!done) {
      samples.push({ t: clock.now() - t0, ...sample() });
      await clock.sleepUntil(clock.now() + sampleEveryMs);
    }
  })();
  const perLoop = await Promise.all(loops);
  done = true;
  await sampler;
  samples.push({ t: clock.now() - t0, ...sample() });
  return { calls: perLoop.flat(), samples };
}
