import { randomUUID } from "node:crypto";
import os from "node:os";
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
import {
  cleanTerminalOutput,
  compactProgressRuns,
  compactRoutineOutput,
} from "./routine-output.js";
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
import { checkPackageInstall, packageBlockMessage } from "../core/package-threats.js";
import {
  bunCooldownCommand,
  cooldownFailureHint,
  detectMentionedVersions,
  mayInstall,
  packageCooldownEnv,
  scopeCooldown,
} from "../core/package-cooldown.js";
import {
  DEFAULT_CONCURRENCY_SETTINGS,
  classifyHeavyCheck,
  deriveConcurrencyBudget,
  detectProjectConcurrencyConfig,
  formatConcurrencyLine,
  leadingCdTarget,
  readMachineFacts,
  resolveConcurrencyEnv,
  scopeConcurrency,
  type ConcurrencyEnvResult,
  type ConcurrencySettings,
  type HeavySlotLease,
  type MachineFacts,
} from "../core/machine-profile.js";
import { classifyVerificationCommand, matchVerifyPlanGate } from "../core/verification-evidence.js";
import {
  captureCheckInputs,
  formatPriorPassNotice,
  formatProjectReportedPasses,
  type CaptureCheckInputsArgs,
  type CheckCoverageMemory,
  type CheckCoverageRecord,
  type CheckInputs,
} from "../core/check-coverage.js";
import { overloadHint, redirectHint, sharedLogWarning } from "./check-hints.js";
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
import type { VerifyPlan } from "@kenkaiiii/gg-core/verify-plan";
import {
  findGateQuietBudgetSeconds,
  handOffNotice,
  inactiveHint,
  resolveQuietBudgetMs,
} from "./quiet-budget.js";
import { annotateSandboxDenial } from "../core/sandbox-feedback.js";
import { collectVerificationReview } from "./verification-review.js";
import { captureVerificationSnapshot } from "../core/verification-snapshot.js";
import {
  captureChangedFilesState,
  diffChangedFiles,
  formatChangedFilesNote,
  type ChangedFilesHashCache,
  type ChangedFilesResult,
  type ChangedFilesRootCache,
  type ChangedFilesSkip,
  type ChangedFilesState,
  type ToolWriteLog,
} from "../core/changed-files.js";

