import nodeFs from "node:fs";
import os from "node:os";
import path from "node:path";

// One temp folder per test run. Vitest loads this as globalSetup; node:test
// scripts use with-run-temp.mjs. Leftovers from killed runs are swept later.
export const RUN_DIR_PREFIX = "ggt-";
// ggt-<start ms, base36>-<pid>-<6-char mkdtemp suffix>
export const RUN_DIR_PATTERN = /^ggt-([0-9a-z]+)-([0-9]+)-[A-Za-z0-9]{6}$/;
export const LEFTOVER_AGE_MS = 3_600_000;
export const RUN_TEMP_ENV = "GG_TEST_RUN_TEMP";
export const RUN_TEMP_BASE_ENV = "GG_TEST_RUN_TEMP_BASE";
const MANAGED_ENV = ["TEMP", "TMP", "TMPDIR", RUN_TEMP_ENV, RUN_TEMP_BASE_ENV];
const STATE_KEY = Symbol.for("gg.test-support.run-temp");

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return error?.code === "EPERM";
  }
}

export function parseRunDirName(name) {
  const match = RUN_DIR_PATTERN.exec(name);
  if (!match) return null;
  const startMs = Number.parseInt(match[1], 36);
  const pid = Number(match[2]);
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(pid)) return null;
  return { startMs, pid };
}

export function removeRunDir(dir, { fs = nodeFs, warn = defaultWarn } = {}) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return true;
  } catch (error) {
    warn(`[run-temp] could not remove ${dir} (${error?.code ?? error}); a later run will sweep it`);
    return false;
  }
}

export function sweepLeftoverRuns({
  base,
  now = Date.now(),
  isAlive = isProcessAlive,
  fs = nodeFs,
  keep,
  warn = defaultWarn,
} = {}) {
  const removed = [];
  const skipped = [];
  let names;
  try {
    names = fs.readdirSync(base);
  } catch {
    return { removed, skipped };
  }
  const keepPath = keep ? path.resolve(keep) : null;
  for (const name of names) {
    const parsed = parseRunDirName(name);
    if (!parsed) continue;
    const dir = path.join(base, name);
    if (keepPath && path.resolve(dir) === keepPath) {
      skipped.push({ dir, reason: "current" });
      continue;
    }
    let stat;
    try {
      stat = fs.lstatSync(dir);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
    if (now - parsed.startMs < LEFTOVER_AGE_MS) {
      skipped.push({ dir, reason: "recent" });
      continue;
    }
    if (isAlive(parsed.pid)) {
      skipped.push({ dir, reason: "alive" });
      continue;
    }
    if (removeRunDir(dir, { fs, warn })) removed.push(dir);
    else skipped.push({ dir, reason: "locked" });
  }
  return { removed, skipped };
}

function defaultWarn(message) {
  console.warn(message);
}

function stateFor(holder) {
  holder[STATE_KEY] ??= { count: 0, dir: null, saved: null };
  return holder[STATE_KEY];
}

export function startRunTemp({
  env = process.env,
  fs = nodeFs,
  now = Date.now,
  pid = process.pid,
  isAlive = isProcessAlive,
  warn = defaultWarn,
  tmpdir = os.tmpdir,
  stateHolder = globalThis,
} = {}) {
  const state = stateFor(stateHolder);
  if (state.count > 0) {
    state.count += 1;
    return state.dir;
  }
  // A nested run keeps the real base so folders never nest and stay sweepable.
  const base = env[RUN_TEMP_BASE_ENV] || tmpdir();
  const startMs = now();
  sweepLeftoverRuns({ base, now: startMs, isAlive, fs, keep: env[RUN_TEMP_ENV], warn });
  const dir = fs.mkdtempSync(path.join(base, `${RUN_DIR_PREFIX}${startMs.toString(36)}-${pid}-`));
  state.saved = Object.fromEntries(MANAGED_ENV.map((key) => [key, env[key]]));
  env.TEMP = dir;
  env.TMP = dir;
  env.TMPDIR = dir;
  env[RUN_TEMP_ENV] = dir;
  env[RUN_TEMP_BASE_ENV] = base;
  state.dir = dir;
  state.count = 1;
  return dir;
}

export function stopRunTemp({
  env = process.env,
  fs = nodeFs,
  warn = defaultWarn,
  stateHolder = globalThis,
} = {}) {
  const state = stateFor(stateHolder);
  if (state.count === 0) return { dir: null, removed: false };
  state.count -= 1;
  if (state.count > 0) return { dir: state.dir, removed: false };
  const dir = state.dir;
  for (const [key, value] of Object.entries(state.saved ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  state.dir = null;
  state.saved = null;
  return { dir, removed: removeRunDir(dir, { fs, warn }) };
}

export function setup() {
  startRunTemp();
}

export function teardown() {
  stopRunTemp();
}
