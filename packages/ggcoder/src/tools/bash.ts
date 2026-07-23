import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { ProcessManager } from "../core/process-manager.js";
import type { ForegroundExecutionOutcome, ForegroundExecutionReason } from "../types.js";
import type { ProcessTarget } from "../utils/process.js";
import { log } from "../core/logger.js";
import { truncateTail, MAX_BYTES } from "./truncate.js";
import { compressToolOutput } from "./compress.js";
import { writeOverflow } from "./overflow.js";
import { localOperations, type ToolOperations } from "./operations.js";
import { getSafeToolEnv } from "./safe-env.js";
import { resolveShell, type ResolveShellOpts } from "../core/shell.js";
import { PersistentShell } from "../core/persistent-shell.js";
import { isReadOnlyCommand } from "./read-only-bash.js";
import { isPlanModeActive, planModeRestriction } from "../core/runtime-mode.js";
import { isCatastrophicCommand } from "../core/workspace-guard.js";

const DEFAULT_TIMEOUT = 120_000; // 120 seconds
const FOREGROUND_TIMEOUT_CLEANUP_GRACE_MS = 1_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MB — cap buffered output to prevent OOM

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
  isCmdFallback: boolean;
}

interface ForegroundCommandOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  ops: ToolOperations;
  onUpdate?: (output: string, totalBytes: number) => void;
  cleanupProcessTree?: (target: ProcessTarget) => Promise<void>;
  reapProcessWrapper?: (target: ProcessTarget) => void;
}

export function executeForegroundCommand({
  command,
  cwd,
  timeoutMs,
  signal,
  ops,
  onUpdate,
  cleanupProcessTree = ops.process.cleanupProcessTree,
  reapProcessWrapper: reapWrapper = ops.process.reapProcessWrapper,
}: ForegroundCommandOptions): Promise<ForegroundCommandExecution> {
  const shell = resolveShell(command);
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let outputCapped = false;
  let pid: number | null = null;
  let terminalIntent: "interruption" | "completion" | "spawnError" | null = null;
  let pendingInterruption: "timedOut" | "aborted" | null = null;
  let settled = false;
  let deadlineTimer: NodeJS.Timeout | undefined;
  let cleanupGraceTimer: NodeJS.Timeout | undefined;
  let abortListenerRegistered = false;
  let child: ReturnType<ToolOperations["process"]["spawn"]> | null = null;
  let onStdoutData: ((data: Buffer) => void) | undefined;
  let onStderrData: ((data: Buffer) => void) | undefined;
  let flushStdout: (() => void) | undefined;
  let flushStderr: (() => void) | undefined;
  const onOutputPipeError = (): void => {};
  let onChildClose: ((code: number | null, closeSignal: NodeJS.Signals | null) => void) | undefined;
  let onChildError: ((error: Error) => void) | undefined;

  return new Promise((resolve) => {
    const startedAt = Date.now();

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

    const finalize = (
      reason: ForegroundExecutionReason,
      exitCode: number | null,
      closeSignal: NodeJS.Signals | null,
      error: Error | null = null,
    ): void => {
      if (settled) return;
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
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

      resolve({
        outcome: {
          reason,
          exitCode,
          signal: closeSignal,
          startedAt,
          elapsedMs: Math.max(0, Date.now() - startedAt),
          pid,
          error,
        },
        rawOutput: Buffer.concat(chunks).toString("utf-8"),
        outputCapped,
        isCmdFallback: shell.isCmdFallback,
      });
    };

    const interrupt = (reason: "timedOut" | "aborted"): void => {
      if (settled || terminalIntent !== null) return;
      terminalIntent = "interruption";
      pendingInterruption = reason;
      const target = currentTarget();
      if (target) startCleanup(target);
      cleanupGraceTimer = setTimeout(() => {
        finalize(reason, null, null);
      }, FOREGROUND_TIMEOUT_CLEANUP_GRACE_MS);
    };

    const onAbort = (): void => interrupt("aborted");

    try {
      child = ops.process.spawn(shell.file, shell.args, {
        cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: getSafeToolEnv(),
      });
      pid = child.pid ?? null;

      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      const onData =
        (decoder: StringDecoder) =>
        (data: Buffer): void => {
          if (outputCapped) return;
          totalBytes += data.length;
          if (totalBytes > MAX_OUTPUT_BYTES) {
            outputCapped = true;
            return;
          }
          chunks.push(data);
          const output = decoder.write(data);
          if (output) onUpdate?.(output, totalBytes);
        };
      const flushDecoder = (decoder: StringDecoder): (() => void) => {
        let flushed = false;
        return () => {
          if (flushed) return;
          flushed = true;
          const output = decoder.end();
          if (output) onUpdate?.(output, totalBytes);
        };
      };
      // Output pipes can fail independently. Swallow their errors so the child
      // process close/error event remains the sole execution outcome authority.
      onStdoutData = onData(stdoutDecoder);
      onStderrData = onData(stderrDecoder);
      flushStdout = flushDecoder(stdoutDecoder);
      flushStderr = flushDecoder(stderrDecoder);
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

      deadlineTimer = setTimeout(() => interrupt("timedOut"), timeoutMs);

      signal.addEventListener("abort", onAbort, { once: true });
      abortListenerRegistered = true;
      if (signal.aborted) onAbort();
    } catch (error) {
      finalize("spawnError", null, null, error instanceof Error ? error : new Error(String(error)));
    }
  });
}

