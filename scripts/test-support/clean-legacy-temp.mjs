import { execFileSync } from "node:child_process";
import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  LEFTOVER_AGE_MS,
  RUN_DIR_PATTERN,
  RUN_TEMP_BASE_ENV,
  isProcessAlive,
  parseRunDirName,
} from "./run-temp.mjs";

// One-time cleanup of test temp folders left in the real temp folder before
// run-temp existed. Lists by default; deletes only with --apply.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE_GLOBS = ["*.ts", "*.tsx", "*.mjs", "*.js", "*.cjs"];
// mkdtemp(<x>.join|resolve(<y>.tmpdir(), "<prefix>")) with a literal prefix.
const MKDTEMP_CALL = /mkdtemp(?:Sync)?\(/g;
const TMPDIR_PREFIX_CALL =
  /^mkdtemp(?:Sync)?\(\s*(?:[A-Za-z_$][\w$]*\.)?(?:join|resolve)\(\s*(?:[A-Za-z_$][\w$]*\.)?tmpdir\(\)\s*,\s*(["'`])([^"'`]*)\1\s*,?\s*\)/;
// Node fills mkdtemp's six X's from [A-Za-z0-9].
const MKDTEMP_SUFFIX = "[A-Za-z0-9]{6}";
const MIN_LITERAL_PREFIX = 3;

export function extractMkdtempPrefixes(sourceText) {
  const prefixes = new Set();
  let unresolved = 0;
  for (const call of sourceText.matchAll(MKDTEMP_CALL)) {
    const match = TMPDIR_PREFIX_CALL.exec(sourceText.slice(call.index, call.index + 400));
    if (match && match[2].length > 0) prefixes.add(match[2]);
    else unresolved += 1;
  }
  return { prefixes: [...prefixes], unresolved };
}

export function collectRepoPrefixes({ repoRoot = REPO_ROOT, fs = nodeFs } = {}) {
  const listed = execFileSync("git", ["grep", "-l", "mkdtemp", "--", ...SOURCE_GLOBS], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const prefixes = new Set();
  let unresolved = 0;
  for (const file of listed.split("\n").filter(Boolean)) {
    const result = extractMkdtempPrefixes(fs.readFileSync(path.join(repoRoot, file), "utf8"));
    for (const prefix of result.prefixes) prefixes.add(prefix);
    unresolved += result.unresolved;
  }
  return { prefixes: [...prefixes].sort(), unresolved };
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Template parts like `${name}` match one path segment; the literal part
// before the first placeholder must be long enough to stay specific.
export function compilePrefixMatcher(prefixes) {
  const rules = [];
  for (const prefix of prefixes) {
    if (/[\\/]/.test(prefix)) continue;
    const parts = prefix.split(/\$\{[^}]*\}/);
    if (parts[0].length < MIN_LITERAL_PREFIX) continue;
    const body = parts.map(escapeRegExp).join("[^\\\\/]+");
    rules.push({ prefix, pattern: new RegExp(`^${body}${MKDTEMP_SUFFIX}$`) });
  }
  return (name) => {
    if (RUN_DIR_PATTERN.test(name)) return "ggt-";
    // Longest prefix wins so per-prefix totals are attributed specifically.
    let best = null;
    for (const rule of rules) {
      if (rule.pattern.test(name) && (!best || rule.prefix.length > best.length)) {
        best = rule.prefix;
      }
    }
    return best;
  };
}

function directorySize(dir, fs) {
  let bytes = 0;
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      try {
        const stat = fs.lstatSync(full);
        // Never follow links or junctions out of the folder.
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) pending.push(full);
        else bytes += stat.size;
      } catch {
        // Vanished or locked entries don't count.
      }
    }
  }
  return bytes;
}

export function findCandidates({
  base,
  matcher,
  now = Date.now(),
  minAgeMs = LEFTOVER_AGE_MS,
  isAlive = isProcessAlive,
  fs = nodeFs,
}) {
  const candidates = [];
  for (const name of fs.readdirSync(base)) {
    const prefix = matcher(name);
    if (!prefix) continue;
    const full = path.join(base, name);
    let stat;
    try {
      stat = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
    if (prefix === "ggt-") {
      const run = parseRunDirName(name);
      if (!run || now - run.startMs < minAgeMs || isAlive(run.pid)) continue;
    } else if (now - stat.mtimeMs < minAgeMs) {
      continue;
    }
    candidates.push({ name, path: full, prefix, bytes: directorySize(full, fs) });
  }
  return candidates.sort((a, b) => a.name.localeCompare(b.name));
}

export function summarize(candidates) {
  const byPrefix = new Map();
  let bytes = 0;
  for (const candidate of candidates) {
    const entry = byPrefix.get(candidate.prefix) ?? {
      prefix: candidate.prefix,
      count: 0,
      bytes: 0,
    };
    entry.count += 1;
    entry.bytes += candidate.bytes;
    byPrefix.set(candidate.prefix, entry);
    bytes += candidate.bytes;
  }
  const rows = [...byPrefix.values()].sort(
    (a, b) => b.bytes - a.bytes || a.prefix.localeCompare(b.prefix),
  );
  return { count: candidates.length, bytes, rows };
}

export function removeCandidates(candidates, { fs = nodeFs } = {}) {
  let removed = 0;
  let freed = 0;
  const failed = [];
  for (const candidate of candidates) {
    try {
      fs.rmSync(candidate.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      removed += 1;
      freed += candidate.bytes;
    } catch (error) {
      failed.push({ path: candidate.path, code: error?.code ?? String(error) });
    }
  }
  return { removed, freed, failed };
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function parseArgs(argv) {
  const options = { apply: false, base: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--base" && argv[index + 1]) options.base = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

export function main(
  argv = process.argv.slice(2),
  { env = process.env, log = console.log, repoRoot = REPO_ROOT, now = Date.now() } = {},
) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    log(`${error.message}\nusage: clean-legacy-temp.mjs [--apply] [--base <temp folder>]`);
    return 2;
  }
  // Inside a test run os.tmpdir() is the run folder, so prefer the real base.
  const base = path.resolve(options.base ?? env[RUN_TEMP_BASE_ENV] ?? os.tmpdir());
  if (!nodeFs.statSync(base, { throwIfNoEntry: false })?.isDirectory()) {
    log(`temp folder not found: ${base}`);
    return 2;
  }
  const { prefixes, unresolved } = collectRepoPrefixes({ repoRoot });
  const candidates = findCandidates({ base, matcher: compilePrefixMatcher(prefixes), now });
  const summary = summarize(candidates);
  log(`Temp folder: ${base}`);
  log(
    `Allowlist: ${prefixes.length} mkdtemp prefixes (+ ggt- runs); ${unresolved} calls skipped (no literal prefix)`,
  );
  for (const row of summary.rows) {
    log(`  ${row.prefix.padEnd(40)} ${String(row.count).padStart(5)}  ${formatBytes(row.bytes)}`);
  }
  log(`Total: ${summary.count} folders, ${formatBytes(summary.bytes)} (older than 1 hour)`);
  if (!options.apply) {
    log("List only; nothing deleted. Re-run with --apply to delete these folders.");
    return 0;
  }
  const result = removeCandidates(candidates);
  log(`Removed ${result.removed} folders, freed ${formatBytes(result.freed)}.`);
  for (const failure of result.failed) log(`  could not remove ${failure.path} (${failure.code})`);
  return result.failed.length > 0 ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
