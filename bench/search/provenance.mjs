// Provenance owner: refuse to benchmark the wrong version, and capture the
// environment each run executed in. The guard is pure over injected command
// results so it can be unit-tested with temp git repos.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const TOOL_FILES = Object.freeze(["grep", "find", "read", "gitignore"]);

/**
 * When the orchestrator may touch the search tree. A cold session must not
 * read the tree before its measured call: hashing (or even stat-ing) every
 * file loads the OS file and metadata caches, which silently turns the cold
 * sample warm. Cold sessions therefore read only the manifest up front and
 * re-hash the full content after measuring.
 */
export function treeVerifySchedule(coldMethod, { fastVerify = false } = {}) {
  if (coldMethod !== "none") return { before: "manifest-only", perRun: "none", after: "full" };
  return { before: fastVerify ? "fast" : "full", perRun: "fast", after: "none" };
}

/** Why a cold session's samples cannot count, or undefined when they can. */
export function coldSessionProblem(meta) {
  if (!meta?.coldMethod || meta.coldMethod === "none") return undefined;
  const tree = meta.tree ?? {};
  if (tree.before !== "manifest-only")
    return `tree was read before the cold measurement (verify ${tree.before ?? tree.verify ?? "unknown"})`;
  if (!tree.after) return "no post-run tree content hash";
  if (tree.after.ok !== true)
    return `post-run tree content hash failed: ${(tree.after.problems ?? []).slice(0, 3).join("; ")}`;
  return undefined;
}

/**
 * Debug/smoke overrides that change what a session measures (cell subset,
 * wave count, soak length, open-loop step). `--fast-verify` is deliberately
 * absent: it only shortens the up-front tree check, not any measurement.
 */
export const HEADLINE_OVERRIDES = Object.freeze({
  onlyCells: "--only-cells",
  waves: "--waves",
  soakMs: "--soak-ms",
  openStepMs: "--open-step-ms",
});

/**
 * Why a session's samples cannot count as headline evidence because it ran
 * with smoke overrides, or undefined when they can. Reads `meta.overrides`;
 * older sessions without it fall back to the raw `meta.argv`.
 */
export function smokeSessionProblem(meta) {
  const found = [];
  if (meta?.overrides && typeof meta.overrides === "object") {
    for (const [key, flag] of Object.entries(HEADLINE_OVERRIDES))
      if (meta.overrides[key] !== undefined) found.push(`${flag} ${meta.overrides[key]}`);
  } else if (Array.isArray(meta?.argv)) {
    const flags = new Set(Object.values(HEADLINE_OVERRIDES));
    for (let i = 0; i < meta.argv.length; i++) {
      const [flag, inline] = String(meta.argv[i]).split(/=(.*)/s);
      if (!flags.has(flag)) continue;
      found.push(`${flag} ${inline ?? meta.argv[i + 1] ?? ""}`.trim());
    }
  }
  return found.length
    ? `smoke/debug overrides change the measurement (${found.join(", ")})`
    : undefined;
}

/**
 * Why a session's samples cannot count as headline evidence because it ran
 * the `pilot` profile (noise sizing only), or undefined when they can.
 */
export function pilotSessionProblem(meta) {
  return meta?.profile === "pilot" ? "pilot profile (noise sizing only)" : undefined;
}

/** Parse `label=path@sha` into a target descriptor. */
export function parseTarget(spec) {
  const m = /^([A-Za-z0-9_.-]+)=(.+)@([0-9a-f]{7,40})$/i.exec(spec ?? "");
  if (!m) throw new Error(`Invalid --target "${spec}". Expected label=path@sha`);
  return { label: m[1], worktree: path.resolve(m[2]), expectedCommit: m[3].toLowerCase() };
}

async function run(command, args, options = {}) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      windowsHide: true,
      timeout: options.timeout ?? 30_000,
      maxBuffer: 16 * 1024 * 1024,
      cwd: options.cwd,
    });
    return { ok: true, stdout: stdout.trim() };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout ?? "").trim(),
      error: error.code ?? error.message,
    };
  }
}

