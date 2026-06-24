/**
 * Benchmark harness — high-resolution timing + statistical aggregation.
 *
 * Every benchmark runs N iterations, computes mean/median/p99, and
 * supports before/after comparison via the Reporter.
 */

export interface BenchResult {
  name: string;
  iterations: number;
  meanMs: number;
  medianMs: number;
  p99Ms: number;
  minMs: number;
  maxMs: number;
  stddevMs: number;
  /** Extra metrics (e.g. throughput, memory) */
  extra?: Record<string, number | string>;
}

export interface Comparison {
  name: string;
  before: BenchResult;
  after: BenchResult;
  speedup: number;
  deltaMs: number;
  deltaPercent: number;
}

const WARMUP_ITERATIONS = 3;

export async function bench(
  name: string,
  fn: () => Promise<void> | void,
  iterations = 50,
): Promise<BenchResult> {
  // Warmup — JIT optimization, cache priming
  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    await fn();
  }

  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint();
    await fn();
    const end = process.hrtime.bigint();
    times.push(Number(end - start) / 1_000_000); // ns → ms
  }

  times.sort((a, b) => a - b);
  const sum = times.reduce((a, b) => a + b, 0);
  const mean = sum / times.length;
  const median = times[Math.floor(times.length / 2)]!;
  const p99Idx = Math.min(times.length - 1, Math.ceil(times.length * 0.99) - 1);
  const variance = times.reduce((acc, t) => acc + (t - mean) ** 2, 0) / times.length;

  return {
    name,
    iterations,
    meanMs: round(mean),
    medianMs: round(median),
    p99Ms: round(times[p99Idx]!),
    minMs: round(times[0]!),
    maxMs: round(times.at(-1)!),
    stddevMs: round(Math.sqrt(variance)),
  };
}

export function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function compareResults(before: BenchResult, after: BenchResult): Comparison {
  const deltaMs = round(before.meanMs - after.meanMs);
  const speedup = round(before.meanMs / after.meanMs);
  const deltaPercent = round((deltaMs / before.meanMs) * 100);
  return {
    name: before.name,
    before,
    after,
    speedup,
    deltaMs,
    deltaPercent,
  };
}

// ── Table rendering ──

export function renderComparisonTable(comparisons: Comparison[]): string {
  const lines: string[] = [];

  // Header
  lines.push("");
  lines.push("┌────────────────────────────────────────────────────┬──────────────┬──────────────┬──────────┬─────────┐");
  lines.push("│ Benchmark                                          │   Before     │    After     │ Speedup  │   Δ %   │");
  lines.push("├────────────────────────────────────────────────────┼──────────────┼──────────────┼──────────┼─────────┤");

  for (const c of comparisons) {
    const name = c.name.padEnd(50).slice(0, 50);
    const before = `${c.before.meanMs}ms`.padStart(12).slice(0, 12);
    const after = `${c.after.meanMs}ms`.padStart(12).slice(0, 12);
    const speedup = `${c.speedup}×`.padStart(8).slice(0, 8);
    const delta = `-${c.deltaPercent}%`.padStart(7).slice(0, 7);
    lines.push(`│ ${name} │ ${before} │ ${after} │ ${speedup} │ ${delta} │`);
  }

  lines.push("└────────────────────────────────────────────────────┴──────────────┴──────────────┴──────────┴─────────┘");
  lines.push("");
  return lines.join("\n");
}

export function renderDetailTable(results: BenchResult[], label: string): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`  ${label}`);
  lines.push("  ┌──────────────────────────────────────────────┬────────┬────────┬────────┬────────┬────────┐");
  lines.push("  │ Benchmark                                    │  mean  │ median │  p99   │  min   │  max   │");
  lines.push("  ├──────────────────────────────────────────────┼────────┼────────┼────────┼────────┼────────┤");

  for (const r of results) {
    const name = r.name.padEnd(44).slice(0, 44);
    const fmt = (v: number) => `${v}ms`.padStart(6).slice(0, 6);
    lines.push(`  │ ${name} │ ${fmt(r.meanMs)} │ ${fmt(r.medianMs)} │ ${fmt(r.p99Ms)} │ ${fmt(r.minMs)} │ ${fmt(r.maxMs)} │`);
  }

  lines.push("  └──────────────────────────────────────────────┴────────┴────────┴────────┴────────┴────────┘");
  return lines.join("\n");
}

export function fmtMs(ms: number): string {
  if (ms < 1) return `${Math.round(ms * 1000)}μs`;
  if (ms < 1000) return `${round(ms)}ms`;
  return `${round(ms / 1000)}s`;
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${round(bytes / 1024)}KB`;
  return `${round(bytes / (1024 * 1024))}MB`;
}
