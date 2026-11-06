// @ts-check
// Default sandbox: a plain child process with
//   - a per-sample folder: input/ (a COPY of the workload item, so a candidate
//     can't change the frozen workload), out/ (its outputs), tmp/ (TEMP/TMP)
//   - a scrubbed environment: only an allowlist of OS basics plus variables
//     the study names explicitly. API keys and test-runner context
//     (NODE_OPTIONS, NODE_TEST_CONTEXT, VITEST_*, ...) never leak in.
//   - a hard timeout that kills the whole process tree
// This is isolation against accidents, not a security boundary: use the
// docker sandbox for untrusted candidates.
import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { cp, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { samplePeakMemory } from "../sampler.mjs";

export const ENV_ALLOWLIST = Object.freeze([
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "OS",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "CommonProgramFiles",
  "ProgramData",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "HOME",
  "USER",
  "USERNAME",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
]);
const TEMP_VARS = Object.freeze(["TEMP", "TMP", "TMPDIR"]);
export const CAPTURE_TAIL_BYTES = 8 * 1024;
export const MAX_CAPTURE_FILE_BYTES = 16 * 1024 * 1024;

/**
 * Build a scrubbed environment.
 * @param {Record<string, string | undefined>} source
 * @param {{ pass?: readonly string[], set?: Record<string, string>, tmpDir?: string, platform?: NodeJS.Platform }} [options]
 * @returns {Record<string, string>}
 */
export function scrubEnv(
  source,
  { pass = [], set = {}, tmpDir, platform = process.platform } = {},
) {
  const fold =
    platform === "win32"
      ? (/** @type {string} */ k) => k.toUpperCase()
      : (/** @type {string} */ k) => k;
  const wanted = new Set([...ENV_ALLOWLIST, ...pass].map(fold));
  /** @type {Record<string, string>} */
  const out = {};
  for (const key of Object.keys(source).sort()) {
    const value = source[key];
    if (value !== undefined && wanted.has(fold(key))) out[key] = value;
  }
  if (tmpDir) for (const key of TEMP_VARS) out[key] = tmpDir;
  for (const [key, value] of Object.entries(set)) {
    for (const existing of Object.keys(out)) if (fold(existing) === fold(key)) delete out[existing];
    out[key] = value;
  }
  return out;
}

/**
 * Create the per-sample folder and copy the item input into it.
 * @param {{ sampleDir: string, item: { input?: string, expected?: string }, outputExt?: string }} options
 */
export async function prepareSample({ sampleDir, item, outputExt = "" }) {
  const inputDir = path.join(sampleDir, "input");
  const outDir = path.join(sampleDir, "out");
  const tmpDir = path.join(sampleDir, "tmp");
  await Promise.all([
    mkdir(inputDir, { recursive: true }),
    mkdir(outDir, { recursive: true }),
    mkdir(tmpDir, { recursive: true }),
  ]);
  let inputPath;
  if (item.input) {
    inputPath = path.join(inputDir, path.basename(item.input));
    await cp(item.input, inputPath, { recursive: true });
  }
  return {
    sampleDir,
    inputDir,
    inputPath,
    outDir,
    outPath: path.join(outDir, `output${outputExt}`),
    tmpDir,
    expectedPath: item.expected,
  };
}

/** Total bytes under a path (0 when missing). @param {string} target @returns {Promise<number>} */
export async function treeSize(target) {
  let info;
  try {
    info = await stat(target);
  } catch {
    return 0;
  }
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const entry of await readdir(target)) total += await treeSize(path.join(target, entry));
  return total;
}

/**
 * Kill a process and everything it started (taskkill /T on Windows; the
 * process group elsewhere, which needs `detached: true` at spawn).
 * @param {import("node:child_process").ChildProcess} child
 */
export function killTree(child) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/**
 * @typedef {{
 *   exitCode: number | null, signal: string | null, timedOut: boolean, aborted: boolean,
 *   spawnError?: { code: string, message: string },
 *   wallMs: number, stdoutBytes: number, stderrBytes: number, stdoutTail: string, stderrTail: string, truncated: boolean,
 *   memory?: import("../sampler.mjs").MemoryReading,
 * }} ProcessResult
 */

