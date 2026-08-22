#!/usr/bin/env node
// size-gate — deterministic bundle-size regression gate (fx-pattern CI ratchet).
// Artifacts:
//   dist:ggcoder — total bytes of packages/ggcoder/dist (the shipped CLI).
//   sidecar      — app-sidecar.mjs + bundled skills bytes (gg-app/src-tauri/sidecar).
//                  Deliberately EXCLUDES node_modules: it carries platform-
//                  conditional binaries (sharp, onnxruntime), so one baseline
//                  cannot hold across the CI matrix's three OSes. Dependency-
//                  tree churn is still caught by the dist:ggcoder artifact.
// Usage:
//   node bench/size-gate.mjs                 # check all artifacts against baseline
//   node bench/size-gate.mjs --only sidecar  # check one artifact
//   node bench/size-gate.mjs --update        # re-baseline after an intentional change
// Fail rule: current > baseline + max(2%, 100KB). Shrinks pass and print a hint.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = path.join(REPO_ROOT, "bench/baseline/sizes.json");
const TOLERANCE = { relative: 0.02, absoluteBytes: 100 * 1024 };

/** Recursive byte total of a directory (or single file). */
function dirBytes(target) {
  const stat = statSync(target);
  if (stat.isFile()) return stat.size;
  return readdirSync(target).reduce(
    (total, entry) => total + dirBytes(path.join(target, entry)),
    0,
  );
}

const ARTIFACTS = {
  "dist:ggcoder": () => dirBytes(path.join(REPO_ROOT, "packages/ggcoder/dist")),
  sidecar: () =>
    dirBytes(path.join(REPO_ROOT, "gg-app/src-tauri/sidecar/app-sidecar.mjs")) +
    dirBytes(path.join(REPO_ROOT, "gg-app/src-tauri/sidecar/skills")),
};

const fmt = (bytes) => `${(bytes / 1024).toFixed(1)}KB`;
const args = process.argv.slice(2);
const update = args.includes("--update");
const onlyIndex = args.indexOf("--only");
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : undefined;

function loadBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  } catch {
    return { artifacts: {} };
  }
}

const baseline = await loadBaseline();
let failed = false;

const rows = [];
for (const [name, measure] of Object.entries(ARTIFACTS)) {
  if (only && name !== only) continue;
  let bytes;
  try {
    bytes = measure();
  } catch (error) {
    console.error(`✖ ${name}: artifact not built (${error.message})`);
    failed = true;
    continue;
  }
  const entry = baseline.artifacts[name];
  baseline.artifacts[name] = { bytes, recorded_at: new Date().toISOString() };

  if (!entry) {
    rows.push([name, "—", fmt(bytes), "new baseline"]);
    continue;
  }
  const allowed = entry.bytes + Math.max(entry.bytes * TOLERANCE.relative, TOLERANCE.absoluteBytes);
  const delta = bytes - entry.bytes;
  const verdict = bytes > allowed ? "FAIL" : delta < 0 ? "ok (ratchet down available)" : "ok";
  if (bytes > allowed) failed = true;
  rows.push([name, fmt(entry.bytes), fmt(bytes), verdict]);
}

const widths = [12, 12, 12, 28];
const header = ["artifact", "baseline", "current", "verdict"];
console.log(
  rows
    .map((row) => row.map((cell, i) => String(cell).padEnd(widths[i])).join(" "))
    .join("\n")
    .replace(/^/, `${header.map((cell, i) => cell.padEnd(widths[i])).join(" ")}\n`),
);

if (update) {
  await writeFile(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  console.log(`\nBaseline updated: ${path.relative(REPO_ROOT, BASELINE_PATH)}`);
} else if (failed) {
  console.error(
    "\nSize budget exceeded. If the growth is intentional, re-baseline with:\n" +
      "  node bench/size-gate.mjs --update",
  );
  process.exit(1);
}
