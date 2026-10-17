/**
 * Persistent bash session for the bash tool's opt-in `persist` mode.
 *
 * One long-lived bash per instance; commands are written to stdin and
 * delimited with a sentinel that carries the exit code. Benchmarked at ~0.3ms
 * per call vs ~6.4ms for spawn-per-call (see bash-spawn-benchmark.ts), and —
 * the real win — cd/env/shell state survive across calls.
 *
 * POSIX-only (needs a real bash). Callers must fall back to spawn-per-call
 * when bash is unavailable (Windows cmd.exe fallback path).
 */
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ForegroundExecutionReason } from "../types.js";

import {
  BOUNDED_OUTPUT_MAX_LINES,
  BoundedOutputBuffer,
  BoundedOutputTail,
  type BoundedOutputTailSnapshot,
  OutputChunkDecoder,
} from "../tools/bounded-output-tail.js";
import { localProcessLifecycle, type ProcessLifecycleAdapter } from "../tools/operations.js";
import type { ForegroundLogHandle } from "./process-manager.js";
import { log } from "./logger.js";
import { createCommandWatchdog } from "./command-watchdog.js";
import { resolveShell, type ResolveShellOpts, type ShellResolution } from "./shell.js";

type PersistentOutputSource = "stdout" | "stderr";

interface PersistentOutputStreamState {
  source: PersistentOutputSource;
  decoder: OutputChunkDecoder;
  binary: boolean;
  binaryBytes: number;
  reportedBinaryBytes: number;
}

export interface PersistentRunResult {
  reason: ForegroundExecutionReason;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  elapsedMs: number;
  pid: number | null;
  error: Error | null;
  /** Complete output, bounded only by the byte limit (oldest dropped first). */
  output: string;
  /** Whether `output` dropped its oldest text to stay within the byte limit. */
  outputCapped: boolean;
  /** Last-lines tail for diagnostics. */
  outputSnapshot: BoundedOutputTailSnapshot;
}

/** Shell state captured after a completed command (ported from upstream). */
export interface StateSnapshot {
  cwd: string | null;
  env: string;
}

/** Single-quote for bash. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Split a state file (`pwd -P` line, then `export -p`) into cwd + env script.
 * Variables the new shell must own (PWD, OLDPWD, SHLVL) are dropped.
 */
export function parseStateSnapshot(text: string): StateSnapshot | null {
  if (!text.trim()) return null;
  // The cwd may in theory contain a newline, so split at the first export line.
  const m = /\n(?=declare -|export )/.exec(text);
  const cwd = (m ? text.slice(0, m.index) : text.replace(/\n$/, "")) || null;
  const env = m
    ? text
        .slice(m.index + 1)
        .split("\n")
        .filter((line) => !/^(declare -\S+|export) (PWD|OLDPWD|SHLVL)(=|$)/.test(line))
        .join("\n")
    : "";
  return { cwd, env };
}

/** Restore script: env first (its PWD is filtered), then cd, then report where we landed. */
export function buildRestoreScript(snapshot: StateSnapshot): string {
  const env = snapshot.env.trim() ? `{ ${snapshot.env}\n} >/dev/null 2>&1\n` : "";
  const cd = snapshot.cwd ? `builtin cd -- ${shellQuote(snapshot.cwd)} >/dev/null 2>&1\n` : "";
  return `${env}${cd}builtin pwd -P`;
}

function longestSentinelPrefix(candidate: Buffer, sentinel: Buffer): number {
  const maxLength = Math.min(candidate.length, sentinel.length - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    if (candidate.subarray(candidate.length - length).equals(sentinel.subarray(0, length))) {
      return length;
    }
  }
  return 0;
}

export class PersistentShell {
  private child: ChildProcess | null = null;
  private busy = false;
  private closing = false;
  /** Private temp dir holding the post-command state snapshot (lazy). */
  private stateDir: string | null = null;
  /** Set when a fresh shell was spawned and must replay the last snapshot. */
  private restorePending = false;
  private readonly owned = new Map<
    ChildProcess,
    { closed: Promise<void>; cleanup?: Promise<void> }
  >();

