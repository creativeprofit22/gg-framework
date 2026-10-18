import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { AdoptExitedError, type ProcessManager } from "../core/process-manager.js";
import type {
  BashDiagnostics,
  BashToolResultDetails,
  ForegroundExecutionOutcome,
  ForegroundExecutionReason,
} from "../types.js";
import type { ProcessTarget } from "../utils/process.js";
import { log } from "../core/logger.js";
import { createCommandWatchdog, type CommandWatchdog } from "../core/command-watchdog.js";
import { watchExitSettle } from "./exit-settle.js";
import {
  DEFAULT_EXIT_SETTLE_MS,
  DEFAULT_FOREGROUND_LIMIT_SETTINGS,
  resolveForegroundLimits,
  type ForegroundLimitSettings,
  type ForegroundLimits,
} from "./foreground-limits.js";
import { truncateTail, MAX_BYTES, describeCompressed } from "./truncate.js";
import { compressToolOutput } from "./compress.js";
import { writeOverflow } from "./overflow.js";
import { localOperations, type ToolOperations } from "./operations.js";
import { getSafeToolEnv } from "./safe-env.js";
import { resolveShell, type ResolveShellOpts } from "../core/shell.js";
import { PersistentShell } from "../core/persistent-shell.js";
import { isReadOnlyCommand, sleepOnlySeconds } from "./read-only-bash.js";
import { backgroundWatchWarnings } from "./background-watch-lint.js";
import { isPlanModeActive, planModeRestriction } from "../core/runtime-mode.js";
import { isCatastrophicCommand } from "../core/workspace-guard.js";
import { checkDestructiveGit } from "../core/destructive-git-guard.js";
import { shellThreatBlockMessage } from "../core/shell-threats.js";
import { checkPackageInstall } from "../core/package-threats.js";
import {
  classifyVerificationCommand,
  containsBoundedCheck,
} from "../core/verification-evidence.js";
import { checkCommandPolicy, type GetNetworkPolicy } from "../core/network-guard.js";
import {
  BOUNDED_OUTPUT_MAX_BYTES,
  BoundedOutputBuffer,
  BoundedOutputTail,
  type BoundedOutputTailSnapshot,
  OutputChunkDecoder,
} from "./bounded-output-tail.js";
import {
  prepareSandboxLaunch,
  SANDBOX_ENV_PATCH,
  type SandboxPolicy,
  type SandboxLaunch,
} from "../core/sandbox.js";
import type { WakeRules } from "../core/process-manager.js";
import { annotateSandboxDenial } from "../core/sandbox-feedback.js";
import { collectVerificationReview } from "./verification-review.js";
import { captureVerificationSnapshot } from "../core/verification-snapshot.js";

/** Tool env, plus the tweaks that only make sense inside the OS sandbox. */
function sandboxAwareEnv(sandboxed: boolean): Record<string, string> {
  const env = getSafeToolEnv();
  return sandboxed ? { ...env, ...SANDBOX_ENV_PATCH } : env;
}

/** Internal deadline sentinel: omitted bash timeout means no deadline. */
const NO_DEADLINE = 0;
const FOREGROUND_TIMEOUT_CLEANUP_GRACE_MS = 1_000;
const FOREGROUND_LIMITS_DESCRIPTION =
  "Long output is compressed (head, tail, errors kept); full text saved to a file. Runs past the soft limit (default 2 min) hand off to a background task, " +
  "not killed: continue with task_output id + wait_ms.";
const MAX_OUTPUT_BYTES = BOUNDED_OUTPUT_MAX_BYTES;

/** Host-authored rejection: no process started, so this is not a failed check. */
export const REVIEW_REJECTED_BEFORE_START =
  "Error: review requires a local, non-persistent foreground verification check. Pass only the check in command; do not combine it with edits or diff inspection. Nothing was run.";

/**
 * Result for a call whose Stop arrived while the launch was still being
 * prepared. Wording matches the agent loop's result for a tool call that never
 * reached its tool.
 */
const CANCELLED_BEFORE_START =
  "Exit code: CANCELLED\n`bash` was cancelled before it started, so it had no effect. Safe to retry.";

/**
 * SIGKILL what is left of the process group the shell led, returning whether
 * anything was there to stop. Group-only: once the shell has exited its lone
 * pid may already belong to an unrelated process. Windows has no process
 * groups, and taskkill /T cannot find the tree of a parent that already
 * exited, so leftovers there are left running.
 */
function killLeftoverGroup(pid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pid, "SIGKILL");
    return true;
  } catch {
    // The group is empty: whatever still holds the output left it (setsid).
    return false;
  }
}
/** A sleep this long guesses completion instead of waiting for a process event. */
const GUESSED_WAIT_SECONDS = 10;

/**
 * Render command output for the tool result. Over-limit output is compressed
 * (keeps errors + head/tail, collapses repeats) rather than blindly
 * tail-sliced, and the raw output is offloaded to `~/.gg/tool-output/` so the
 * model can recover the lost portion with `read --offset` instead of
 * re-running the command. The offload is best-effort — a full disk or
 * permission error never fails the tool result.
 */