const BashParams = z.object({
  command: z.string().describe("The bash command to execute"),
  timeout: z
    .number()
    .int()
    .min(1000)
    .optional()
    .describe("Timeout in milliseconds (default: 120000)"),
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      "Run the command in the background. Returns a process ID immediately. " +
        "Use task_output to read output and task_stop to stop it.",
    ),
  persist: z
    .boolean()
    .optional()
    .describe(
      "Run in the persistent session shell: cd, exported env vars, and shell state " +
        "survive across persist:true calls. Use for multi-step workflows in another " +
        "directory or with sourced environments. Default false (fresh shell per call).",
    ),
});

export function createBashTool(
  cwd: string,
  processManager: ProcessManager,
  ops: ToolOperations = localOperations,
  planModeRef?: { current: boolean },
  shellOpts?: ResolveShellOpts,
): AgentTool<typeof BashParams> {
  // Lazily created on the first persist:true call; one session per tool
  // instance (i.e. per agent session), killed when the process exits.
  let sessionShell: PersistentShell | null = null;
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
      "Long output is truncated (tail kept). " +
      "Set run_in_background=true for long-running OR interactive processes " +
      "(dev servers, watchers, REPLs, scaffolders, programs that prompt for input). " +
      "Use task_output to read output, task_send to type input/answer prompts, and " +
      "task_stop to stop background processes."
    : "Execute a bash command. The shell's working directory is already set to the project root — " +
      "don't cd into it redundantly. Use cd only when you need a different directory. " +
      "Returns exit code and combined stdout/stderr. " +
      "Commands run in a non-interactive bash shell with TERM=dumb. " +
      "Long output is truncated (tail kept). " +
      "Set run_in_background=true for long-running OR interactive processes " +
      "(dev servers, watchers, REPLs, scaffolders, programs that prompt for input). " +
      "Use task_output to read output, task_send to type input/answer prompts, and " +
      "task_stop to stop background processes. " +
      "Set persist=true to run in a session shell where cd/env state survives across " +
      "persist:true calls.";
  return {
    name: "bash",
    description,
    parameters: BashParams,
    executionMode: "sequential",
    async execute({ command, timeout: timeoutMs, run_in_background, persist }, context) {
      if (isPlanModeActive(planModeRef) && !isReadOnlyCommand(command)) {
        return planModeRestriction("bash");
      }
      // Catastrophic-command guard — enforced in code, before every execution
      // path (persistent shell, background, and normal spawn).
      const catastrophic = isCatastrophicCommand(command, cwd);
      if (catastrophic) {
        return `Error: ${catastrophic}`;
      }
      // Persistent session mode — POSIX only; Windows-without-bash falls through
      // to the normal spawn path (cmd.exe fallback) below.
      if (persist && !run_in_background && !resolveShell(command).isCmdFallback) {
        sessionShell ??= new PersistentShell(cwd, getSafeToolEnv(), MAX_OUTPUT_BYTES, ops.process);
        const res = await sessionShell.run(
          command,
          timeoutMs ?? DEFAULT_TIMEOUT,
          context.signal,
          context.onUpdate
            ? (text) => context.onUpdate?.({ type: "bash_progress", output: text, totalBytes: 0 })
            : undefined,
        );
        const output = await renderBashOutput(res.output);
        const exitCode =
          res.exitCode === "TIMEOUT"
            ? `TIMEOUT (${timeoutMs ?? DEFAULT_TIMEOUT}ms) — session shell was reset; cd/env state is gone`
            : res.exitCode === "ABORTED"
              ? "ABORTED"
              : String(res.exitCode);
        return `Exit code: ${exitCode}\n${output}`;
      }
      if (run_in_background) {
        const result = await processManager.start(command, cwd);
        return (
          `Background process started.\n` +
          `ID: ${result.id}\n` +
          `PID: ${result.pid}\n` +
          `Log: ${result.logFile}\n` +
          `Use task_output with id="${result.id}" to read output, ` +
          `task_send to type input/answer prompts, task_stop to stop it.`
        );
      }

      const effectiveTimeout = timeoutMs ?? DEFAULT_TIMEOUT;
      const execution = await executeForegroundCommand({
        command,
        cwd,
        timeoutMs: effectiveTimeout,
        signal: context.signal,
        ops,
        onUpdate: context.onUpdate
          ? (output, totalBytes) =>
              context.onUpdate?.({ type: "bash_progress", output, totalBytes })
          : undefined,
      });
      const { outcome } = execution;

      if (outcome.reason === "spawnError") {
        return `Exit code: 1\nFailed to spawn: ${outcome.error?.message ?? "Unknown error"}`;
      }

      let output = await renderBashOutput(execution.rawOutput);
      if (execution.outputCapped) {
        output =
          `[Output capped at ${MAX_OUTPUT_BYTES / 1024 / 1024} MB to prevent memory exhaustion]\n` +
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

      const exitCode =
        outcome.reason === "completed"
          ? "0"
          : outcome.reason === "timedOut"
            ? `TIMEOUT (${effectiveTimeout}ms)`
            : outcome.reason === "aborted"
              ? "ABORTED"
              : outcome.exitCode !== null
                ? String(outcome.exitCode)
                : outcome.signal
                  ? `SIGNAL (${outcome.signal})`
                  : "FAILED (no exit code)";

      return `Exit code: ${exitCode}\n${output}`;
    },
  };
}
