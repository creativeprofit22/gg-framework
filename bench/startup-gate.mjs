#!/usr/bin/env node
// startup-gate — median CLI startup latency gate (fx-pattern CI ratchet).
// Measures `node packages/ggcoder/dist/cli.js --version` (fresh process each
// run), median of 5. Budget is deliberately generous (the Windows CI leg is a
// BLOCKING gate): max(baseline * 1.5, 5000ms) — this catches pathological
// regressions like sync I/O at import time, not 50ms scheduler noise.
// Usage:
//   node bench/startup-gate.mjs            # check against baseline
//   node bench/startup-gate.mjs --update   # re-baseline
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = path.join(REPO_ROOT, "bench/baseline/sizes.json");
const CLI = path.join(REPO_ROOT, "packages/ggcoder/dist/cli.js");
const RUNS = 5;
const HARD_FLOOR_MS = 5000;

const update = process.argv.slice(2).includes("--update");

let doc;
try {
  doc = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
} catch {
  doc = { artifacts: {} };
}
doc.startup ??= {};

const samples = [];
for (let i = 0; i < RUNS; i++) {
  const started = performance.now();
  const run = spawnSync(process.execPath, [CLI, "--version"], { encoding: "utf8" });
  const elapsed = performance.now() - started;
  if (run.status !== 0) {
    console.error(`✖ CLI exited ${run.status}: ${run.stderr?.slice(0, 300)}`);
    process.exit(1);
  }
  samples.push(elapsed);
}
samples.sort((a, b) => a - b);
const median = samples[Math.floor(samples.length / 2)];

const entry = doc.startup["cli-version"];
if (!entry) {
  console.log(`startup cli --version: ${median.toFixed(0)}ms (new baseline)`);
} else {
  const budget = Math.max(entry.ms * 1.5, HARD_FLOOR_MS);
  const verdict = median <= budget ? "ok" : "FAIL";
  console.log(
    `startup cli --version: median ${median.toFixed(0)}ms ` +
      `(baseline ${entry.ms.toFixed(0)}ms, budget ${budget.toFixed(0)}ms) ${verdict}`,
  );
  if (median > budget) {
    console.error(
      "\nStartup budget exceeded. If the regression is intentional, re-baseline with:\n" +
        "  node bench/startup-gate.mjs --update",
    );
    process.exit(1);
  }
}

if (update || !entry) {
  doc.startup["cli-version"] = { ms: median, recorded_at: new Date().toISOString() };
  await writeFile(BASELINE_PATH, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  if (update) console.log(`Baseline updated: ${path.relative(REPO_ROOT, BASELINE_PATH)}`);
}