  constructor(
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly maxOutputBytes: number,
    private readonly lifecycle: ProcessLifecycleAdapter = localProcessLifecycle,
    private readonly shellOpts?: ResolveShellOpts,
    private readonly launch?: ShellResolution,
  ) {}

  private startCleanup(child: ChildProcess): Promise<void> {
    const owned = this.owned.get(child);
    if (!owned) return Promise.resolve();
    if (owned.cleanup) return owned.cleanup;
    // Timeout, kill and shutdown share one confirmed cleanup per child. Keep
    // failures owned even after close so shutdown cannot silently pass them.
    owned.cleanup = Promise.resolve().then(async () => {
      if (child.pid !== undefined)
        await this.lifecycle.cleanupProcessTree(
          {
            pid: child.pid,
            isExited: () => child.exitCode !== null || child.signalCode !== null,
          },
          { requireSettlement: true },
        );
      await owned.closed;
      this.owned.delete(child);
    });
    void owned.cleanup.catch((error: unknown) => {
      log("WARN", "bash", "Persistent process-tree cleanup failed", {
        pid: String(child.pid),
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return owned.cleanup;
  }

  /** True while a previous persistent command is still running. */
  get isBusy(): boolean {
    return this.busy;
  }

  /** State file path, creating the private (0700) temp dir on first use. */
  private get statePath(): string | null {
    if (!this.stateDir) {
      try {
        this.stateDir = mkdtempSync(path.join(os.tmpdir(), "gg-psh-"));
      } catch {
        return null;
      }
    }
    return path.join(this.stateDir, "state.sh");
  }

  private readSnapshot(): StateSnapshot | null {
    if (!this.stateDir) return null;
    try {
      return parseStateSnapshot(readFileSync(path.join(this.stateDir, "state.sh"), "utf-8"));
    } catch {
      return null;
    }
  }

  private removeStateDir(): void {
    if (!this.stateDir) return;
    try {
      rmSync(this.stateDir, { recursive: true, force: true });
    } catch {
      // Best effort; tmpdir cleanup reclaims it eventually.
    }
    this.stateDir = null;
  }

  private ensureChild(): ChildProcess {
    if (this.closing) throw new Error("Persistent shell is shutting down");
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      return this.child;
    }
    // Fresh session: use the prepared sandbox launch when provided; otherwise
    // use the same resolved shell as one-shot execution without user rc files.
    const resolved = this.launch ?? resolveShell("", this.shellOpts);
    // -o pipefail mirrors the one-shot path: pipelines keep the failing
    // stage's exit status instead of the trailing limiter's 0.
    const args = this.launch ? resolved.args : ["--norc", "--noprofile", "-o", "pipefail"];
    const child = this.lifecycle.spawn(resolved.file, args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: this.env,
      detached: process.platform !== "win32",
    });
    this.owned.set(child, {
      closed: new Promise((resolve) =>
        child.once("close", () => {
          if (!this.owned.get(child)?.cleanup) this.owned.delete(child);
          resolve();
        }),
      ),
    });
    // Don't let a lingering session shell keep the parent process alive.
    child.unref();
    this.child = child;
    // A replacement for a timed-out/killed/exited shell replays the snapshot
    // taken after the last completed command (cwd + exported env).
    this.restorePending = this.stateDir !== null;
    return child;
  }

  /**
   * Run one command in the session shell. Serialized by the tool's sequential
   * execution mode; a concurrent call while busy is rejected defensively.
   * On timeout or abort the whole session is killed (state is gone — the next
   * call starts a fresh shell) because a wedged command cannot be safely
   * skipped within the same shell.
   */
  run(
    command: string,
    timeoutMs: number,
    signal: AbortSignal,
    onChunk?: (text: string, totalBytes: number) => void,
    foregroundLog?: ForegroundLogHandle,
    /** Stop (reason `inactive`) after this long with no output; 0/omitted = never. */
    inactivityMs = 0,
  ): Promise<PersistentRunResult> {
    const startedAt = Date.now();
    const emptySnapshot = (): BoundedOutputTailSnapshot => ({
      content: "",
      totalInputBytes: 0,
      retainedBytes: 0,
      retainedLines: 0,
      capped: false,
    });
    if (this.busy) {
      return Promise.resolve({
        reason: "nonZeroExit",
        exitCode: 1,
        signal: null,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        pid: this.child?.pid ?? null,
        error: null,
        output: "persistent shell is busy with a previous command",
        outputCapped: false,
        outputSnapshot: {
          ...emptySnapshot(),
          content: "persistent shell is busy with a previous command",
          totalInputBytes: Buffer.byteLength("persistent shell is busy with a previous command"),
          retainedBytes: Buffer.byteLength("persistent shell is busy with a previous command"),
          retainedLines: 1,
        },
      });
    }
    this.busy = true;

    let child: ChildProcess;
    try {
      child = this.ensureChild();
    } catch (error) {
      this.busy = false;
      const spawnError = error instanceof Error ? error : new Error(String(error));
      return Promise.resolve({
        reason: "spawnError",
        exitCode: null,
        signal: null,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        pid: null,
        error: spawnError,
        output: "",
        outputCapped: false,
        outputSnapshot: emptySnapshot(),
      });
    }

    const sentinelText = `__GG_PSH_${randomUUID()}__`;
    const sentinel = Buffer.from(sentinelText, "utf8");
    // `</dev/null` keeps stdin-reading commands (cat, read) from eating the
    // next sentinel line instead of hanging the session. Merge command stderr
    // into stdout so the sentinel is ordered after every command output byte.
    // Prior calls and explicit launches may have disabled pipefail. Restore it
    // before every command so bounded checks cannot inherit false success.
    let restore = "";
    if (this.restorePending) {
      this.restorePending = false;
      const snap = this.readSnapshot();
      if (snap) restore = `{ ${buildRestoreScript(snap)}\n} >/dev/null 2>&1\n`;
    }
    // Snapshot cwd + exported env before the sentinel (builtins only) so a
    // shell stopped in a later command can be restored to this point.
    const statePath = this.statePath;
    const capture = statePath
      ? `{ builtin pwd -P; builtin export -p; } >${shellQuote(statePath.replace(/\\/g, "/"))} 2>/dev/null; `
      : "";
    const wrapped = `${restore}set -o pipefail && { ${command}\n} </dev/null 2>&1; __gg_psh_rc=$?; ${capture}echo "${sentinelText}$__gg_psh_rc"\n`;

    return new Promise<PersistentRunResult>((resolve) => {
      const outputTail = new BoundedOutputTail(BOUNDED_OUTPUT_MAX_LINES, this.maxOutputBytes);
      const fullOutput = new BoundedOutputBuffer(this.maxOutputBytes);
      const stdoutState: PersistentOutputStreamState = {
        source: "stdout",
        decoder: new OutputChunkDecoder(),
        binary: false,
        binaryBytes: 0,
        reportedBinaryBytes: 0,
      };
      const stderrState: PersistentOutputStreamState = {
        source: "stderr",
        decoder: new OutputChunkDecoder(),
        binary: false,
        binaryBytes: 0,
        reportedBinaryBytes: 0,
      };
      let totalBytes = 0;
      let stdoutPending: Buffer = Buffer.alloc(0);
      let sentinelSuffix = "";
      let sentinelFound = false;
      let done = false;
      let logBackpressured = false;

      const writeForegroundLog = (source: PersistentOutputSource, text: string): void => {
        if (
          !foregroundLog ||
          foregroundLog.write(`[${source}] ${text}`) ||
          logBackpressured ||
          done
        ) {
          return;
        }
        logBackpressured = true;
        child.stdout?.pause();
        child.stderr?.pause();
        void foregroundLog.waitForDrain().then(() => {
          if (!logBackpressured) return;
          logBackpressured = false;
          if (done) return;
          child.stdout?.resume();
          child.stderr?.resume();
        });
      };

      const emitText = (source: PersistentOutputSource, text: string): void => {
        if (!text) return;
        outputTail.append(text);
        fullOutput.append(text);
        writeForegroundLog(source, text);
        onChunk?.(text, totalBytes);
      };

      const emitBinarySummary = (state: PersistentOutputStreamState): void => {
        if (state.binaryBytes === state.reportedBinaryBytes) return;
        const marker = `[${state.source} binary output omitted: ${state.binaryBytes} bytes]\n`;
        state.reportedBinaryBytes = state.binaryBytes;
        outputTail.append(marker);
        fullOutput.append(marker);
        writeForegroundLog(state.source, marker);
        onChunk?.(marker, totalBytes);
      };

      const decodeOutput = (state: PersistentOutputStreamState, data: Buffer): void => {
        if (data.length === 0) return;
        if (state.binary) {
          state.binaryBytes += data.length;
          return;
        }
        const decoded = state.decoder.write(data);
        if (decoded.binary) {
          state.binary = true;
          state.binaryBytes += decoded.unsafeBytes;
          emitBinarySummary(state);
          return;
        }
        emitText(state.source, decoded.text);
      };

      const flushDecoder = (state: PersistentOutputStreamState): void => {
        if (state.binary) {
          emitBinarySummary(state);
          return;
        }
        const decoded = state.decoder.end();
        if (decoded.binary) {
          state.binary = true;
          state.binaryBytes += decoded.unsafeBytes;
          emitBinarySummary(state);
          return;
        }
        emitText(state.source, decoded.text);
      };

      const finish = (
        reason: ForegroundExecutionReason,
        exitCode: number | null,
        closeSignal: NodeJS.Signals | null,
        error: Error | null = null,
      ): void => {
        if (done) return;
        done = true;
        watchdog.dispose();
        signal.removeEventListener("abort", onAbort);
        child.stdout?.off("data", onStdoutData);
        child.stderr?.off("data", onStderrData);
        child.off("exit", onExit);
        child.off("error", onError);
        if (!sentinelFound && stdoutPending.length > 0) {
          totalBytes += stdoutPending.length;
          decodeOutput(stdoutState, stdoutPending);
          stdoutPending = Buffer.alloc(0);
        }
        flushDecoder(stdoutState);
        flushDecoder(stderrState);
        if (logBackpressured) {
          logBackpressured = false;
          child.stdout?.resume();
          child.stderr?.resume();
        }
        this.busy = false;
        const outputSnapshot = outputTail.snapshot();
        resolve({
          reason,
          exitCode,
          signal: closeSignal,
          elapsedMs: Math.max(0, Date.now() - startedAt),
          pid: child.pid ?? null,
          error,
          output: fullOutput.content(),
          outputCapped: fullOutput.capped,
          outputSnapshot,
        });
      };

      const maybeFinishSentinel = (): void => {
        const newline = sentinelSuffix.indexOf("\n");
        if (newline === -1) return;
        const code = Number.parseInt(sentinelSuffix.slice(0, newline).trim(), 10);
        const exitCode = Number.isNaN(code) ? 1 : code;
        finish(exitCode === 0 ? "completed" : "nonZeroExit", exitCode, null);
      };

      const onStdoutData = (data: Buffer): void => {
        watchdog.noteActivity();
        if (sentinelFound) {
          sentinelSuffix += data.toString("utf8");
          maybeFinishSentinel();
          return;
        }

        const candidate = stdoutPending.length === 0 ? data : Buffer.concat([stdoutPending, data]);
        const sentinelIndex = candidate.indexOf(sentinel);
        if (sentinelIndex !== -1) {
          const commandOutput = candidate.subarray(0, sentinelIndex);
          totalBytes += commandOutput.length;
          decodeOutput(stdoutState, commandOutput);
          stdoutPending = Buffer.alloc(0);
          sentinelFound = true;
          sentinelSuffix = candidate.subarray(sentinelIndex + sentinel.length).toString("utf8");
          maybeFinishSentinel();
          return;
        }

        const retainedPrefixBytes = longestSentinelPrefix(candidate, sentinel);
        const emitThrough = candidate.length - retainedPrefixBytes;
        const commandOutput = candidate.subarray(0, emitThrough);
        totalBytes += commandOutput.length;
        decodeOutput(stdoutState, commandOutput);
        stdoutPending = candidate.subarray(emitThrough);
      };

      const onStderrData = (data: Buffer): void => {
        watchdog.noteActivity();
        totalBytes += data.length;
        decodeOutput(stderrState, data);
      };

      const interrupt = (reason: "timedOut" | "aborted" | "inactive"): void => {
        if (done) return;
        if (this.child === child) this.child = null;
        if (child.pid !== undefined) {
          void this.startCleanup(child);
        }
        finish(reason, null, child.signalCode);
      };
      const onAbort = (): void => interrupt("aborted");

      // `exit N` (or a crash) ends the session shell itself — the sentinel
      // never prints, so settle from the shell's own exit code. The next run()
      // starts a fresh session.
      const onExit = (code: number | null, exitSignal: NodeJS.Signals | null): void => {
        if (this.child === child) this.child = null;
        if (child.pid !== undefined) {
          try {
            this.lifecycle.reapProcessWrapper({
              pid: child.pid,
              isExited: () => child.exitCode !== null || child.signalCode !== null,
            });
          } catch {
            // The shell exit result remains authoritative if wrapper reaping fails.
          }
        }
        const exitCode = code ?? (exitSignal ? null : 1);
        finish(
          exitCode === 0 ? "completed" : "nonZeroExit",
          exitCode,
          exitSignal ?? child.signalCode,
        );
      };
      const onError = (error: Error): void => {
        if (this.child === child) this.child = null;
        finish("spawnError", null, child.signalCode, error);
      };

      // Zero is the internal "no limit" sentinel, shared with fresh-shell bash.
      // No yield layer: a session shell cannot be handed off mid-command.
      const watchdog = createCommandWatchdog({
        yieldMs: null,
        inactivityMs: inactivityMs > 0 ? inactivityMs : null,
        hardMs: timeoutMs > 0 ? timeoutMs : null,
        onFire: (fire) => interrupt(fire === "inactive" ? "inactive" : "timedOut"),
      });

      child.on("exit", onExit);
      child.on("error", onError);
      child.stdout?.on("data", onStdoutData);
      child.stderr?.on("data", onStderrData);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      if (!done) {
        try {
          child.stdin?.write(wrapped);
        } catch (error) {
          onError(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
  }

  /** Gracefully kill the session shell; the next run() starts a fresh one. */
  kill(): void {
    const childToKill = this.takeChild();
    if (childToKill?.pid !== undefined) {
      void this.startCleanup(childToKill);
    }
  }

  /** Await every still-owned shell, including one detached by cancellation. */
  async shutdownAndWait(): Promise<void> {
    this.closing = true;
    this.takeChild();
    await Promise.all([...this.owned.keys()].map((child) => this.startCleanup(child)));
    this.removeStateDir();
  }

  /** Immediately kill the session tree from synchronous process-exit hooks. */
  killNow(): void {
    const childToKill = this.takeChild();
    this.removeStateDir();
    if (childToKill?.pid === undefined) return;
    try {
      this.lifecycle.killProcessTree({
        pid: childToKill.pid,
        isExited: () => childToKill.exitCode !== null || childToKill.signalCode !== null,
      });
    } catch (error) {
      log("WARN", "bash", "Immediate persistent process-tree cleanup failed", {
        pid: String(childToKill.pid),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private takeChild(): ChildProcess | null {
    const childToKill = this.child;
    this.child = null;
    this.busy = false;
    return childToKill;
  }
}