export async function renderBashOutput(
  rawOutput: string,
  command?: string,
  /** bash with pipefail (not the cmd.exe fallback): see classifyVerificationCommand. */
  posixShell = false,
): Promise<string> {
  // Feedback only when the command wraps a real check. Exploration that merely
  // mentions a verifier (`ls .venv/bin | grep ruff`) is not a verification
  // attempt; nagging it made the model reshape harmless commands repeatedly.
  // Showing the note only once per session was measured and rejected: it cut
  // notes by a third but raised tool calls 27% (bench/h2h/DIRAC-FINDINGS.md).
  const check =
    command && containsBoundedCheck(command)
      ? classifyVerificationCommand(command, { posixShell })
      : undefined;
  const feedback =
    check?.candidate && !check.accepted && check.snapshotPreserveOnly
      ? "\n\n[This mixed check/inspection chain cannot establish fresh verification; it can only preserve earlier successful checks. If the current changes are not already verified, run the check standalone or chain only checks with &&. Do not claim fresh verification from this shell exit status.]"
      : check?.candidate && !check.accepted && !check.snapshotEligible
        ? `\n\n[Verification evidence rejected: ${check.reason}. The output is still valid information; do not reshape this command to satisfy this note. When you need verification, run the check once as a standalone command (or chain only checks with &&) after your last edit, and do not claim verification from this shell exit status.]`
        : "";
  const result = truncateTail(rawOutput);
  if (!result.truncated) return result.content + feedback;
  const overflowPath =
    Buffer.byteLength(rawOutput, "utf-8") > MAX_BYTES
      ? await writeOverflow(rawOutput, "bash").catch(() => null)
      : null;
  const overflowNotice = overflowPath
    ? ` Full output saved to ${overflowPath} — read it with offset/limit if needed.`
    : "";
  const c = compressToolOutput(rawOutput);
  const what = describeCompressed(rawOutput, c.content);
  return `[${c.notice}${what ? ` ${what}` : ""}${overflowNotice}]\n${c.content}${feedback}`;
}

export interface ForegroundCommandExecution {
  outcome: ForegroundExecutionOutcome;
  /** Complete output for the model, bounded only by bytes (oldest dropped first). */
  rawOutput: string;
  /** Whether `rawOutput` dropped its oldest text to stay within the byte limit. */
  outputCapped: boolean;
  /** Last-lines tail for diagnostics details. */
  outputSnapshot: BoundedOutputTailSnapshot;
  isCmdFallback: boolean;
}

function bashDiagnostics(execution: ForegroundCommandExecution): BashDiagnostics {
  const { outcome, outputSnapshot: output } = execution;
  const { metadata } = outcome;
  return {
    executionId: metadata.executionId,
    pid: metadata.pid,
    command: metadata.command,
    cwd: metadata.cwd,
    startedAt: metadata.startedAt,
    timeoutMs: metadata.timeoutMs,
    reason: outcome.reason,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    elapsedMs: outcome.elapsedMs,
    logPath: metadata.logPath,
    tail: output.content,
    // Model-facing cap (10 MB, oldest dropped) — not the 100-line diagnostics
    // tail, which `retainedOutputBytes`/`droppedOutputBytes` describe.
    outputCapped: execution.outputCapped,
    totalOutputBytes: output.totalInputBytes,
    retainedOutputBytes: output.retainedBytes,
    droppedOutputBytes: Math.max(0, output.totalInputBytes - output.retainedBytes),
    backgroundTaskId: outcome.backgroundTaskId,
    pipesHeldAfterExit: outcome.pipesHeldAfterExit,
  };
}

/**
 * Model-facing diagnostics. The output itself is rendered once above this
 * block; the last-lines tail lives only in `details.bashDiagnostics.tail`.
 */
function formatForegroundDiagnostics(outcome: ForegroundExecutionOutcome): string {
  const { metadata } = outcome;
  return (
    "Execution diagnostics:\n" +
    `ID: ${metadata.executionId}\n` +
    `PID: ${metadata.pid ?? "unavailable"}\n` +
    `Command: ${metadata.command}\n` +
    `CWD: ${metadata.cwd}\n` +
    `Started: ${new Date(metadata.startedAt).toISOString()}\n` +
    `Timeout: ${metadata.timeoutMs === 0 ? "none" : `${metadata.timeoutMs}ms`}\n` +
    `Reason: ${outcome.reason}\n` +
    `Exit code: ${outcome.exitCode ?? "none"}\n` +
    `Signal: ${outcome.signal ?? "none"}\n` +
    `Elapsed: ${outcome.elapsedMs}ms\n` +
    `Log: ${metadata.logPath}`
  );
}

interface ForegroundCommandOptions {
  command: string;
  cwd: string;
  /** Hard limit used when `limits` is omitted; 0 = none. */
  timeoutMs: number;
  /** Yield / inactivity / hard limits. Omitted: `timeoutMs` is the only limit. */
  limits?: ForegroundLimits;
  signal: AbortSignal;
  ops: ToolOperations;
  processManager: ProcessManager;
  launch?: SandboxLaunch;
  onUpdate?: (output: string, totalBytes: number) => void;
  cleanupProcessTree?: (target: ProcessTarget) => Promise<void>;
  reapProcessWrapper?: (target: ProcessTarget) => void;
}

type ForegroundOutputSource = "stdout" | "stderr";

interface ForegroundOutputStreamState {
  source: ForegroundOutputSource;
  decoder: OutputChunkDecoder;
  binary: boolean;
  binaryBytes: number;
  reportedBinaryBytes: number;
}

