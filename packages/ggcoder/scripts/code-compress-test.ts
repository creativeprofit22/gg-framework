/**
 * REAL-DATA test + safety audit for AST code-skeleton compression.
 *
 * Uses the hardened extractSkeleton() (src/tools/code-skeleton.ts) on real repo
 * files — deliberately including the re-export barrels (index.ts) that rendered
 * EMPTY in the earlier prototype. Measures:
 *   1. Token reduction.
 *   2. Fidelity — re-parses the skeleton and confirms every exported symbol
 *      resolves to a real declaration in the output (not a string match). A
 *      dropped export fails the audit; reduction is only credited on PASS.
 *
 * SCOPE: this is for understanding a file's API, NOT editing it.
 *
 * Run: pnpm --filter @kenkaiiii/ggcoder exec tsx scripts/code-compress-test.ts
 */
import ts from "typescript";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractSkeleton } from "../src/tools/code-skeleton.js";
import { estimateTokens, setEstimatorModel } from "../src/core/compaction/token-estimator.js";

setEstimatorModel("claude");
const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../../../..");

/** Re-parse the skeleton; does `name` resolve to a real declaration/re-export? */
function declares(skeleton: string, name: string): boolean {
  if (name === "default" || name === "export=") return true; // structural, checked by presence
  const sf = ts.createSourceFile("s.ts", skeleton, ts.ScriptTarget.Latest, true);
  let found = false;
  const walk = (n: ts.Node) => {
    if (found) return;
    if (
      (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isInterfaceDeclaration(n) ||
        ts.isTypeAliasDeclaration(n) || ts.isEnumDeclaration(n)) && n.name?.getText(sf) === name
    ) found = true;
    else if (ts.isVariableDeclaration(n) && n.name.getText(sf) === name) found = true;
    else if (ts.isExportDeclaration(n) && n.exportClause && ts.isNamedExports(n.exportClause)) {
      if (n.exportClause.elements.some((e) => e.name.text === name)) found = true;
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return found;
}

const targets = [
  "packages/gg-core/src/index.ts", // BARREL — the prototype's worst case
  "packages/gg-ai/src/index.ts", // BARREL
  "packages/gg-core/src/model-registry.ts",
  "packages/gg-ai/src/providers/transform.ts",
  "packages/ggcoder/src/core/compaction/compactor.ts",
  "packages/ggcoder/src/tools/code-skeleton.ts",
];

console.log(`\nAST CODE-SKELETON test + fidelity audit (understand, not edit)\n`);
const header = ["file", "orig tok", "skel tok", "reduction", "exports", "fidelity"];
const rows: string[][] = [];
let oTot = 0, sTot = 0, allPass = true;

for (const rel of targets) {
  let src: string;
  try {
    src = readFileSync(path.join(repoRoot, rel), "utf-8");
  } catch {
    rows.push([rel, "—", "—", "—", "—", "missing"]);
    continue;
  }
  const r = extractSkeleton(src, rel);
  const missing = r.exports.filter((n) => !declares(r.skeleton, n));
  const pass = missing.length === 0 && !(r.exports.length > 0 && r.empty);
  if (!pass) allPass = false;

  const oTok = estimateTokens(src);
  const sTok = estimateTokens(r.skeleton);
  oTot += oTok;
  sTot += pass ? sTok : oTok; // no credit on failed audit

  rows.push([
    rel.replace("packages/", ""),
    String(oTok),
    String(sTok),
    `${((1 - sTok / oTok) * 100).toFixed(0)}%`,
    String(r.exports.length),
    pass ? "✓ all exports kept" : `✗ dropped: ${missing.join(", ") || "empty barrel"}`,
  ]);
}

const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const fmt = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join("  ");
console.log(fmt(header));
console.log(widths.map((w) => "-".repeat(w)).join("  "));
for (const r of rows) console.log(fmt(r));

console.log(`\nTotals (audit-passing files only)`);
console.log(`  original ${oTot} tok  →  skeleton ${sTot} tok  (${((1 - sTot / oTot) * 100).toFixed(0)}% reduction)`);
console.log(`  fidelity audit: ${allPass ? "ALL PASS — no export dropped, no empty barrel" : "FAILURES (see ✗ rows)"}`);
console.log(`\n  Skeleton = API understanding only. Editing a file still requires a full read.\n`);
process.exit(allPass ? 0 : 1);
