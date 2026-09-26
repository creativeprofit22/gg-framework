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
import { truncateTail, MAX_BYTES } from "./truncate.js";
import { compressToolOutput } from "./compress.js";
import { writeOverflow } from "./overflow.js";
import { localOperations, type ToolOperations } from "./operations.js";
import { getSafeToolEnv } from "./safe-env.js";
import { resolveShell, type ResolveShellOpts } from "../core/shell.js";
import { PersistentShell } from "../core/persistent-shell.js";
import { isReadOnlyCommand, sleepOnlySeconds } from "./read-only-bash.js";
import { isPlanModeActive, planModeRestriction } from "../core/runtime-mode.js";
import { isCatastrophicCommand } from "../core/workspace-guard.js";
import { checkCommandPolicy, type GetNetworkPolicy } from "../core/network-guard.js";
import {
  BOUNDED_OUTPUT_MAX_BYTES,
  BOUNDED_OUTPUT_MAX_LINES,
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

/** Tool env, plus the tweaks that only make sense inside the OS sandbox. */
function sandboxAwareEnv(sandboxed: boolean): Record<string, string> {
  const env = getSafeToolEnv();
  return sandboxed ? { ...env, ...SANDBOX_ENV_PATCH } : env;
}

/** Internal deadline sentinel: omitted bash timeout means no deadline. */
const NO_DEADLINE = 0;
const FOREGROUND_TIMEOUT_CLEANUP_GRACE_MS = 1_000;
const FOREGROUND_LIMITS_DESCRIPTION =
  "Finite build, test, lint, format, migration, and one-shot commands run in foreground. " +
  "A command still running after the soft limit (default 2 min, configurable) is handed off to a background " +
  "task — not killed — and the result gives its ID and output so far; then call task_output " +
  "with that id and wait_ms, which returns the moment it exits. A command with no output for a " +
  "long time (default 10 min, configurable) or past the hard limit (default 60 min, configurable) is stopped automatically, " +
  "including after hand-off. Omit timeout unless you need a hard bound. Long output is truncated (tail kept). ";
const MAX_OUTPUT_BYTES = BOUNDED_OUTPUT_MAX_BYTES;
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
export async function renderBashOutput(rawOutput: string): Promise<string> {
  const result = truncateTail(rawOutput);
  if (!result.truncated) return result.content;
  const overflowPath =
    Buffer.byteLength(rawOutput, "utf-8") > MAX_BYTES
      ? await writeOverflow(rawOutput, "bash").catch(() => null)
      : null;
  const overflowNotice = overflowPath
    ? ` Full output saved to ${overflowPath} — read it with offset/limit if needed.`
    : "";
  const c = compressToolOutput(rawOutput);
  return `[${c.notice}${overflowNotice}]\n${c.content}`;
}

export interface ForegroundCommandExecution {
  outcome: ForegroundExecutionOutcome;
  rawOutput: string;
  outputCapped: boolean;
  outputSnapshot: BoundedOutputTailSnapshot;
  isCmdFallback: boolean;
}

function bashDiagnostics(
  outcome: ForegroundExecutionOutcome,
  output: BoundedOutputTailSnapshot,
): BashDiagnostics {
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
    outputCapped: output.capped,
    totalOutputBytes: output.totalInputBytes,
    retainedOutputBytes: output.retainedBytes,
    droppedOutputBytes: Math.max(0, output.totalInputBytes - output.retainedBytes),
    backgroundTaskId: outcome.backgroundTaskId,
    pipesHeldAfterExit: outcome.pipesHeldAfterExit,
  };
}

