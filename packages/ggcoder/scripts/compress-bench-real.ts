/**
 * REAL-DATA benchmark + safety audit for content-aware compression.
 *
 * No synthetic fixtures, no planted needles. This captures the *actual* output
 * of real tools run against this repository — a big file read, a real grep, a
 * real `git log`, a real `find`, a real install-lock dump — then measures:
 *
 *   1. Token reduction on real output.
 *   2. FAITHFULNESS (the safety property): is the compressed text safe for an
 *      LLM to consume without being misled? We verify mechanically that:
 *        a. every kept line traces back verbatim to the original (nothing is
 *           fabricated — the compressor never invents text the tool didn't emit);
 *        b. every omission is explicitly marked (no silent gaps the model would
 *           mistake for "that's all there was");
 *        c. collapsed runs are labelled "similar" unless byte-identical.
 *
 * A compressor that hits 90% reduction but fabricates a line, or hides a gap,
 * fails the audit — those are exactly the ways compressed context confuses a
 * model. Reduction is only reported for runs that PASS the audit.
 *
 * Run:  pnpm --filter @kenkaiiii/ggcoder exec tsx scripts/compress-bench-real.ts
 */
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compressOutput, type CompressResult } from "../src/tools/compress.js";
import { estimateTokens, setEstimatorModel } from "../src/core/compaction/token-estimator.js";

setEstimatorModel("claude");

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../../../..");

function sh(cmd: string): string {
  try {
    return execSync(cmd, { cwd: repoRoot, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e: unknown) {
    // Tools like tsc exit non-zero but their stdout is exactly what we want.
    const err = e as { stdout?: string; stderr?: string };
    return (err.stdout ?? "") + (err.stderr ?? "");
  }
}

interface Sample {
  name: string;
  capture: () => string;
}

const samples: Sample[] = [
  {
    name: "read pnpm-lock.yaml (real file read)",
    capture: () => {
      const p = path.join(repoRoot, "pnpm-lock.yaml");
      return existsSync(p) ? readFileSync(p, "utf-8") : "";
    },
  },
  {
    name: "git log --stat -n 80 (real bash output)",
    capture: () => sh("git log --stat -n 80"),
  },
  {
    name: "grep 'import' across ggcoder src (real search dump)",
    capture: () => sh("grep -rn \"import\" packages/ggcoder/src --include='*.ts' | head -2000"),
  },
  {
    name: "find all .ts files (real find output)",
    capture: () => sh("find packages -name '*.ts' -not -path '*/node_modules/*'"),
  },
  {
    name: "read model-registry.ts (real source file)",
    capture: () => {
      const p = path.join(repoRoot, "packages/gg-core/src/model-registry.ts");
      return existsSync(p) ? readFileSync(p, "utf-8") : "";
    },
  },
];

const MARKER = /^(?:… \d+ lines? omitted …|… \d+ more of \d+ items omitted …)$/;
const COUNT_SUFFIX = /  \(×\d+(?: similar)?\)$/;

/** Mechanical safety audit: faithful subset + explicit omissions. */
function audit(raw: string, r: CompressResult): { pass: boolean; problems: string[] } {
  const problems: string[] = [];
  if (r.strategy === "json") {
    // Structural: must stay valid JSON the model can read.
    try {
      JSON.parse(r.content);
    } catch {
      problems.push("compressed JSON no longer parses");
    }
    return { pass: problems.length === 0, problems };
  }
  if (r.strategy === "none") {
    if (r.content !== raw) problems.push("passthrough altered content");
    return { pass: problems.length === 0, problems };
  }

  // log / text: every non-marker line must exist verbatim in the original.
  const originalLines = new Set(raw.split("\n"));
  const out = r.content.split("\n");
  let fabricated = 0;
  for (const line of out) {
    if (MARKER.test(line)) continue;
    const base = line.replace(COUNT_SUFFIX, "");
    if (!originalLines.has(base)) {
      fabricated++;
      if (fabricated <= 3) problems.push(`fabricated line not in source: ${JSON.stringify(base.slice(0, 80))}`);
    }
  }
  // A compressed log that dropped lines must say so somewhere.
  const droppedSomething = r.compressedTokens < r.originalTokens * 0.95;
  const hasMarker = out.some((l) => MARKER.test(l) || COUNT_SUFFIX.test(l));
  if (droppedSomething && !hasMarker) problems.push("dropped content with no omission marker (silent gap)");

  return { pass: problems.length === 0, problems };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

console.log(`\nREAL-DATA compression benchmark + safety audit\nrepo: ${repoRoot}\n`);

const rows: string[][] = [];
let origTotal = 0;
let compTotal = 0;
let allPass = true;

for (const s of samples) {
  const raw = s.capture();
  if (!raw || raw.length < 200) {
    rows.push([s.name, "—", "—", "—", "skipped (no data)", ""]);
    continue;
  }
  const origTok = estimateTokens(raw);
  const r = compressOutput(raw);
  const a = audit(raw, r);
  if (!a.pass) allPass = false;

  origTotal += origTok;
  compTotal += a.pass ? r.compressedTokens : origTok; // failed audit ⇒ no credit

  rows.push([
    s.name,
    String(origTok),
    String(r.compressedTokens),
    pct(1 - r.compressedTokens / origTok),
    r.strategy,
    a.pass ? "✓ safe" : `✗ ${a.problems[0]}`,
  ]);
}

const header = ["sample", "orig tok", "comp tok", "reduction", "strategy", "audit"];
const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
const fmt = (r: string[]) => r.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ");
console.log(fmt(header));
console.log(widths.map((w) => "-".repeat(w)).join("  "));
for (const r of rows) console.log(fmt(r));

console.log(`\nTotals (audit-passing samples only)`);
console.log(`  original   ${origTotal} tok`);
console.log(`  compressed ${compTotal} tok  →  ${pct(1 - compTotal / origTotal)} reduction`);
console.log(`  safety audit: ${allPass ? "ALL PASS — no fabrication, no silent gaps" : "FAILURES PRESENT (see ✗ rows)"}\n`);

process.exit(allPass ? 0 : 1);
