/**
 * Run all comparison benchmarks and print the final results table.
 * Runs both the original suite (edit-diff, ls, stream) and the new
 * suite (mixed-mode tools, diagnostic gating, markdown reparse).
 */
import { renderDetailTable, type BenchResult } from "./harness.js";
import { runComparisonBench } from "./comparison.js";
import { runMixedModeBench } from "./10-mixed-mode-tools.js";
import { runDiagnosticBench } from "./11-diagnostic-overhead.js";
import { runMarkdownBench } from "./12-markdown-reparse.js";

interface Comparison {
  name: string;
  beforeMs: number;
  afterMs: number;
  speedup: number;
}

async function main(): Promise<void> {
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║   GG CODER — FULL BENCHMARK SUITE (Before → After)    ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log("\n  Running all benchmarks... this takes ~3 minutes.\n");

  const allResults: BenchResult[] = [];
  const allComparisons: Comparison[] = [];

  // ── Suite 1: Core optimizations (edit-diff, ls, stream) ──
  console.log("  ▶ Core optimizations (edit-diff, ls, stream)...");
  const core = await runComparisonBench();
  allResults.push(...core.results);
  allComparisons.push(...core.comparisons);

  // ── Suite 2: Mixed-mode tool execution ──
  console.log("  ▶ Mixed-mode tool execution...");
  const mixed = await runMixedModeBench();
  allResults.push(...mixed.results);
  allComparisons.push(...mixed.comparisons);

  // ── Suite 3: Diagnostic overhead gating ──
  console.log("  ▶ Diagnostic char-count gating...");
  const diag = await runDiagnosticBench();
  allResults.push(...diag.results);
  allComparisons.push(...diag.comparisons);

  // ── Suite 4: Markdown re-parse cost ──
  console.log("  ▶ Markdown re-parse during streaming...");
  const md = await runMarkdownBench();
  allResults.push(...md.results);
  allComparisons.push(...md.comparisons);

  // ── Print detailed results ──
  console.log(renderDetailTable(allResults, "Detailed Results"));

  // ── Print summary table ──
  console.log("\n┌────────────────────────────────────────────────┬──────────────┬──────────────┬──────────┬─────────┐");
  console.log("│ Benchmark                                      │   Before     │    After     │ Speedup  │   Δ %   │");
  console.log("├────────────────────────────────────────────────┼──────────────┼──────────────┼──────────┼─────────┤");

  let totalSpeedup = 0;
  for (const c of allComparisons) {
    const name = c.name.padEnd(46).slice(0, 46);
    const before = `${c.beforeMs.toFixed(2)}ms`.padStart(12).slice(0, 12);
    const after = `${c.afterMs.toFixed(2)}ms`.padStart(12).slice(0, 12);
    const speedup = `${c.speedup}×`.padStart(8).slice(0, 8);
    const deltaPct = Math.round((1 - c.afterMs / c.beforeMs) * 100);
    const deltaStr = deltaPct >= 0 ? `-${deltaPct}%` : `+${Math.abs(deltaPct)}%`;
    const delta = deltaStr.padStart(7).slice(0, 7);
    console.log(`│ ${name} │ ${before} │ ${after} │ ${speedup} │ ${delta} │`);
    totalSpeedup += c.speedup;
  }

  console.log("└────────────────────────────────────────────────┴──────────────┴──────────────┴──────────┴─────────┘");

  console.log(`\n  Average speedup across all ${allComparisons.length} benchmarks: ${(totalSpeedup / allComparisons.length).toFixed(1)}×`);

  // ── Save results ──
  const fs = await import("node:fs");
  const path = await import("node:path");
  const outDir = path.join(process.cwd(), "benchmarks", "results");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `comparison-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    comparisons: allComparisons,
  }, null, 2));
  console.log(`\n  Saved to: ${outFile}\n`);
}

main().catch(console.error);