function formatForegroundDiagnostics(outcome: ForegroundExecutionOutcome, tail: string): string {
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
    `Log: ${metadata.logPath}\n` +
    `Final output (last ${BOUNDED_OUTPUT_MAX_LINES} lines):\n` +
    "--- begin final output ---\n" +
    tail +
    (tail.endsWith("\n") || tail.length === 0 ? "" : "\n") +
    "--- end final output ---"
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
      extra: { backgroundTaskId?: string; pipesHeldAfterExit?: boolean } = {},
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
        },
        rawOutput: outputSnapshot.content,
        outputCapped: outputSnapshot.capped,
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
            const seedOutput = outputTail.snapshot().content;
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
        writeForegroundLog(`[${source}] ${output}`);
        onUpdate?.(output, totalBytes);
      };
      const emitBinarySummary = (state: ForegroundOutputStreamState): void => {
        if (state.binaryBytes === state.reportedBinaryBytes) return;
        const marker = `[${state.source} binary output omitted: ${state.binaryBytes} bytes]\n`;
        state.reportedBinaryBytes = state.binaryBytes;
        outputTail.append(marker);
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
          log("INFO", "bash", "Command exited while a leftover process held its output", {
            pid: String(pid ?? "unknown"),
          });
          finalize(code === 0 ? "completed" : "nonZeroExit", code, exitSignal, null, {
            pipesHeldAfterExit: true,
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
    outputCapped: result.outputSnapshot.capped,
    outputSnapshot: result.outputSnapshot,
    isCmdFallback: false,
  };
}

async function renderStructuredForegroundResult(
  execution: ForegroundCommandExecution,
  persistent: boolean,
): Promise<{ content: string; details: BashToolResultDetails; isError?: boolean }> {
  const { outcome } = execution;
  const diagnostics = formatForegroundDiagnostics(outcome, execution.rawOutput);
  const details: BashToolResultDetails = {
    bashDiagnostics: bashDiagnostics(outcome, execution.outputSnapshot),
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

  let output = await renderBashOutput(execution.rawOutput);
  if (execution.outputCapped) {
    output =
      `[Foreground output tail capped at ${BOUNDED_OUTPUT_MAX_LINES} lines / ` +
      `${MAX_OUTPUT_BYTES / 1024 / 1024} MB. Complete sanitized log: ` +
      `${outcome.metadata.logPath}]\n` +
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
        `the moment the command exits. Output so far:\n${output}\n\n${diagnostics}`,
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
    ? "[The command exited, but a process it started is still running and holding its " +
      "output. It was left running (it may be an intended server or daemon).]\n"
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
  command: z.string().describe("The bash command to execute"),
  timeout: z
    .number()
    .int()
    .min(1000)
    .optional()
    .describe(
      "Optional hard limit in milliseconds. Usually omit it: long commands are handed off to a " +
        "background task automatically instead of being killed. Setting it keeps the command in " +
        "the foreground (no hand-off) until it exits, hits this limit, or produces no output for " +
        "the inactivity limit.",
    ),
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      "Run long-lived or interactive commands in managed background mode. Use true for dev " +
        "servers, watchers, REPLs, scaffolders, and programs waiting for input; the call returns " +
        "after spawn with an ID, PID, and log. Default false for finite foreground commands.",
    ),
  persist: z
    .boolean()
    .optional()
    .describe(
      "Run in the persistent session shell: cd, exported env vars, and shell state " +
        "survive across persist:true calls. Use for multi-step workflows in another " +
        "directory or with sourced environments. Default false (fresh shell per call).",
    ),
  wake: z
    .object({
      pattern: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe(
          "A regex; the moment NEW output matches it you are actively woken with the " +
            "matching line — no task_output polling. Use for signals in long builds, " +
            "dev servers and watchers (e.g. 'compiled with errors', 'listening on').",
        ),
      silence_seconds: z
        .number()
        .int()
        .min(10)
        .max(3600)
        .optional()
        .describe(
          "Wake me if the task produces no output at all for this many seconds while " +
            "still running — a stall/hang detector for commands that should be chatty.",
        ),
    })
    .refine((rules) => rules.pattern !== undefined || rules.silence_seconds !== undefined, {
      message: "Provide wake.pattern, wake.silence_seconds, or both.",
    })
    .optional()
    .describe(
      "Wake conditions for a background task (run_in_background only). You are " +
        "notified automatically the instant one holds, instead of polling " +
        "task_output. Each condition fires once; exit always notifies regardless.",
    ),
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
  let sessionSandboxKey: string | null = null;
  let sessionSandboxed = false;
  // Shell selection doesn't depend on the command, so resolve ONCE at tool
  // creation and bake the true execution environment into the description —
  // promising bash on a cmd.exe fallback makes the model write POSIX commands
  // that all fail. The runtime output banner below stays as belt-and-braces
  // for mid-session PATH changes.
  const isCmdFallback = resolveShell("", shellOpts ?? {}).isCmdFallback;
  const description = isCmdFallback
    ? "Execute a command under Windows cmd.exe (no bash was found on this system). " +
      "The working directory is already set to the project root — " +
      "don't cd into it redundantly. Use cd only when you need a different directory. " +
      "Returns exit code and combined stdout/stderr. " +
      "Use cmd.exe syntax (dir, findstr, type, del); POSIX commands and bash syntax " +
      "(ls, grep, cat, &&-chains relying on bash semantics, $(...), single-quoting) will fail. " +
      FOREGROUND_LIMITS_DESCRIPTION +
      "Set run_in_background=true for long-lived or interactive commands " +
      "(dev servers, watchers, REPLs, scaffolders, programs that prompt for input); the call returns " +
      "after spawn. Use task_output to read output, task_send to type input/answer prompts, and " +
      "task_stop to stop background processes. " +
      "Commit, push, amend, or rewrite git history only when the user explicitly asked. " +
      "Kill processes by exact PID (taskkill /PID), never by image name alone."
    : "Execute a bash command. The shell's working directory is already set to the project root — " +
      "don't cd into it redundantly. Use cd only when you need a different directory. " +
      "Returns exit code and combined stdout/stderr. " +
      "Pipelines run with pipefail — a piped command reports the failing stage's exit " +
      "code, so piping tests through tail/head cannot mask a failure. " +
      "Commands run in a non-interactive bash shell with TERM=dumb. " +
      FOREGROUND_LIMITS_DESCRIPTION +
      "Set run_in_background=true for long-lived or interactive commands " +
      "(dev servers, watchers, REPLs, scaffolders, programs that prompt for input); the call returns " +
      "after spawn. Use task_output to read output, task_send to type input/answer prompts, and " +
      "task_stop to stop background processes. " +
      "Commit, push, amend, or rewrite git history only when the user explicitly asked. " +
      "Never background a command with a trailing & or nohup — use run_in_background instead. " +
      "Kill processes by exact PID, never broad patterns like pkill -f node. " +
      "Set persist=true to run in a foreground session shell where cd/env state survives across " +
      "persist:true calls. " +
      "With run_in_background, also set wake (pattern and/or silence_seconds) to be " +
      "actively notified the moment matching output appears or the task stalls. " +
      "Never sleep to wait for a background process — task_output with wait_ms returns " +
      "when it exits or a declared wake fires.";
  return {
    name: "bash",
    description:
      description +
      " For dev servers, set a readiness wake.pattern, use task_output with wait_ms, " +
      "then check HTTP and finish while leaving the server running. " +
      "Do not use silence as readiness; healthy servers normally go quiet.",
    parameters: BashParams,
    executionMode: "sequential",
    // Bash owns its limits (yield hand-off, inactivity, hard backstop); the
    // loop must not preempt them.
    timeoutMs: 0,
    async execute({ command, timeout: timeoutMs, run_in_background, persist, wake }, context) {
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
        const rendered = await renderStructuredForegroundResult(execution, true);
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
        const result = await processManager.start(command, cwd, launch, wakeRules);
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
          `task_send to type input/answer prompts, task_stop to stop it.`
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
      const rendered = await renderStructuredForegroundResult(execution, false);
      return {
        ...rendered,
        content: annotateSandboxDenial(rendered.content, launch.sandboxed),
      };
    },
  };
}
