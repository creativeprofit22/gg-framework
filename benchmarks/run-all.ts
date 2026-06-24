/**
 * Master benchmark runner.
 *
 * Usage:
 *   npx tsx benchmarks/run-all.ts           # Run all benchmarks
 *   npx tsx benchmarks/run-all.ts --table   # Show comparison table only
 */
import {
  bench,
  renderComparisonTable,
  renderDetailTable,
  compareResults,
  type BenchResult,
  type Comparison,
} from "./harness.js";
import { runEditBench } from "./02-edit-fuzzy.js";
import { runGrepBench } from "./03-grep-parallel.js";
import { runJsonRpcBench } from "./04-jsonrpc-buffer.js";
import { runStreamBench } from "./05-stream-buffer.js";
import { runAgentLoopBench } from "./06-agent-loop.js";
import { runLsBench } from "./07-ls-parallel.js";
import { runTokenEstimatorBench } from "./08-token-estimator.js";
import { runLspResolutionBench } from "./09-lsp-resolution.js";

const SUITES = [
  { name: "Edit Fuzzy Matching", fn: runEditBench },
  { name: "Grep Parallel Scanning", fn: runGrepBench },
  { name: "JSON-RPC Buffer", fn: runJsonRpcBench },
  { name: "StreamResult Buffer", fn: runStreamBench },
  { name: "Agent Loop Overhead", fn: runAgentLoopBench },
  { name: "ls Parallel stat", fn: runLsBench },
  { name: "Token Estimator", fn: runTokenEstimatorBench },
  { name: "LSP Server Resolution", fn: runLspResolutionBench },
];

async function main(): Promise<void> {
  const allResults: BenchResult[] = [];
  const comparisons: Comparison[] = [];

  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║     GG CODER BENCHMARK SUITE — Before & After        ║");
  console.log("╚══════════════════════════════════════════════════════╝");

  for (const suite of SUITES) {
    console.log(`\n${"═".repeat(60)}`);
    console.log(`  ▶ ${suite.name}`);
    console.log(`${"═".repeat(60)}`);

    let results: import("./harness.js").BenchResult[];
    try {
      results = await suite.fn();
    } catch (err) {
      console.log(`  ⚠ Skipped: ${(err as Error).message.split("\n")[0]}`);
      continue;
    }
    allResults.push(...results);

    // Print raw detail for this suite
    console.log(renderDetailTable(results, suite.name));

    // Pair sequential/current vs parallel/improved for comparison
    for (let i = 0; i + 1 < results.length; i += 2) {
      const before = results[i]!;
      const after = results[i + 1]!;
      // Only compare if names share a common prefix (before/after pair)
      const beforeKey = before.name.split("(")[0];
      const afterKey = after.name.split("(")[0];
      if (beforeKey.includes("current") || beforeKey.includes("sequential") || beforeKey.includes("before") ||
          beforeKey.includes("exact") || beforeKey.includes("buffer") || beforeKey.includes("sync") ||
          beforeKey.includes("cumulative") || beforeKey.includes("throughput") || beforeKey.includes("avg-error-current")) {
        comparisons.push(compareResults(before, after));
      }
    }
  }

  // Print comparison table
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║                 SUMMARY: Before → After               ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log(renderComparisonTable(comparisons));

  // Write results to JSON for trend tracking
  const output = {
    timestamp: new Date().toISOString(),
    results: allResults,
    comparisons: comparisons.map((c) => ({
      name: c.name,
      beforeMs: c.before.meanMs,
      afterMs: c.after.meanMs,
      speedup: c.speedup,
      deltaPercent: c.deltaPercent,
    })),
  };
  const fs = await import("node:fs");
  const path = await import("node:path");
  const outDir = path.join(process.cwd(), "benchmarks", "results");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `bench-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
  console.log(`\n  Results saved to: ${outFile}`);
}

main().catch(console.error);