/**
 * Run one command (argv, never a shell) and capture what it did.
 * @param {string[]} argv
 * @param {{
 *   cwd?: string, env?: Record<string, string>, timeoutMs: number, stdoutFile?: string, stderrFile?: string,
 *   sampleMemory?: boolean, memoryIntervalMs?: number, signal?: AbortSignal, clock?: () => number, maxFileBytes?: number,
 * }} options
 * @returns {Promise<ProcessResult>}
 */
export function runProcess(argv, options) {
  const {
    cwd,
    env,
    timeoutMs,
    stdoutFile,
    stderrFile,
    sampleMemory = false,
    memoryIntervalMs,
    signal,
    clock = () => performance.now(),
    maxFileBytes = MAX_CAPTURE_FILE_BYTES,
  } = options;
  const [command, ...args] = argv;
  return new Promise((resolve) => {
    const t0 = clock();
    /** @type {ProcessResult} */
    const result = {
      exitCode: null,
      signal: null,
      timedOut: false,
      aborted: false,
      wallMs: 0,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutTail: "",
      stderrTail: "",
      truncated: false,
    };
    if (!command) {
      result.spawnError = { code: "ARGV_INVALID", message: "empty command" };
      return resolve(result);
    }
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      result.spawnError = {
        code: "SPAWN_FAILED",
        message: error instanceof Error ? error.message : String(error),
      };
      return resolve(result);
    }
    const files = [stdoutFile, stderrFile].map((f) => (f ? createWriteStream(f) : undefined));
    const written = [0, 0];
    /** @type {import("../sampler.mjs").Sampler | undefined} */
    let sampler;
    child.once("spawn", () => {
      if (sampleMemory && child.pid !== undefined)
        sampler = samplePeakMemory(child.pid, { intervalMs: memoryIntervalMs });
    });
    /** @param {0 | 1} n @param {Buffer} chunk */
    const capture = (n, chunk) => {
      const key = n === 0 ? "stdout" : "stderr";
      result[`${key}Bytes`] += chunk.length;
      result[`${key}Tail`] = (result[`${key}Tail`] + chunk.toString("utf8")).slice(
        -CAPTURE_TAIL_BYTES,
      );
      const file = files[n];
      if (!file) return;
      const room = maxFileBytes - /** @type {number} */ (written[n]);
      if (room <= 0) {
        result.truncated = true;
        return;
      }
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (part.length < chunk.length) result.truncated = true;
      written[n] = /** @type {number} */ (written[n]) + part.length;
      file.write(part);
    };
    child.stdout?.on("data", (c) => capture(0, c));
    child.stderr?.on("data", (c) => capture(1, c));

    const timer = setTimeout(() => {
      result.timedOut = true;
      killTree(child);
    }, timeoutMs);
    const onAbort = () => {
      result.aborted = true;
      killTree(child);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    let finished = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let drainTimer;
    const finish = async () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      signal?.removeEventListener("abort", onAbort);
      if (sampler) result.memory = await sampler.stop();
      await Promise.all(files.map((f) => (f ? new Promise((r) => f.end(r)) : undefined)));
      resolve(result);
    };
    child.once("error", (error) => {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      result.spawnError = {
        code: code === "ENOENT" ? "COMMAND_NOT_FOUND" : "SPAWN_FAILED",
        message:
          code === "ENOENT"
            ? `command not found: ${command}${process.platform === "win32" ? ' (on Windows, .cmd/.bat scripts such as npx need ["cmd", "/c", ...])' : ""}`
            : error.message,
      };
      result.wallMs = clock() - t0;
      void finish();
    });
    child.once("exit", (code, sig) => {
      result.wallMs = clock() - t0;
      result.exitCode = code;
      result.signal = sig;
      // Grandchildren may keep the pipes open; don't wait for them forever.
      drainTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        void finish();
      }, 2_000);
    });
    child.once("close", () => void finish());
  });
}