async function sha256File(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

async function mtimeMs(file) {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Check a target worktree. Returns { ok, reasons[], facts } — never throws for
 * expected refusals. `treeCheck` is the result of tree.verifyTree (optional).
 */
export async function checkTarget(target, { treeCheck } = {}) {
  const reasons = [];
  const facts = {
    label: target.label,
    worktree: target.worktree,
    expectedCommit: target.expectedCommit,
  };

  const head = await run("git", ["-C", target.worktree, "rev-parse", "HEAD"]);
  if (!head.ok) {
    reasons.push(`not a git worktree: ${target.worktree}`);
    return { ok: false, reasons, facts };
  }
  facts.commit = head.stdout;
  if (!facts.commit.toLowerCase().startsWith(target.expectedCommit)) {
    reasons.push(
      `commit mismatch: HEAD ${facts.commit} != expected ${target.expectedCommit} for "${target.label}"`,
    );
  }

  const status = await run("git", [
    "-C",
    target.worktree,
    "status",
    "--porcelain",
    "--untracked-files=normal",
  ]);
  facts.dirty = !status.ok || status.stdout.length > 0;
  if (facts.dirty)
    reasons.push(
      `worktree is dirty: ${status.ok ? status.stdout.split("\n").slice(0, 5).join("; ") : status.error}`,
    );

  const pkg = path.join(target.worktree, "packages", "ggcoder");
  facts.toolHashes = {};
  for (const name of TOOL_FILES) {
    const src = path.join(pkg, "src", "tools", `${name}.ts`);
    const dist = path.join(pkg, "dist", "tools", `${name}.js`);
    const [srcTime, distTime] = await Promise.all([mtimeMs(src), mtimeMs(dist)]);
    if (distTime === undefined) {
      reasons.push(`missing build output: ${dist}`);
      continue;
    }
    if (srcTime !== undefined && distTime < srcTime)
      reasons.push(`stale build output: ${dist} is older than its source`);
    facts.toolHashes[name] = {
      src: srcTime === undefined ? null : await sha256File(src),
      dist: await sha256File(dist),
    };
  }

  if (treeCheck) {
    facts.tree = { hash: treeCheck.treeHash ?? null };
    if (!treeCheck.ok)
      reasons.push(
        `search tree mismatch: ${(treeCheck.problems ?? ["hash differs"]).slice(0, 3).join("; ")}`,
      );
  }
  return { ok: reasons.length === 0, reasons, facts };
}

async function powershell(script) {
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: 30_000,
  });
}

/** Locate rg on PATH and read its version (null when unavailable). */
export async function detectRg() {
  const where = await run(process.platform === "win32" ? "where" : "which", ["rg"]);
  if (!where.ok || !where.stdout) return { available: false, path: null, version: null };
  const rgPath = where.stdout.split(/\r?\n/)[0];
  const version = await run(rgPath, ["--version"]);
  return {
    available: version.ok,
    path: rgPath,
    version: version.ok ? version.stdout.split(/\r?\n/)[0] : null,
  };
}

/** Capture machine/environment facts. Unreadable items are labelled, never guessed. */
export async function captureEnvironment() {
  const env = {
    node: process.version,
    platform: `${process.platform} ${os.release()}`,
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model ?? "unknown",
    totalMemMB: Math.round(os.totalmem() / 1048576),
    freeMemMB: Math.round(os.freemem() / 1048576),
    uptimeS: Math.round(os.uptime()),
    capturedAt: new Date().toISOString(),
  };
  if (process.platform !== "win32") return { ...env, windows: "not-windows" };

  // sc's labels are localized; the state keyword after the numeric code is not.
  const [plan, battery, sysmain, wsearch, defender, temp, admin] = await Promise.all([
    run("powercfg", ["/getactivescheme"]),
    powershell("(Get-CimInstance Win32_Battery | Measure-Object).Count"),
    run("sc", ["query", "SysMain"]),
    run("sc", ["query", "WSearch"]),
    powershell("(Get-MpComputerStatus).RealTimeProtectionEnabled"),
    powershell(
      "(Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop | Select-Object -First 1).CurrentTemperature",
    ),
    powershell(
      "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
    ),
  ]);
  const serviceState = (r) =>
    r.ok
      ? (/:\s*\d+\s+(RUNNING|STOPPED|START_PENDING|STOP_PENDING|PAUSED|CONTINUE_PENDING|PAUSE_PENDING)\b/.exec(
          r.stdout,
        )?.[1] ?? "unknown")
      : "not-installed-or-unreadable";
  const plans = {
    "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c": "High performance",
    "381b4222-f694-41f0-9685-ff5bb260df2e": "Balanced",
    "a1841308-3541-4fab-bc81-f71556f20b4a": "Power saver",
  };
  const planGuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
    .exec(plan.stdout ?? "")?.[0]
    ?.toLowerCase();
  const batteries = battery.ok ? Number(battery.stdout) : Number.NaN;
  const tempRaw = Number(temp.stdout);
  return {
    ...env,
    powerPlan: plan.ok && planGuid ? `${planGuid} (${plans[planGuid] ?? "custom"})` : "unreadable",
    acPower:
      batteries === 0
        ? "ac (no battery)"
        : Number.isFinite(batteries)
          ? "battery-present-check-manually"
          : "unreadable",
    sysMain: serviceState(sysmain),
    windowsSearch: serviceState(wsearch),
    defenderRealtime: defender.ok && defender.stdout ? defender.stdout : "unreadable",
    cpuTempC:
      temp.ok && Number.isFinite(tempRaw) && tempRaw > 0
        ? Math.round((tempRaw / 10 - 273.15) * 10) / 10
        : "unreadable-no-admin",
    admin: admin.ok ? admin.stdout === "True" : "unreadable",
  };
}