export async function executeForegroundCommand({
  command,
  cwd,
  timeoutMs,
  limits,
  signal,
  ops,
  processManager,
  launch,
  onUpdate,
  cleanupProcessTree = ops.process.cleanupProcessTree,
  reapProcessWrapper: reapWrapper = ops.process.reapProcessWrapper,
}: ForegroundCommandOptions): Promise<ForegroundCommandExecution> {
  const startedAt = Date.now();
  // Without explicit limits, `timeoutMs` alone is the hard limit (0 = none).
  const effectiveLimits: ForegroundLimits = limits ?? {
    yieldMs: null,
    inactivityMs: null,
    hardMs: timeoutMs > 0 ? timeoutMs : null,
    exitSettleMs: DEFAULT_EXIT_SETTLE_MS,
  };
  const foregroundLog = await processManager.allocateForegroundLog();
  const effectiveLaunch: SandboxLaunch = launch ?? {
    ...resolveShell(command),
    sandboxed: false,
  };
  const outputTail = new BoundedOutputTail();
  const fullOutput = new BoundedOutputBuffer();
  let totalBytes = 0;
  let lastOutputAt = startedAt;
  let pid: number | null = null;
  let terminalIntent: "interruption" | "completion" | "spawnError" | null = null;
  let pendingInterruption: "timedOut" | "aborted" | "inactive" | null = null;
  let settled = false;
  let handingOff = false;
  let watchdog: CommandWatchdog | undefined;
  let disposeExitSettle: (() => void) | undefined;
  let cleanupGraceTimer: NodeJS.Timeout | undefined;
  let abortListenerRegistered = false;
  let child: ReturnType<ToolOperations["process"]["spawn"]> | null = null;
  let logBackpressured = false;
  let onStdoutData: ((data: Buffer) => void) | undefined;
  let onStderrData: ((data: Buffer) => void) | undefined;
  let flushStdout: (() => void) | undefined;
  let flushStderr: (() => void) | undefined;
  const onOutputPipeError = (): void => {};
  let onChildClose: ((code: number | null, closeSignal: NodeJS.Signals | null) => void) | undefined;
  let onChildError: ((error: Error) => void) | undefined;

  return new Promise((resolve) => {
    const currentTarget = (): ProcessTarget | null => {
      if (pid === null || child === null) return null;
      const trackedChild = child;
      return {
        pid,
        isExited: () =>
          typeof trackedChild.exitCode === "number" ||
          (trackedChild.signalCode !== null && trackedChild.signalCode !== undefined),
      };
    };

    const startCleanup = (target: ProcessTarget): void => {
      void Promise.resolve()
        .then(() => cleanupProcessTree(target))
        .catch((error: unknown) => {
          log("WARN", "bash", "Foreground process-tree cleanup failed", {
            pid: String(target.pid),
            error: error instanceof Error ? error.message : String(error),
          });
        });
    };

    const reapCompletedWrapper = (target: ProcessTarget): void => {
      try {
        reapWrapper(target);
      } catch (error) {
        log("WARN", "bash", "Foreground wrapper cleanup failed", {
          pid: String(target.pid),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const writeForegroundLog = (record: string): void => {
      if (foregroundLog.write(record) || logBackpressured || settled) return;
      logBackpressured = true;
      child?.stdout?.pause();
      child?.stderr?.pause();
      void foregroundLog.waitForDrain().then(() => {
        if (!logBackpressured) return;
        logBackpressured = false;
        if (settled) return;
        child?.stdout?.resume();
        child?.stderr?.resume();
      });
    };

    /** Stop observing the child; it either finished or now belongs to a background task. */
    const detachListeners = (): void => {
      watchdog?.dispose();
      disposeExitSettle?.();
      if (cleanupGraceTimer) clearTimeout(cleanupGraceTimer);
      if (abortListenerRegistered) signal.removeEventListener("abort", onAbort);
      if (child && onChildClose) child.off("close", onChildClose);
      if (child && onChildError) child.off("error", onChildError);
      if (child?.stdout && onStdoutData) child.stdout.off("data", onStdoutData);
      child?.stdout?.off("error", onOutputPipeError);
      if (child?.stdout && flushStdout) {
        child.stdout.off("end", flushStdout);
        child.stdout.off("close", flushStdout);
      }
      if (child?.stderr && onStderrData) child.stderr.off("data", onStderrData);
      child?.stderr?.off("error", onOutputPipeError);
      if (child?.stderr && flushStderr) {
        child.stderr.off("end", flushStderr);
        child.stderr.off("close", flushStderr);
      }
      flushStdout?.();
      flushStderr?.();
      if (logBackpressured) {
        logBackpressured = false;
        child?.stdout?.resume();
        child?.stderr?.resume();
      }
    };

    const finalize = (
      reason: ForegroundExecutionReason,
      exitCode: number | null,
      closeSignal: NodeJS.Signals | null,
      error: Error | null = null,
      extra: {
        backgroundTaskId?: string;
        pipesHeldAfterExit?: boolean;
        leftoverStopped?: boolean;
      } = {},
    ): void => {
      if (settled) return;
      settled = true;
      detachListeners();
      const outputSnapshot = outputTail.snapshot();
      const result: ForegroundCommandExecution = {
        outcome: {
          metadata: {
            executionId: foregroundLog.executionId,
            command,
            cwd,
            startedAt,
            timeoutMs: effectiveLimits.hardMs ?? 0,
            pid,
            logPath: foregroundLog.logPath,
          },
          reason,
          exitCode,
          signal: closeSignal,
          elapsedMs: Math.max(0, Date.now() - startedAt),
          error,
          backgroundTaskId: extra.backgroundTaskId ?? null,
          pipesHeldAfterExit: extra.pipesHeldAfterExit ?? false,
          ...(extra.leftoverStopped ? { leftoverStopped: true } : {}),
        },
        rawOutput: fullOutput.content(),
        outputCapped: fullOutput.capped,
        outputSnapshot,
        isCmdFallback: effectiveLaunch.isCmdFallback,
      };
      void foregroundLog.close().then(() => {
        if (foregroundLog.error) {
          log("WARN", "bash", "Foreground log stream failed", {
            executionId: foregroundLog.executionId,
            logPath: foregroundLog.logPath,
            error: foregroundLog.error.message,
          });
        }
        resolve(result);
      });
    };

    const interrupt = (reason: "timedOut" | "aborted" | "inactive"): void => {
      if (settled || terminalIntent !== null) return;
      terminalIntent = "interruption";
      pendingInterruption = reason;
      watchdog?.dispose();
      const target = currentTarget();
      if (target) startCleanup(target);
      cleanupGraceTimer = setTimeout(() => {
        finalize(reason, null, null);
      }, FOREGROUND_TIMEOUT_CLEANUP_GRACE_MS);
    };

    /** (Re)arm the stuck-command guard, charging time and silence already spent. */
    const armWatchdog = (yieldMs: number | null): void => {
      watchdog?.dispose();
      const now = Date.now();
      const { inactivityMs, hardMs } = effectiveLimits;
      watchdog = createCommandWatchdog({
        yieldMs,
        inactivityMs,
        hardMs: hardMs === null ? null : Math.max(0, hardMs - (now - startedAt)),
        initialInactivityMs:
          inactivityMs === null ? undefined : Math.max(0, inactivityMs - (now - lastOutputAt)),
        onFire: (fire) => {
          if (fire === "yield") void handOff();
          else interrupt(fire === "inactive" ? "inactive" : "timedOut");
        },
      });
    };

    /** Move a still-running command to a background task instead of killing it. */
    const handOff = async (): Promise<void> => {
      const running = child;
      if (settled || handingOff || terminalIntent !== null || running === null || pid === null) {
        return;
      }
      handingOff = true;
      const handedOffPid = pid;
      try {
        await processManager.adopt({
          child: running,
          pid: handedOffPid,
          command,
          startedAt,
          limits: {
            inactivityMs: effectiveLimits.inactivityMs,
            hardMs: effectiveLimits.hardMs,
            exitSettleMs: effectiveLimits.exitSettleMs,
          },
          takeOver: (taskId) => {
            if (settled || terminalIntent !== null) {
              throw new Error("Command settled before hand-off");
            }
            // finalize detaches every foreground listener synchronously, so
            // the manager's listeners are the only ones from here on.
            // Seed with the full bounded buffer, not the 100-line tail, so the
            // background log keeps everything printed before the hand-off.
            const seedOutput = fullOutput.content();
            finalize("backgrounded", null, null, null, { backgroundTaskId: taskId });
            log("INFO", "bash", "Foreground command handed off to background task", {
              taskId,
              pid: String(handedOffPid),
              elapsedMs: String(Date.now() - startedAt),
            });
            return { seedOutput, lastOutputAt };
          },
        });
      } catch (error) {
        handingOff = false;
        if (settled || terminalIntent !== null) return;
        if (!(error instanceof AdoptExitedError)) {
          log("WARN", "bash", "Foreground hand-off failed; continuing in foreground", {
            pid: String(handedOffPid),
            error: error instanceof Error ? error.message : String(error),
          });
        }
        // Fail safe: never kill because a hand-off failed, never drop the guard.
        armWatchdog(null);
      }
    };

    const onAbort = (): void => interrupt("aborted");

    if (signal.aborted) {
      terminalIntent = "interruption";
      pendingInterruption = "aborted";
      finalize("aborted", null, null);
      return;
    }

    try {
      child = ops.process.spawn(effectiveLaunch.file, effectiveLaunch.args, {
        cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: sandboxAwareEnv(effectiveLaunch.sandboxed),
      });
      pid = child.pid ?? null;

      const stdoutState: ForegroundOutputStreamState = {
        source: "stdout",
        decoder: new OutputChunkDecoder(),
        binary: false,
        binaryBytes: 0,
        reportedBinaryBytes: 0,
      };
      const stderrState: ForegroundOutputStreamState = {
        source: "stderr",
        decoder: new OutputChunkDecoder(),
        binary: false,
        binaryBytes: 0,
        reportedBinaryBytes: 0,
      };
      const emitText = (source: ForegroundOutputSource, output: string): void => {
        if (!output) return;
        outputTail.append(output);
        fullOutput.append(output);
        writeForegroundLog(`[${source}] ${output}`);
        onUpdate?.(output, totalBytes);
      };
      const emitBinarySummary = (state: ForegroundOutputStreamState): void => {
        if (state.binaryBytes === state.reportedBinaryBytes) return;
        const marker = `[${state.source} binary output omitted: ${state.binaryBytes} bytes]\n`;
        state.reportedBinaryBytes = state.binaryBytes;
        outputTail.append(marker);
        fullOutput.append(marker);
        writeForegroundLog(`[${state.source}] ${marker}`);
        onUpdate?.(marker, totalBytes);
      };
      const onData =
        (state: ForegroundOutputStreamState) =>
        (data: Buffer): void => {
          totalBytes += data.length;
          lastOutputAt = Date.now();
          watchdog?.noteActivity();
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
      const flushDecoder = (state: ForegroundOutputStreamState): (() => void) => {
        let flushed = false;
        return () => {
          if (flushed) return;
          flushed = true;
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
      };
      // Output pipes can fail independently. Swallow their errors so the child
      // process close/error event remains the sole execution outcome authority.
      onStdoutData = onData(stdoutState);
      onStderrData = onData(stderrState);
      flushStdout = flushDecoder(stdoutState);
      flushStderr = flushDecoder(stderrState);
      child.stdout?.on("data", onStdoutData);
      child.stdout?.on("error", onOutputPipeError);
      child.stdout?.once("end", flushStdout);
      child.stdout?.once("close", flushStdout);
      child.stderr?.on("data", onStderrData);
      child.stderr?.on("error", onOutputPipeError);
      child.stderr?.once("end", flushStderr);
      child.stderr?.once("close", flushStderr);

      onChildClose = (code, closeSignal) => {
        if (terminalIntent === "interruption") {
          finalize(pendingInterruption!, code, closeSignal);
          return;
        }
        if (terminalIntent !== null) return;
        terminalIntent = "completion";
        const target = currentTarget();
        if (target) reapCompletedWrapper(target);
        finalize(code === 0 ? "completed" : "nonZeroExit", code, closeSignal);
      };
      onChildError = (error) => {
        if (terminalIntent === "interruption") {
          finalize(pendingInterruption!, null, null, error);
          return;
        }
        if (terminalIntent !== null) return;
        terminalIntent = "spawnError";
        finalize("spawnError", null, null, error);
      };
      child.on("close", onChildClose);
      child.on("error", onChildError);

      // `close` waits for every stdio pipe. A leftover helper that inherited
      // them (dev server, report server) would hang us after the command itself
      // exited, so settle on `exit` after a short grace period instead.
      disposeExitSettle = watchExitSettle({
        child,
        settleMs: effectiveLimits.exitSettleMs,
        onSettled: ({ code, signal: exitSignal, pipesHeld }) => {
          if (!pipesHeld) return;
          if (terminalIntent === "interruption") {
            finalize(pendingInterruption ?? "aborted", code, exitSignal, null, {
              pipesHeldAfterExit: true,
            });
            return;
          }
          if (terminalIntent !== null) return;
          terminalIntent = "completion";
          // Upstream parity: stop what is left of the group the shell led so a
          // stray `cmd &` is not orphaned untracked (POSIX only; see
          // killLeftoverGroup). A setsid/detached helper escapes the group and
          // keeps running, which the result note reports.
          const leftoverStopped = pid !== null && killLeftoverGroup(pid);
          log("INFO", "bash", "Command exited while a leftover process held its output", {
            pid: String(pid ?? "unknown"),
            leftover: leftoverStopped ? "stopped" : "not stopped",
          });
          finalize(code === 0 ? "completed" : "nonZeroExit", code, exitSignal, null, {
            pipesHeldAfterExit: true,
            leftoverStopped,
          });
        },
      });

      armWatchdog(pid === null ? null : effectiveLimits.yieldMs);

      signal.addEventListener("abort", onAbort, { once: true });
      abortListenerRegistered = true;
      if (signal.aborted) onAbort();
    } catch (error) {
      finalize("spawnError", null, null, error instanceof Error ? error : new Error(String(error)));
    }
  });
}

interface PersistentCommandOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  /** Stop after this long with no output; 0/omitted = never. */
  inactivityMs?: number;
  signal: AbortSignal;
  processManager: ProcessManager;
  shell: PersistentShell;
  onUpdate?: (output: string, totalBytes: number) => void;
}

async function executePersistentCommand({
  command,
  cwd,
  timeoutMs,
  inactivityMs,
  signal,
  processManager,
  shell,
  onUpdate,
}: PersistentCommandOptions): Promise<ForegroundCommandExecution> {
  const startedAt = Date.now();
  const foregroundLog = await processManager.allocateForegroundLog();
  const result = await shell.run(
    command,
    timeoutMs,
    signal,
    onUpdate,
    foregroundLog,
    inactivityMs ?? 0,
  );
  await foregroundLog.close();
  if (foregroundLog.error) {
    log("WARN", "bash", "Persistent foreground log stream failed", {
      executionId: foregroundLog.executionId,
      logPath: foregroundLog.logPath,
      error: foregroundLog.error.message,
    });
  }

  return {
    outcome: {
      metadata: {
        executionId: foregroundLog.executionId,
        command,
        cwd,
        startedAt,
        timeoutMs,
        pid: result.pid,
        logPath: foregroundLog.logPath,
      },
      reason: result.reason,
      exitCode: result.exitCode,
      signal: result.signal,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      error: result.error,
      backgroundTaskId: null,
      pipesHeldAfterExit: false,
    },
    rawOutput: result.output,
    outputCapped: result.outputCapped,
    outputSnapshot: result.outputSnapshot,
    isCmdFallback: false,
  };
}

async function renderStructuredForegroundResult(
  execution: ForegroundCommandExecution,
  persistent: boolean,
  command?: string,
): Promise<{ content: string; details: BashToolResultDetails; isError?: boolean }> {
  const { outcome } = execution;
  const diagnostics = formatForegroundDiagnostics(outcome);
  const details: BashToolResultDetails = {
    bashDiagnostics: bashDiagnostics(execution),
  };
  if (outcome.reason === "spawnError") {
    return {
      content:
        `Exit code: 1\nFailed to spawn: ${outcome.error?.message ?? "Unknown error"}\n\n` +
        diagnostics,
      details,
      // A shell that never launched is a tool failure, not a successful run
      // whose output happens to mention an error.
      isError: true,
    };
  }

  let output = await renderBashOutput(execution.rawOutput, command, !execution.isCmdFallback);
  if (execution.outputCapped) {
    output =
      `[Output exceeded ${MAX_OUTPUT_BYTES / 1024 / 1024} MB; the earliest part was dropped. ` +
      `Complete sanitized log: ${outcome.metadata.logPath}]\n` +
      output;
  }
  // Windows without Git Bash: commands ran under cmd.exe, NOT bash. Tell
  // the model so it uses cmd syntax (no `ls`/`grep`/pipes/single-quotes)
  // and doesn't misread failures as a wrong directory / environment.
  if (execution.isCmdFallback) {
    output =
      "[Ran under Windows cmd.exe — bash is unavailable. Use cmd syntax " +
      "(dir, findstr, type); POSIX commands and quoting will fail. " +
      "Install Git for Windows to get bash.]\n" +
      output;
  }

  if (outcome.reason === "backgrounded" && outcome.backgroundTaskId !== null) {
    const id = outcome.backgroundTaskId;
    return {
      content:
        `Still running after ${formatDuration(outcome.elapsedMs)} — moved to background task ${id} ` +
        `(not killed). It is still stopped automatically after a long stretch with no output ` +
        `or at the hard time limit. Call task_output with id="${id}" and wait_ms; it returns ` +
        `the moment the command exits or prints a failure. Output so far:\n${output}\n\n${diagnostics}`,
      details,
    };
  }

  const exitCode =
    outcome.reason === "completed"
      ? "0"
      : outcome.reason === "timedOut"
        ? `TIMEOUT (${outcome.metadata.timeoutMs}ms)${
            persistent ? " — session shell was reset; cd/env state is gone" : ""
          }`
        : outcome.reason === "inactive"
          ? `INACTIVE (stopped after ${formatDuration(outcome.elapsedMs)}: no output for the inactivity limit)${
              persistent ? " — session shell was reset; cd/env state is gone" : ""
            }`
          : outcome.reason === "aborted"
            ? "ABORTED"
            : outcome.exitCode !== null
              ? String(outcome.exitCode)
              : outcome.signal
                ? `SIGNAL (${outcome.signal})`
                : "FAILED (no exit code)";

  const leftoverNote = outcome.pipesHeldAfterExit
    ? `[The command exited, but a process it left running in the background (& or nohup) ` +
      `still held its output after it finished, ` +
      (outcome.leftoverStopped
        ? "so it was stopped. "
        : "so its later output was not captured; it may still be running. ") +
      "Use run_in_background=true for anything that should keep running.]\n"
    : "";
  const inactiveHint =
    outcome.reason === "inactive"
      ? "[Stopped because it printed nothing for too long. If this step is legitimately " +
        "silent, raise the bashInactivitySeconds setting instead of retrying as-is.]\n"
      : "";

  return {
    content: `Exit code: ${exitCode}\n${leftoverNote}${inactiveHint}${output}\n\n${diagnostics}`,
    details,
  };
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 120) return `${seconds}s`;
  return `${Math.round(seconds / 60)} min`;
}

const BashParams = z.object({
  command: z.string(),
  review: z
    .boolean()
    .optional()
    .describe("Local foreground check only: append git status/diff after success"),
  timeout: z.number().int().min(1000).optional().describe("Hard limit ms; disables hand-off"),
  run_in_background: z.boolean().optional(),
  persist: z.boolean().optional().describe("Keep cd/env across calls"),
  wake: z
    .object({
      pattern: z.string().min(1).max(200).optional(),
      silence_seconds: z.number().int().min(10).max(3600).optional(),
    })
    .refine((rules) => rules.pattern !== undefined || rules.silence_seconds !== undefined, {
      message: "Provide wake.pattern, wake.silence_seconds, or both.",
    })
    .optional()
    .describe("Notify on output match or silence"),
});

export function createBashTool(
  cwd: string,
  processManager: ProcessManager,
  ops: ToolOperations = localOperations,
  planModeRef?: { current: boolean },
  shellOpts?: ResolveShellOpts,
  getNetworkPolicy?: GetNetworkPolicy,
  getSandboxPolicy?: () => SandboxPolicy,
  getForegroundLimitSettings?: () => ForegroundLimitSettings,
): AgentTool<typeof BashParams> {
  // Lazily created on the first persist:true call; one session per tool
  // instance (i.e. per agent session), owned by the shared process manager.
  let sessionShell: PersistentShell | null = null;
  /** Install commands the model re-ran after a typosquat warning. */
  const confirmedInstalls = new Set<string>();
  let sessionSandboxKey: string | null = null;
  let sessionSandboxed = false;
  // Shell selection doesn't depend on the command, so resolve ONCE at tool
  // creation and bake the true execution environment into the description —
  // promising bash on a cmd.exe fallback makes the model write POSIX commands
  // that all fail. The runtime output banner below stays as belt-and-braces
  // for mid-session PATH changes.
  const isCmdFallback = resolveShell("", shellOpts ?? {}).isCmdFallback;
  const description = isCmdFallback
    ? "Run a Windows cmd.exe command (no bash on this system) in the project root. Use cmd " +
      "syntax (dir, findstr, type); POSIX commands and $(...) fail. " +
      FOREGROUND_LIMITS_DESCRIPTION
    : "Run a non-interactive bash command (TERM=dumb, pipefail) in the project root. " +
      FOREGROUND_LIMITS_DESCRIPTION;
  return {
    name: "bash",
    description:
      description +
      " Servers/watchers/REPLs: run_in_background + wake.pattern, then task_output wait_ms; " +
      "never `&`, nohup or sleep. Leave servers running. Kill by exact PID.",
    parameters: BashParams,
    executionMode: "sequential",
    // Bash owns its limits (yield hand-off, inactivity, hard backstop); the
    // loop must not preempt them.
    timeoutMs: 0,
    async execute(
      { command, timeout: timeoutMs, run_in_background, persist, wake, review },
      context,
    ) {
      if (
        review &&
        (persist ||
          run_in_background ||
          ops !== localOperations ||
          !classifyVerificationCommand(command).accepted)
      ) {
        return REVIEW_REJECTED_BEFORE_START;
      }
      const commandMode = run_in_background === true ? "background" : "foreground";
      if (wake && !run_in_background) {
        return "Error: wake conditions require run_in_background=true — there is nothing to watch on a foreground call.";
      }
      let wakeRules: WakeRules | undefined;
      if (wake?.pattern) {
        try {
          wakeRules = { pattern: new RegExp(wake.pattern) };
        } catch (error) {
          return `Error: wake.pattern is not a valid regex (${(error as Error).message}). Fix the pattern and retry.`;
        }
      }
      if (wake?.silence_seconds) {
        wakeRules = { ...wakeRules, silenceMs: wake.silence_seconds * 1000 };
      }
      // A long sleep-only foreground call while something runs in the
      // background is a guessed wait: too short wastes a turn, too long wastes
      // wall-clock. Redirect rather than run it — descriptions alone do not
      // reliably beat the habit. Brief sleeps stay allowed, because letting a
      // just-started dev server settle before curling it is legitimate and no
      // exit is ever coming for it.
      const napSeconds = run_in_background ? null : sleepOnlySeconds(command);
      if (napSeconds !== null && napSeconds >= GUESSED_WAIT_SECONDS) {
        const running = processManager.list().filter((proc) => proc.exitCode === null);
        if (running.length > 0) {
          const ids = running.map((proc) => proc.id).join(", ");
          return (
            `Error: refusing to sleep ${napSeconds}s while ${running.length} background ` +
            `process(es) are running (${ids}). Sleeping guesses at a finish time. Call ` +
            `task_output with wait_ms instead \u2014 it returns on exit or a declared wake. ` +
            `For something that never exits, such as a dev server, run it with a wake ` +
            `pattern and wait for that line.`
          );
        }
      }
      if (isPlanModeActive(planModeRef) && !isReadOnlyCommand(command)) {
        return planModeRestriction("bash");
      }
      // Catastrophic-command guard — enforced in code, before every execution
      // path (persistent shell, background, and normal spawn).
      const catastrophic = isCatastrophicCommand(command, cwd);
      if (catastrophic) {
        return `Error: ${catastrophic}`;
      }
      // Destructive-git guard — refuses reset --hard / checkout -- / restore /
      // clean -f / stash drop / branch -D / force push when work would be lost.
      // A persist:true call runs wherever the session shell last cd'd to.
      const liveShell = persist && process.platform !== "win32" ? sessionShell : null;
      const gitBlocked = await checkDestructiveGit(command, {
        cwd,
        resolveCwd:
          liveShell && !liveShell.isBusy
            ? async () => (await liveShell.run("pwd", 2_000, context.signal)).output.trim() || null
            : undefined,
      });
      if (gitBlocked) {
        return `Error: ${gitBlocked}`;
      }
      // Shell-threat guard — pipe-to-shell, reverse shells, secret exfiltration,
      // lookalike hosts and terminal-escape tricks (core/shell-threats.ts).
      const threatBlocked = shellThreatBlockMessage(command);
      if (threatBlocked) {
        return `Error: ${threatBlocked}`;
      }
      // Package-install guard: known malware (OSV, fail-open) is refused;
      // a likely typosquat is stopped once and allowed on an identical retry.
      const packageThreats = await checkPackageInstall(command, { signal: context.signal });
      const malware = packageThreats.find((threat) => threat.severity === "block");
      if (malware) {
        return `Error: Blocked by package safety check (${malware.rule}): ${malware.detail}`;
      }
      const typosquats = packageThreats.filter((threat) => threat.severity === "warn");
      if (typosquats.length > 0 && !confirmedInstalls.has(command)) {
        confirmedInstalls.add(command);
        return (
          `Error: not run — ${typosquats.map((threat) => threat.detail).join("; ")}. ` +
          `If this really is the package you want, run the exact same command again.`
        );
      }
      // Network allowlist — defence in depth only.
      const networkBlocked = checkCommandPolicy(command, getNetworkPolicy);
      if (networkBlocked) {
        return `Error: ${networkBlocked}`;
      }
      // cmd.exe cannot preserve the failing stage's status. Refuse pipelines
      // rather than let a successful limiter turn a failed check into evidence.
      if (resolveShell(command, shellOpts).isCmdFallback && /(^|[^|])\|([^|]|$)/.test(command)) {
        return "Error: pipelines require Bash with pipefail. Run the check without a pipe on Windows cmd.exe.";
      }
      const sandboxPolicy = getSandboxPolicy?.() ?? { mode: "off", allowedDomains: [] };
      const prepareLaunch = async (
        shell: ReturnType<typeof resolveShell>,
      ): Promise<SandboxLaunch> => prepareSandboxLaunch(shell, cwd, sandboxPolicy);

      // Persistent session mode — POSIX only; Windows-without-bash falls through
      // to the normal spawn path (cmd.exe fallback) below.
      if (
        persist &&
        commandMode === "foreground" &&
        !resolveShell(command, shellOpts).isCmdFallback
      ) {
        const sandboxKey = JSON.stringify(sandboxPolicy);
        if (sessionShell && sessionSandboxKey !== sandboxKey) {
          sessionShell.kill();
          sessionShell = null;
        }
        if (!sessionShell) {
          try {
            const resolved = resolveShell("", shellOpts);
            const launch = await prepareLaunch({
              ...resolved,
              args: ["--norc", "--noprofile", "-o", "pipefail"],
            });
            const shell = new PersistentShell(
              cwd,
              sandboxAwareEnv(launch.sandboxed),
              MAX_OUTPUT_BYTES,
              ops.process,
              shellOpts,
              launch,
            );
            sessionShell = shell;
            processManager.registerShutdown(
              () => shell.killNow(),
              () => shell.shutdownAndWait(),
            );
            sessionSandboxKey = sandboxKey;
            sessionSandboxed = launch.sandboxed;
          } catch (error) {
            return `Error: OS sandbox unavailable; command was not run: ${(error as Error).message}`;
          }
        }
        const persistentLimits = resolveForegroundLimits({
          explicitTimeoutMs: timeoutMs,
          settings: getForegroundLimitSettings?.() ?? DEFAULT_FOREGROUND_LIMIT_SETTINGS,
          platform: process.platform,
          mode: "persistent",
          canHandOff: false,
        });
        if (context.signal.aborted) return CANCELLED_BEFORE_START;
        const execution = await executePersistentCommand({
          command,
          cwd,
          timeoutMs: persistentLimits.hardMs ?? NO_DEADLINE,
          inactivityMs: persistentLimits.inactivityMs ?? 0,
          signal: context.signal,
          processManager,
          shell: sessionShell,
          onUpdate: context.onUpdate
            ? (output, totalBytes) =>
                context.onUpdate?.({ type: "bash_progress", output, totalBytes })
            : undefined,
        });
        const rendered = await renderStructuredForegroundResult(execution, true, command);
        return {
          ...rendered,
          content: annotateSandboxDenial(rendered.content, sessionSandboxed),
        };
      }
      if (commandMode === "background") {
        let launch: SandboxLaunch;
        try {
          launch = await prepareLaunch(resolveShell(command, shellOpts));
        } catch (error) {
          return `Error: OS sandbox unavailable; command was not run: ${(error as Error).message}`;
        }
        if (context.signal.aborted) return CANCELLED_BEFORE_START;
        const result = await processManager.start(command, cwd, launch, wakeRules);
        const watchWarnings = backgroundWatchWarnings(command);
        return (
          `Background process started.\n` +
          `ID: ${result.id}\n` +
          `PID: ${result.pid}\n` +
          `Log: ${result.logFile}\n` +
          (wakeRules
            ? result.wakeArmed
              ? `Wake rules armed: ${[
                  wakeRules.pattern ? `pattern /${wakeRules.pattern.source}/` : null,
                  wakeRules.silenceMs ? `silence ${wakeRules.silenceMs / 1000}s` : null,
                ]
                  .filter(Boolean)
                  .join(
                    " + ",
                  )}. You will be notified automatically when one fires or the process exits.\n`
              : `Wake conditions were NOT armed: this session has no notification path, so nothing will wake you automatically. Poll task_output periodically instead.\n`
            : "") +
          `Use task_output with id="${result.id}" to read output, ` +
          `task_send to type input/answer prompts, task_stop to stop it.` +
          watchWarnings.map((warning) => `\nWarning: ${warning}`).join("")
        );
      }

      const limits = resolveForegroundLimits({
        explicitTimeoutMs: timeoutMs,
        settings: getForegroundLimitSettings?.() ?? DEFAULT_FOREGROUND_LIMIT_SETTINGS,
        platform: process.platform,
        mode: "spawn",
        canHandOff: true,
      });
      const shell = resolveShell(command, shellOpts);
      let launch: SandboxLaunch;
      try {
        launch = await prepareLaunch(shell);
      } catch (error) {
        return `Exit code: 1\nOS sandbox unavailable; command was not run: ${(error as Error).message}`;
      }
      // A build, or a check wrapped in read-only commands, is evidence only
      // when workspace inputs are unchanged across the run (upstream's snapshot
      // rule). Both snapshots are taken inside this call, so nothing the
      // command writes can land before the "before" snapshot.
      const inputsBefore =
        ops === localOperations &&
        classifyVerificationCommand(command, { posixShell: !shell.isCmdFallback })
          .snapshotEligible === true
          ? await captureVerificationSnapshot(cwd)
          : undefined;
      // Stop may have landed while the launch was being prepared. The abort
      // listener below would never fire for an already-aborted signal.
      if (context.signal.aborted) return CANCELLED_BEFORE_START;

      const execution = await executeForegroundCommand({
        command,
        cwd,
        timeoutMs: limits.hardMs ?? NO_DEADLINE,
        limits,
        signal: context.signal,
        ops,
        processManager,
        launch,
        onUpdate: context.onUpdate
          ? (output, totalBytes) =>
              context.onUpdate?.({ type: "bash_progress", output, totalBytes })
          : undefined,
      });
      const rendered = await renderStructuredForegroundResult(execution, false, command);
      // A hand-off is still running: its "after" state does not exist yet.
      if (
        inputsBefore !== undefined &&
        rendered.details.bashDiagnostics.reason !== "backgrounded"
      ) {
        const inputsAfter = inputsBefore === null ? null : await captureVerificationSnapshot(cwd);
        rendered.details.bashDiagnostics.sourceUnchanged =
          inputsBefore !== null && inputsAfter === inputsBefore;
      }
      const result = {
        ...rendered,
        content: annotateSandboxDenial(rendered.content, launch.sandboxed),
      };
      const diagnostics = rendered.details.bashDiagnostics;
      if (
        !review ||
        context.signal.aborted ||
        diagnostics?.reason !== "completed" ||
        diagnostics.exitCode !== 0
      ) {
        return result;
      }
      const inspection = await collectVerificationReview(cwd, context.signal);
      return {
        ...result,
        content: `${result.content}

--- Independent read-only review ---
${await renderBashOutput(inspection)}`,
      };
    },
  };
}
