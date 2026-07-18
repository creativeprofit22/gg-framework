#!/usr/bin/env node
import { existsSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const PROTECTED_RELATIVE_PATHS = [
  ".gg/phase3a-cdp",
  ".gg/evidence",
  ".gg/screenshots",
  "node_modules",
  "gg-app/src-tauri/binaries",
];

export const TARGET_HELP = new Map([
  ["web", "gg-app/dist (Vite web build output)"],
  ["tauri", "gg-app/src-tauri/target/debug and target/release (Cargo build profiles)"],
  ["sidecar-deps", "gg-app/src-tauri/sidecar/node_modules (staged sidecar dependencies)"],
  ["tauri-schemas", "gg-app/src-tauri/gen/schemas (generated Tauri schema files)"],
  ["cache", ".eslintcache and gg-app/.eslintcache (ESLint cache files)"],
  ["packages", "packages/*/dist (workspace package build outputs)"],
]);

const HELP = `Usage: node scripts/audit-generated.mjs <target>

Targets:
${[...TARGET_HELP.entries()].map(([name, description]) => `  ${name.padEnd(24)} ${description}`).join("\n")}

Safety:
  This command only reports generated-artifact paths; it never changes files.
  Protected paths can never be selected:
    ${PROTECTED_RELATIVE_PATHS.join("\n    ")}
`;

function usage(exitCode = 0) {
  console.log(HELP);
  process.exit(exitCode);
}

export function parseArgs(argv) {
  const positional = [];

  for (const arg of argv) {
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") usage(0);
    if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    positional.push(arg);
  }

  if (positional.length !== 1) throw new Error("Expected exactly one audit target.");

  return { target: positional[0] };
}

function safePath(repoRoot, ...parts) {
  const absolute = resolve(repoRoot, ...parts);
  const rel = relative(repoRoot, absolute);

  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new Error(`Refusing to target a path outside the repository: ${absolute}`);
  }

  return absolute;
}

function isSameOrDescendant(path, parent) {
  const rel = relative(parent, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function assertProtectedPathsExcluded(repoRoot, paths) {
  const protectedPaths = PROTECTED_RELATIVE_PATHS.map((path) => safePath(repoRoot, path));

  for (const path of paths) {
    if (
      protectedPaths.some(
        (protectedPath) =>
          isSameOrDescendant(path, protectedPath) || isSameOrDescendant(protectedPath, path),
      )
    ) {
      throw new Error(`Refusing to select protected path: ${displayPath(repoRoot, path)}`);
    }
  }
}

async function packageDistPaths(repoRoot) {
  const packagesRoot = safePath(repoRoot, "packages");
  if (!existsSync(packagesRoot)) return [];

  const entries = await readdir(packagesRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => safePath(repoRoot, "packages", entry.name, "dist"));
}

export async function pathsFor(repoRoot, target) {
  let paths;

  switch (target) {
    case "web":
      paths = [safePath(repoRoot, "gg-app", "dist")];
      break;
    case "tauri":
      paths = [
        safePath(repoRoot, "gg-app", "src-tauri", "target", "debug"),
        safePath(repoRoot, "gg-app", "src-tauri", "target", "release"),
      ];
      break;
    case "sidecar-deps":
      paths = [safePath(repoRoot, "gg-app", "src-tauri", "sidecar", "node_modules")];
      break;
    case "tauri-schemas":
      paths = [safePath(repoRoot, "gg-app", "src-tauri", "gen", "schemas")];
      break;
    case "cache":
      paths = [safePath(repoRoot, ".eslintcache"), safePath(repoRoot, "gg-app", ".eslintcache")];
      break;
    case "packages":
      paths = await packageDistPaths(repoRoot);
      break;
    default:
      throw new Error(`Unknown audit target: ${target}`);
  }

  assertProtectedPathsExcluded(repoRoot, paths);
  return paths;
}

async function removablePath(path) {
  if (!existsSync(path)) return false;
  const stat = await lstat(path);
  return stat.isDirectory() || stat.isFile() || stat.isSymbolicLink();
}

function displayPath(repoRoot, path) {
  return relative(repoRoot, path).split(sep).join("/");
}

export async function auditGenerated({ repoRoot = defaultRepoRoot, target, log = console.log }) {
  if (!TARGET_HELP.has(target)) throw new Error(`Unknown audit target: ${target}`);

  const paths = await pathsFor(repoRoot, target);
  const existing = [];
  const missing = [];

  for (const path of paths) {
    if (await removablePath(path)) existing.push(path);
    else missing.push(path);
  }

  log("Generated-artifact audit:");
  for (const path of existing) log(`  - ${displayPath(repoRoot, path)}`);

  if (existing.length === 0) log(`  (no generated artifacts found for ${target})`);

  if (missing.length > 0) {
    log("Not present:");
    for (const path of missing) log(`  - ${displayPath(repoRoot, path)}`);
  }

  log("Protected paths (never selected):");
  for (const path of PROTECTED_RELATIVE_PATHS) log(`  - ${path}`);
}

async function main() {
  const { target } = parseArgs(process.argv.slice(2));
  await auditGenerated({ target });
}

const isDirectRun =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    console.error("Run with --help to list audit targets.");
    process.exitCode = 1;
  });
}
