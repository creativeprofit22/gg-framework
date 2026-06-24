/**
 * Benchmark: today's blunt truncation vs content-aware compression.
 *
 * Two axes, because token savings alone is a vanity metric for a coding agent:
 *   1. Token reduction   — how many fewer tokens reach the model.
 *   2. Fidelity          — did the *signal the agent needs* survive?
 *
 * Each fixture embeds "needles": strings the agent would have to read to do its
 * job (the FATAL line, the failing assertion, a specific value in a JSON blob).
 * A compressor that scores 95% reduction but eats a needle is a correctness bug,
 * not a win. We score both methods on both axes and print a table.
 *
 * Run:  pnpm --filter @kenkaiiii/ggcoder exec tsx scripts/compress-bench.ts
 */
import { truncateTail, truncateHead } from "../src/tools/truncate.js";
import { compressOutput } from "../src/tools/compress.js";
import { estimateTokens, setEstimatorModel } from "../src/core/compaction/token-estimator.js";

setEstimatorModel("claude");

interface Fixture {
  name: string;
  kind: "log" | "json" | "code" | "search";
  /** How the live tool would surface this output (head = read, tail = bash). */
  end: "head" | "tail";
  build: () => string;
  /** Facts the agent must still be able to read after compression. */
  needles: string[];
}

const rand = (() => {
  let s = 42;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
})();

const fixtures: Fixture[] = [
  {
    name: "build log — FATAL in the middle",
    kind: "log",
    end: "tail",
    needles: ["FATAL: heap allocation failed at chunk 8821", "module=renderer"],
    build: () => {
      const lines: string[] = [];
      for (let i = 0; i < 5000; i++) {
        const t = `2026-06-22T10:${String(i % 60).padStart(2, "0")}:00Z`;
        if (i === 2600) lines.push(`${t} ERROR module=renderer FATAL: heap allocation failed at chunk 8821`);
        else lines.push(`${t} INFO  compiled module ${i} ok (${Math.floor(rand() * 200)}ms)`);
      }
      return lines.join("\n");
    },
  },
  {
    name: "test runner — 1 fail in 2000 pass",
    kind: "log",
    end: "tail",
    needles: ["✗ user-auth › rejects expired token", "Expected 401 but received 200"],
    build: () => {
      const lines: string[] = [];
      for (let i = 0; i < 2000; i++) {
        if (i === 1450) {
          lines.push(`✗ user-auth › rejects expired token`);
          lines.push(`  AssertionError: Expected 401 but received 200`);
          lines.push(`    at Object.<anonymous> (auth.test.ts:88:14)`);
        } else lines.push(`✓ suite-${i % 50} › case ${i} (${Math.floor(rand() * 12)}ms)`);
      }
      return lines.join("\n");
    },
  },
  {
    name: "repeated retry spam (collapsible)",
    kind: "log",
    end: "tail",
    needles: ["Connection refused: postgres:5432", "giving up after 200 attempts"],
    build: () => {
      const lines: string[] = [];
      lines.push("starting worker pool");
      for (let i = 0; i < 200; i++) lines.push("WARN retry: Connection refused: postgres:5432");
      lines.push("ERROR giving up after 200 attempts");
      return lines.join("\n");
    },
  },
  {
    name: "large JSON array (find/grep style)",
    kind: "json",
    end: "head",
    needles: ['"path": "src/core/auth.ts"', '"total": 412'],
    build: () => {
      const matches = [];
      for (let i = 0; i < 412; i++) {
        matches.push({
          path: i === 3 ? "src/core/auth.ts" : `src/gen/file-${i}.ts`,
          line: Math.floor(rand() * 400),
          text: `const x${i} = doThing(${i});`,
        });
      }
      return JSON.stringify({ total: 412, matches }, null, 2);
    },
  },
  {
    name: "source file read (code)",
    kind: "code",
    end: "head",
    needles: ["export function resolvePath", "throw new Error(\"path escapes root\")"],
    build: () => {
      const lines: string[] = [];
      lines.push(`import path from "node:path";`);
      lines.push(`export function resolvePath(p: string, root: string): string {`);
      lines.push(`  const resolved = path.resolve(root, p);`);
      lines.push(`  if (!resolved.startsWith(root)) throw new Error("path escapes root");`);
      lines.push(`  return resolved;`);
      lines.push(`}`);
      for (let i = 0; i < 3000; i++) lines.push(`function helper${i}() { return ${i}; }`);
      return lines.join("\n");
    },
  },
];

function countSurvived(output: string, needles: string[]): number {
  return needles.filter((n) => output.includes(n)).length;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

console.log(`\nCompression benchmark — baseline truncation vs content-aware compress\n`);
const header = ["fixture", "orig tok", "trunc tok", "trunc keep", "comp tok", "comp keep", "strat"];
const rows: string[][] = [];

let baseTokTotal = 0;
let truncTokTotal = 0;
let compTokTotal = 0;
let truncNeedles = 0;
let compNeedles = 0;
let totalNeedles = 0;

for (const f of fixtures) {
  const raw = f.build();
  const origTok = estimateTokens(raw);

  const truncated = (f.end === "tail" ? truncateTail(raw) : truncateHead(raw)).content;
  const compressed = compressOutput(raw);

  const truncTok = estimateTokens(truncated);
  const compTok = compressed.compressedTokens;

  const tSurv = countSurvived(truncated, f.needles);
  const cSurv = countSurvived(compressed.content, f.needles);

  baseTokTotal += origTok;
  truncTokTotal += truncTok;
  compTokTotal += compTok;
  truncNeedles += tSurv;
  compNeedles += cSurv;
  totalNeedles += f.needles.length;

  rows.push([
    f.name,
    String(origTok),
    String(truncTok),
    `${tSurv}/${f.needles.length}`,
    String(compTok),
    `${cSurv}/${f.needles.length}`,
    compressed.strategy,
  ]);
}

// Pretty print
const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const fmt = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join("  ");
console.log(fmt(header));
console.log(widths.map((w) => "-".repeat(w)).join("  "));
for (const r of rows) console.log(fmt(r));

console.log(`\nTotals`);
console.log(`  original tokens          ${baseTokTotal}`);
console.log(
  `  truncation               ${truncTokTotal} tok  (${pct(1 - truncTokTotal / baseTokTotal)} reduction)  ` +
    `fidelity ${truncNeedles}/${totalNeedles} (${pct(truncNeedles / totalNeedles)})`,
);
console.log(
  `  content-aware compress   ${compTokTotal} tok  (${pct(1 - compTokTotal / baseTokTotal)} reduction)  ` +
    `fidelity ${compNeedles}/${totalNeedles} (${pct(compNeedles / totalNeedles)})`,
);
console.log(
  `\n  → compress keeps ${pct(compNeedles / totalNeedles)} of needles at ` +
    `${pct(1 - compTokTotal / baseTokTotal)} reduction; truncation keeps ${pct(truncNeedles / totalNeedles)}.\n`,
);
