#!/usr/bin/env node
import { existsSync } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TARGET_HELP = new Map([
  ["web", "gg-app/dist (Vite web build output)"],
  ["tauri", "gg-app/src-tauri/target (Rust/Tauri build output)"],
  ["tauri-schemas", "gg-app/src-tauri/gen/schemas (generated Tauri schema files)"],
  ["cache", ".eslintcache and gg-app/.eslintcache (ESLint cache files)"],
  ["packages", "packages/*/dist (workspace package build outputs)"],
  [
    "app-bundle-inputs-dangerous",
    "gg-app/src-tauri/sidecar and gg-app/src-tauri/binaries (explicit app bundle inputs)",
  ],
]);

const HELP = `Usage: node scripts/clean-generated.mjs <target> [--dry-run]

Targets:
${[...TARGET_HELP.entries()].map(([name, description]) => `  ${name.padEnd(29)} ${description}`).join("\n")}

Notes:
  --dry-run lists what would be removed without deleting anything.
  .gg is never removed by this script.
  app-bundle-inputs-dangerous removes bundle inputs; regenerate them with:
    pnpm --filter @kenkaiiii/ggcoder build
    pnpm --filter gg-app prebundle
`;

function usage(exitCode = 0) {
  console.log(HELP);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const flags = new Set();
  const positional = [];

  for (const arg of argv) {
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") usage(0);
    if (arg === "--dry-run" || arg === "-n") {
      flags.add("dry-run");
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    positional.push(arg);
  }

  if (positional.length !== 1) {
    throw new Error("Expected exactly one cleanup target.");
  }

  return { target: positional[0], dryRun: flags.has("dry-run") };
}

function safePath(...parts) {
  const absolute = resolve(repoRoot, ...parts);
  const rel = relative(repoRoot, absolute);

  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new Error(`Refusing to target a path outside the repository: ${absolute}`);
  }

  return absolute;
}

async function packageDistPaths() {
  const packagesRoot = safePath("packages");
  const entries = await readdir(packagesRoot, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => safePath("packages", entry.name, "dist"));
}

async function pathsFor(target) {
  switch (target) {
    case "web":
      return [safePath("gg-app", "dist")];
    case "tauri":
      return [safePath("gg-app", "src-tauri", "target")];
    case "tauri-schemas":
      return [safePath("gg-app", "src-tauri", "gen", "schemas")];
    case "cache":
      return [safePath(".eslintcache"), safePath("gg-app", ".eslintcache")];
    case "packages":
      return packageDistPaths();
    case "app-bundle-inputs-dangerous":
      return [
        safePath("gg-app", "src-tauri", "sidecar"),
        safePath("gg-app", "src-tauri", "binaries"),
      ];
    default:
      throw new Error(`Unknown cleanup target: ${target}`);
  }
}

async function removablePath(path) {
  if (!existsSync(path)) return false;

  const stat = await lstat(path);
  return stat.isDirectory() || stat.isFile() || stat.isSymbolicLink();
}

function displayPath(path) {
  return relative(repoRoot, path).split(sep).join("/");
}

async function main() {
  const { target, dryRun } = parseArgs(process.argv.slice(2));

  if (!TARGET_HELP.has(target)) {
    throw new Error(`Unknown cleanup target: ${target}`);
  }

  const paths = await pathsFor(target);
  const existing = [];
  const missing = [];

  for (const path of paths) {
    if (await removablePath(path)) existing.push(path);
    else missing.push(path);
  }

  const action = dryRun ? "Would remove" : "Removed";
  if (existing.length > 0) {
    console.log(`${action}:`);
    for (const path of existing) {
      console.log(`  - ${displayPath(path)}`);
      if (!dryRun) await rm(path, { recursive: true, force: true });
    }
  } else {
    console.log(`Nothing to remove for ${target}.`);
  }

  if (missing.length > 0) {
    console.log("Already clean:");
    for (const path of missing) console.log(`  - ${displayPath(path)}`);
  }

  if (target === "app-bundle-inputs-dangerous") {
    console.log("Regenerate bundle inputs with:");
    console.log("  pnpm --filter @kenkaiiii/ggcoder build");
    console.log("  pnpm --filter gg-app prebundle");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  console.error("Run with --help to list cleanup targets.");
  process.exit(1);
});
