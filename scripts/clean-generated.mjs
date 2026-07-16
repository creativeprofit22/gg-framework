#!/usr/bin/env node
import { existsSync } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

export function parseArgs(argv) {
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

function safePath(repoRoot, ...parts) {
  const absolute = resolve(repoRoot, ...parts);
  const rel = relative(repoRoot, absolute);

  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new Error(`Refusing to target a path outside the repository: ${absolute}`);
  }

  return absolute;
}

async function packageDistPaths(repoRoot) {
  const packagesRoot = safePath(repoRoot, "packages");
  const entries = await readdir(packagesRoot, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => safePath(repoRoot, "packages", entry.name, "dist"));
}

async function pathsFor(repoRoot, target) {
  switch (target) {
    case "web":
      return [safePath(repoRoot, "gg-app", "dist")];
    case "tauri":
      return [safePath(repoRoot, "gg-app", "src-tauri", "target")];
    case "tauri-schemas":
      return [safePath(repoRoot, "gg-app", "src-tauri", "gen", "schemas")];
    case "cache":
      return [safePath(repoRoot, ".eslintcache"), safePath(repoRoot, "gg-app", ".eslintcache")];
    case "packages":
      return packageDistPaths(repoRoot);
    case "app-bundle-inputs-dangerous":
      return [
        safePath(repoRoot, "gg-app", "src-tauri", "sidecar"),
        safePath(repoRoot, "gg-app", "src-tauri", "binaries"),
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

function displayPath(repoRoot, path) {
  return relative(repoRoot, path).split(sep).join("/");
}

export async function cleanGenerated({
  repoRoot = defaultRepoRoot,
  target,
  dryRun = false,
  log = console.log,
}) {
  if (!TARGET_HELP.has(target)) {
    throw new Error(`Unknown cleanup target: ${target}`);
  }

  const paths = await pathsFor(repoRoot, target);
  const existing = [];
  const missing = [];

  for (const path of paths) {
    if (await removablePath(path)) existing.push(path);
    else missing.push(path);
  }

  const action = dryRun ? "Would remove" : "Removed";
  if (existing.length > 0) {
    log(`${action}:`);
    for (const path of existing) {
      log(`  - ${displayPath(repoRoot, path)}`);
      if (!dryRun) await rm(path, { recursive: true, force: true });
    }
  } else {
    log(`Nothing to remove for ${target}.`);
  }

  if (missing.length > 0) {
    log("Already clean:");
    for (const path of missing) log(`  - ${displayPath(repoRoot, path)}`);
  }

  if (target === "app-bundle-inputs-dangerous") {
    log("Regenerate bundle inputs with:");
    log("  pnpm --filter @kenkaiiii/ggcoder build");
    log("  pnpm --filter gg-app prebundle");
  }
}

async function main() {
  const { target, dryRun } = parseArgs(process.argv.slice(2));
  await cleanGenerated({ target, dryRun });
}

const isDirectRun =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    console.error("Run with --help to list cleanup targets.");
    process.exitCode = 1;
  });
}