/** Tool env, plus the tweaks that only make sense inside the OS sandbox. */
function sandboxAwareEnv(
  sandboxed: boolean,
  cooldown: Record<string, string> = {},
): Record<string, string> {
  const env = { ...getSafeToolEnv(), ...cooldown };
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
 *
 * A check whose exit status cannot prove success (`npm test | grep x; git diff`)
 * gets no note in its result. The host still refuses it as evidence; if the
 * turn would end unverified, the session re-runs the check on its own
 * (AgentSession.rerunRefusedCheck) and counts only that exit status. The note
 * used to flag the command mid-task; on Haiku 5.5 the model re-ran
 * the suite after it nearly every time, and spent thinking deciding whether
 * the note was an injection, while the output it had was already correct.
 * Removing it cut model requests 7% and input tokens 9% at an unchanged pass
 * rate; time saved was within noise (bench/h2h/arena, haiku-confirm, 100
 * paired trials, 2026-10-18).
 */
export async function renderBashOutput(rawOutput: string): Promise<string> {
  // ANSI codes and \r redraws never mean anything in a tool result; runs of
  // installer/build progress lines collapse to first + count + last. Error
  // lines are never touched (routine-output.ts).
  const cleaned = cleanTerminalOutput(rawOutput);
  const shown = compactProgressRuns(cleaned);
  const result = truncateTail(shown);
  // Under the limit: drop routine boilerplate (git log/status labels, ls
  // owner columns, green per-file test lines) — see routine-output.ts.
  if (!result.truncated) return compactRoutineOutput(result.content);
  const overflowPath =
    Buffer.byteLength(shown, "utf-8") > MAX_BYTES
      ? await writeOverflow(cleaned, "bash").catch(() => null)
      : null;
  const overflowNotice = overflowPath
    ? ` Full output saved to ${overflowPath} — read it with offset/limit if needed.`
    : "";
  const c = compressToolOutput(shown);
  const what = describeCompressed(shown, c.content);
  return `[${c.notice}${what ? ` ${what}` : ""}${overflowNotice}]\n${c.content}`;
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
  /** Extra env for this command only (package release-age cooldown). */
  env?: Record<string, string>;
  /** Heavy-check slot; a hand-off passes it to the background task. */
  heavySlot?: HeavySlotLease;
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
  env,
  heavySlot,
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
        /** Settles with `adopt()`'s `wakeArmed`; the result waits for it. */
        quietNoticeArmed?: Promise<boolean>;
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
      void Promise.all([foregroundLog.close(), extra.quietNoticeArmed]).then(([, armed]) => {
        if (armed !== undefined) result.outcome.quietNoticeArmed = armed;
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
      // takeOver runs before adopt() knows whether a silence notice can be sent.
      let settleArmed: (armed: boolean) => void = () => {};
      const quietNoticeArmed = new Promise<boolean>((resolve) => {
        settleArmed = resolve;
      });
      try {
        const adopted = await processManager.adopt({
          child: running,
          pid: handedOffPid,
          command,
          startedAt,
          heavySlot,
          limits: {
            // Silence after the move only notifies; the hard limit is the kill.
            quietMs: effectiveLimits.inactivityMs,
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
            finalize("backgrounded", null, null, null, {
              backgroundTaskId: taskId,
              quietNoticeArmed,
            });
            log("INFO", "bash", "Foreground command handed off to background task", {
              taskId,
              pid: String(handedOffPid),
              elapsedMs: String(Date.now() - startedAt),
            });
            return { seedOutput, lastOutputAt };
          },
        });
        settleArmed(adopted.wakeArmed);
      } catch (error) {
        settleArmed(false);
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
        env: sandboxAwareEnv(effectiveLaunch.sandboxed, env),
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
  /** What the shell actually runs (cooldown-scoped); `command` stays the recorded one. */
  runCommand?: string;
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
  runCommand = command,
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
    runCommand,
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
  budgetSummary?: string,
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

  let output = await renderBashOutput(execution.rawOutput);
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
        handOffNotice({
          id,
          elapsed: formatDuration(outcome.elapsedMs),
          quietNotice: outcome.quietNoticeArmed === true,
          hardLimit:
            outcome.metadata.timeoutMs > 0 ? formatDuration(outcome.metadata.timeoutMs) : null,
        }) + ` Output so far:\n${output}\n\n${diagnostics}`,
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
  const silenceHint = outcome.reason === "inactive" ? inactiveHint({ persistent }) : "";
  const { command, logPath } = outcome.metadata;
  const posixShell = !execution.isCmdFallback;
  const checkHints =
    redirectHint(command, logPath, posixShell) +
    sharedLogWarning(command, logPath, posixShell) +
    (exitCode === "0" ? "" : overloadHint(execution.rawOutput, budgetSummary));

  return {
    content: `Exit code: ${exitCode}\n${leftoverNote}${silenceHint}${checkHints}${output}\n\n${diagnostics}`,
    details,
  };
}

/**
 * An install the release-age cooldown may have refused: say so above the
 * output, so the model does not retry blindly (upstream gg-safe).
 */
function withCooldownHint<T extends { content: string }>(
  rendered: T,
  execution: ForegroundCommandExecution,
  install: boolean,
  cooldownDays: number,
): T {
  if (!install || execution.outcome.reason !== "nonZeroExit") return rendered;
  const hint = cooldownFailureHint(execution.rawOutput, cooldownDays);
  if (!hint) return rendered;
  // Keep "Exit code: N" first: run status and the ledger read it from line 1.
  const firstBreak = rendered.content.indexOf("\n");
  const content =
    firstBreak < 0
      ? `${rendered.content}\n[${hint}]`
      : `${rendered.content.slice(0, firstBreak + 1)}[${hint}]\n${rendered.content.slice(firstBreak + 1)}`;
  return { ...rendered, content };
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

interface ChangedFilesWatch {
  before: ChangedFilesState | ChangedFilesSkip;
  mark: number;
}

function changedFilesSkip(reason: string): ChangedFilesSkip {
  return { status: "skipped", reason, limit: false };
}

/** Union of every gate's protected paths, sorted for a stable note. */
function protectedPatternsOf(plan: VerifyPlan | null): string[] {
  return [...new Set((plan?.gates ?? []).flatMap((gate) => gate.protectedPaths))].sort();
}

export function createBashTool(
  cwd: string,
  processManager: ProcessManager,
  ops: ToolOperations = localOperations,
  planModeRef?: { current: boolean },
  shellOpts?: ResolveShellOpts,
  getNetworkPolicy?: GetNetworkPolicy,
  getSandboxPolicy?: () => SandboxPolicy,
  getForegroundLimitSettings?: () => ForegroundLimitSettings,
  /** Package release-age cooldown in days; 0 disables. Default 2. */
  getPackageCooldownDays: () => number = () => 2,
  /** The project's verify plan (core/verify-plan-loader.ts): gate classification, quiet budgets, plan-scoped coverage. */
  getVerifyPlan?: () => VerifyPlan | null,
  /** Session memory of check outcomes by input fingerprint; absent = no fingerprinting. */
  checkCoverage?: CheckCoverageMemory,
  /** The latest identical pass and whether it is still current evidence. */
  findPriorPass?: (fingerprint: string) => { record: CheckCoverageRecord; current: boolean } | null,
  /** Machine-profile concurrency settings; defaults apply when omitted. */
  getConcurrencySettings: () => ConcurrencySettings = () => DEFAULT_CONCURRENCY_SETTINGS,
  /** Heavy-check slot owner (the session id); one per tool instance when omitted. */
  getHeavySlotOwner?: () => string,
  /** Paths written by edit/write tools, left out of the changed-files note. */
  toolWrites?: ToolWriteLog,
): AgentTool<typeof BashParams> {
  const fallbackOwner = randomUUID();
  const changedFilesCache: ChangedFilesHashCache = new Map();
  const changedFilesRoot: ChangedFilesRootCache = {};
  // Fail open: a capture problem never changes the command's result.
  const beginChangedFiles = async (
    command: string,
  ): Promise<ChangedFilesWatch | ChangedFilesSkip> => {
    if (ops !== localOperations) return changedFilesSkip("remote workspace");
    if (isReadOnlyCommand(command)) return changedFilesSkip("read-only");
    const mark = toolWrites?.mark() ?? 0;
    return {
      before: await captureChangedFilesState(cwd, {
        cache: changedFilesCache,
        rootCache: changedFilesRoot,
      }),
      mark,
    };
  };
  const finishChangedFiles = async (
    watch: ChangedFilesWatch | ChangedFilesSkip,
  ): Promise<ChangedFilesResult> => {
    if (!("before" in watch)) return watch;
    const { before, mark } = watch;
    if (before.status === "skipped") return before;
    try {
      const after = await captureChangedFilesState(cwd, {
        cache: changedFilesCache,
        previous: before,
      });
      if (after.status === "skipped") return after;
      return diffChangedFiles(before, after, {
        excludePaths: toolWrites?.writtenSince(mark) ?? [],
        sessionCwd: cwd,
      });
    } catch {
      return changedFilesSkip("capture failed");
    }
  };
  let machineFacts: MachineFacts | null = null;
  // Defaults only for local spawns; fail open, since a miss just means no defaults.
  const resolveSpawnConcurrency = async (command: string): Promise<ConcurrencyEnvResult | null> => {
    const settings = getConcurrencySettings();
    if (!settings.defaults || ops !== localOperations) return null;
    try {
      machineFacts ??= readMachineFacts();
      const target = leadingCdTarget(command, cwd);
      const projectConfig = await detectProjectConcurrencyConfig({
        dirs: target ? [target, cwd] : [cwd],
        homeDir: os.homedir(),
        cargoHome: process.env.CARGO_HOME,
      });
      return resolveConcurrencyEnv({
        profile: deriveConcurrencyBudget(machineFacts, settings.budget),
        sourceEnv: process.env,
        platform: process.platform,
        projectConfig,
        command,
      });
    } catch (error) {
      log("WARN", "bash", "Concurrency defaults skipped", { error: (error as Error).message });
      return null;
    }
  };
  type HeavyGate =
    { ok: true; lease: HeavySlotLease | null; notice: string } | { ok: false; response: string };
  const acquireHeavySlot = async (
    command: string,
    signal: AbortSignal,
    onUpdate:
      ((update: { type: "bash_progress"; output: string; totalBytes: number }) => void) | undefined,
  ): Promise<HeavyGate> => {
    const heavy = ops === localOperations ? classifyHeavyCheck(command) : null;
    const limit = getConcurrencySettings().heavyCheckLimit;
    if (!heavy || !(limit > 0)) return { ok: true, lease: null, notice: "" };
    const result = await processManager.acquireHeavySlot(
      heavy.label,
      getHeavySlotOwner?.() ?? fallbackOwner,
      limit,
      signal,
      (message) => onUpdate?.({ type: "bash_progress", output: `[${message}]\n`, totalBytes: 0 }),
    );
    if (!result.ok) {
      return {
        ok: false,
        response: result.aborted ? CANCELLED_BEFORE_START : `Error: ${result.message}`,
      };
    }
    const notice =
      result.waitedMs > 0
        ? `[Waited ${formatDuration(result.waitedMs)} for another window's full test or build to finish before starting.]`
        : "";
    return { ok: true, lease: result.lease, notice };
  };
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
      // "Never by name or pattern" moved here from the lean skill, which only
      // loads for perf work: a pattern kill took down the host daemon and every
      // sibling session.
      "never `&`, nohup or sleep. Leave servers running. Kill by exact PID, never by name or pattern (pkill, killall, taskkill /IM): you run inside a host process.",
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
          !classifyVerificationCommand(command, {
            posixShell: !isCmdFallback,
            verifyPlan: getVerifyPlan?.() ?? null,
          }).accepted)
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
      const gateQuietSeconds = findGateQuietBudgetSeconds(getVerifyPlan?.(), command);
      // A started command takes the gate's quiet budget as its silence notice
      // unless the model chose one; it still gets no default notice.
      const gateSilenceMs =
        run_in_background && wakeRules?.silenceMs === undefined
          ? resolveQuietBudgetMs({ settingsSeconds: 0, gateSeconds: gateQuietSeconds })
          : null;
      if (gateSilenceMs !== null) wakeRules = { ...wakeRules, silenceMs: gateSilenceMs };
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
      // Package-install guard: known malware (local feed + version-aware OSV),
      // lockfile contents, provenance downgrade, release age and precise
      // typosquats. A catch is a block; network only for installs, fail-open.
      const cooldownDays = getPackageCooldownDays();
      // Version detection starts now, in parallel with the check (shared, once per process).
      const install = mayInstall(command);
      const versionsReady = install
        ? detectMentionedVersions(command, cwd)
        : Promise.resolve({} as Awaited<ReturnType<typeof detectMentionedVersions>>);
      const packageThreats = install
        ? await checkPackageInstall(command, { signal: context.signal, cwd, cooldownDays })
        : [];
      const packageBlocked = packageBlockMessage(packageThreats);
      if (packageBlocked) {
        // `details` carries the refused packages to the session, which records
        // them in the project's "don't install" list (core/blocked-packages-file.ts).
        const blocked = packageThreats.flatMap((t) => t.blocked ?? []);
        return {
          content: `Error: ${packageBlocked}`,
          ...(blocked.length > 0 ? { details: { safetyBlock: { packages: blocked } } } : {}),
        };
      }
      // Native release-age cooldown for every install (transitive deps too).
      const versions = await versionsReady;
      const cooldownEnv = install
        ? packageCooldownEnv(command, { days: cooldownDays, now: Date.now(), cwd, versions })
        : {};
      const concurrency = await resolveSpawnConcurrency(command);
      const concurrencyLine = concurrency ? formatConcurrencyLine(concurrency, command) : "";
      const spawnEnv = { ...(concurrency?.env ?? {}), ...cooldownEnv };
      const withConcurrency = <T extends { details: BashToolResultDetails }>(rendered: T): T => {
        if (concurrency && concurrencyLine) {
          rendered.details.bashDiagnostics.concurrency = {
            line: concurrencyLine,
            budget: concurrency.profile.budget,
            summary: concurrency.summary,
          };
        }
        return rendered;
      };
      const joinNotices = (...parts: string[]): string => parts.filter(Boolean).join("\n");
      // bun has no env setting: the cooldown goes in as a flag.
      const runCommand = install
        ? bunCooldownCommand(command, cooldownDays, versions.bun ?? null)
        : command;
      // Network allowlist — defence in depth only. Recognises the common egress
      // command shapes; an unrecognised command is never blocked (see
      // core/network-guard.ts for why this is not a sandbox).
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
              // Env is fixed at shell start: only pip's (always safe) here;
              // the others are scoped per command below.
              sandboxAwareEnv(
                launch.sandboxed,
                cooldownDays > 0 ? { PIP_UPLOADED_PRIOR_TO: `P${cooldownDays}D` } : {},
              ),
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
          quietBudgetSeconds: gateQuietSeconds,
        });
        if (context.signal.aborted) return CANCELLED_BEFORE_START;
        const persistentGate = await acquireHeavySlot(command, context.signal, context.onUpdate);
        if (!persistentGate.ok) return persistentGate.response;
        const persistentWatch = await beginChangedFiles(command);
        let execution: ForegroundCommandExecution;
        try {
          execution = await executePersistentCommand({
            command,
            runCommand: scopeConcurrency(scopeCooldown(runCommand, cooldownEnv), concurrency),
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
        } finally {
          persistentGate.lease?.release();
        }
        const rendered = withConcurrency(
          withCooldownHint(
            await renderStructuredForegroundResult(execution, true, concurrency?.summary),
            execution,
            install,
            cooldownDays,
          ),
        );
        const persistentChanged = await finishChangedFiles(persistentWatch);
        rendered.details.bashDiagnostics.changedFiles = persistentChanged;
        const persistentNotices = joinNotices(
          persistentGate.notice,
          concurrencyLine,
          formatChangedFilesNote(
            persistentChanged,
            protectedPatternsOf(getVerifyPlan?.() ?? null),
          ) ?? "",
        );
        const content = annotateSandboxDenial(rendered.content, sessionSandboxed);
        return {
          ...rendered,
          content: persistentNotices ? `${content}\n\n${persistentNotices}` : content,
        };
      }
      if (commandMode === "background") {
        let launch: SandboxLaunch;
        try {
          launch = await prepareLaunch(resolveShell(runCommand, shellOpts));
        } catch (error) {
          return `Error: OS sandbox unavailable; command was not run: ${(error as Error).message}`;
        }
        if (context.signal.aborted) return CANCELLED_BEFORE_START;
        const backgroundGate = await acquireHeavySlot(command, context.signal, context.onUpdate);
        if (!backgroundGate.ok) return backgroundGate.response;
        // start() owns the lease from here: released when the task exits or start fails.
        const result = await processManager.start(
          runCommand,
          cwd,
          launch,
          wakeRules,
          spawnEnv,
          backgroundGate.lease ?? undefined,
        );
        const watchWarnings = backgroundWatchWarnings(command);
        const backgroundNotices = joinNotices(backgroundGate.notice, concurrencyLine);
        return (
          `Background process started.\n` +
          `ID: ${result.id}\n` +
          `PID: ${result.pid}\n` +
          `Log: ${result.logFile}\n` +
          (backgroundNotices ? `${backgroundNotices}\n` : "") +
          (wakeRules
            ? result.wakeArmed
              ? `Wake rules armed: ${[
                  wakeRules.pattern ? `pattern /${wakeRules.pattern.source}/` : null,
                  wakeRules.silenceMs
                    ? `silence ${wakeRules.silenceMs / 1000}s${
                        gateSilenceMs !== null ? " (the project's quiet budget for this gate)" : ""
                      }`
                    : null,
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
        quietBudgetSeconds: gateQuietSeconds,
      });
      // Cross-platform shell: bash on macOS/Linux, Git Bash on Windows (or
      // cmd.exe fallback), wrapped by the OS sandbox before any child starts.
      const shell = resolveShell(runCommand, shellOpts);
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
      // Before the input snapshot: a queued run must fingerprint the tree it starts on.
      const foregroundGate = await acquireHeavySlot(command, context.signal, context.onUpdate);
      if (!foregroundGate.ok) return foregroundGate.response;
      const heavyLease = foregroundGate.lease;
      // A hand-off moves the lease to the background task, which releases it on exit.
      let leaseHandedOff = false;
      try {
        const verifyPlan = getVerifyPlan?.() ?? null;
        const classification = classifyVerificationCommand(command, {
          posixShell: !shell.isCmdFallback,
          verifyPlan,
        });
        const isLocal = ops === localOperations;
        // Fingerprint check inputs (argv, cwd, env, HEAD, covered files) once
        // before the run; the whole-tree hash doubles as the snapshot below.
        const coverageArgs: CaptureCheckInputsArgs | null =
          checkCoverage && isLocal && (classification.accepted || classification.snapshotEligible)
            ? {
                cwd,
                command,
                shellPath: shell.file,
                env: sandboxAwareEnv(launch.sandboxed, spawnEnv),
                gate: matchVerifyPlanGate(verifyPlan, command),
                signal: context.signal,
              }
            : null;
        const [checkBefore, changedWatch] = await Promise.all([
          coverageArgs ? captureCheckInputs(coverageArgs) : Promise.resolve(null),
          beginChangedFiles(command),
        ]);
        const treeHash = (inputs: CheckInputs | null): Promise<string | null> =>
          inputs?.scope.kind === "tree"
            ? Promise.resolve(inputs.contentHash)
            : captureVerificationSnapshot(cwd);
        const inputsBefore =
          isLocal && classification.snapshotEligible === true
            ? await treeHash(checkBefore)
            : undefined;
        const notices: string[] = [];
        if (foregroundGate.notice) notices.push(foregroundGate.notice);
        if (concurrencyLine) notices.push(concurrencyLine);
        if (checkBefore) {
          const prior = findPriorPass?.(checkBefore.fingerprint);
          if (prior) notices.push(formatPriorPassNotice(prior.record, prior.current));
        }
        if (coverageArgs) {
          const reported = formatProjectReportedPasses(verifyPlan);
          if (reported) notices.push(reported);
        }
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
          env: spawnEnv,
          heavySlot: heavyLease ?? undefined,
        });
        const rendered = withConcurrency(
          withCooldownHint(
            await renderStructuredForegroundResult(execution, false, concurrency?.summary),
            execution,
            install,
            cooldownDays,
          ),
        );
        // A hand-off is still running: its "after" state does not exist yet.
        const handedOff = rendered.details.bashDiagnostics.reason === "backgrounded";
        leaseHandedOff = handedOff;
        if (!handedOff) heavyLease?.release();
        const changedFiles = handedOff
          ? Promise.resolve(changedFilesSkip("handed off before it finished"))
          : finishChangedFiles(changedWatch);
        let checkAfter: CheckInputs | null = null;
        if (coverageArgs && checkBefore && !handedOff) {
          checkAfter = await captureCheckInputs(coverageArgs);
          // Stored only when the inputs did not move during the run.
          if (checkAfter?.fingerprint === checkBefore.fingerprint) {
            rendered.details.bashDiagnostics.checkCoverage = {
              fingerprint: checkAfter.fingerprint,
              scope: checkAfter.scope,
            };
          }
        }
        const backgroundTaskId = rendered.details.bashDiagnostics.backgroundTaskId;
        if (coverageArgs && checkBefore && handedOff && backgroundTaskId) {
          checkCoverage?.trackHandoff(backgroundTaskId, checkBefore, coverageArgs);
        }
        if (inputsBefore !== undefined && !handedOff) {
          const inputsAfter = inputsBefore === null ? null : await treeHash(checkAfter);
          rendered.details.bashDiagnostics.sourceUnchanged =
            inputsBefore !== null && inputsAfter === inputsBefore;
        }
        const changed = await changedFiles;
        rendered.details.bashDiagnostics.changedFiles = changed;
        const changedNote = formatChangedFilesNote(changed, protectedPatternsOf(verifyPlan));
        if (changedNote) notices.push(changedNote);
        const sandboxed = annotateSandboxDenial(rendered.content, launch.sandboxed);
        const result = {
          ...rendered,
          content: notices.length > 0 ? `${sandboxed}\n\n${notices.join("\n")}` : sandboxed,
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
      } finally {
        if (!leaseHandedOff) heavyLease?.release();
      }
    },
  };
}
