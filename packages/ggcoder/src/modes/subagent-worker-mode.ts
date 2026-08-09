import { createInterface } from "node:readline";
import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";
import { AgentSession } from "../core/agent-session.js";
import { isModelUnavailableError } from "../tools/subagent.js";
import {
  boundSubAgentOutput,
  SUB_AGENT_MAX_TURN_EXTENSIONS,
  SUB_AGENT_TIMEOUT_MS,
} from "../tools/subagent-shared.js";
import { captureSidecarError, flushSidecarErrors } from "../core/sidecar-error-reporter.js";

const TIMEOUT_RECOVERY_GRACE_MS = 60_000;
const TIMEOUT_RECOVERY_PROMPT = `Your execution time limit was reached and the active operation was stopped.
You have one final 60-second recovery turn. Do not call any tools. Immediately return the best concise answer you can from the evidence already in this conversation. Clearly state what remains incomplete or unverified.`;

/** One bounded, tool-free chance to turn the durable transcript into a useful result. */
export async function recoverTimedOutTurn(
  activeSession: Pick<AgentSession, "prompt" | "setSignal">,
  currentOutput: () => string,
  setController: (controller: AbortController) => void,
): Promise<boolean> {
  const recoveryOutputStart = currentOutput().length;
  const recoveryController = new AbortController();
  setController(recoveryController);
  activeSession.setSignal(recoveryController.signal);
  const recoveryTimer = setTimeout(() => recoveryController.abort(), TIMEOUT_RECOVERY_GRACE_MS);
  try {
    await activeSession.prompt(
      TIMEOUT_RECOVERY_PROMPT,
      { source: "runtime", kind: "completion_gate", visibility: "hidden" },
      { disableTools: true },
    );
    return (
      !recoveryController.signal.aborted &&
      currentOutput().slice(recoveryOutputStart).trim().length > 0
    );
  } catch {
    return false;
  } finally {
    clearTimeout(recoveryTimer);
  }
}

export interface SubagentWorkerInitialize {
  provider: Provider;
  model: string;
  fallbackModel?: string;
  cwd: string;
  baseUrl?: string;
  /** Replaces the whole system prompt. */
  systemPrompt?: string;
  /** Agent body composed with the standard prompt scaffolding — the delegation path. */
  agentPrompt?: string;
  /** Whether the composed prompt includes project instruction files. */
  agentContext?: "project" | "none";
  thinkingLevel?: ThinkingLevel;
  allowedTools?: string[];
  /** MCP servers this agent may connect, derived from its `tools:` frontmatter. */
  allowedMcpServers?: string[];
  promptCacheKey?: string;
  sessionRootDir: string;
  childSessionPath?: string;
}

type WorkerCommand =
  | { request_id: string; command: "initialize"; options: SubagentWorkerInitialize }
  | { request_id: string; command: "start"; task: string }
  | { request_id: string; command: "queue_message"; message: string }
  | { request_id: string; command: "followup"; task: string }
  | { request_id: string; command: "interrupt" }
  | { request_id: string; command: "shutdown" };

type WorkerState = "uninitialized" | "idle" | "running" | "interrupted" | "closed";

function emit(frame: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runSubagentWorkerMode(): Promise<void> {
  let session: AgentSession | undefined;
  let initializeOptions: SubagentWorkerInitialize | undefined;
  let state: WorkerState = "uninitialized";
  let controller = new AbortController();
  let activeTurn: Promise<void> | undefined;
  let turnTimer: ReturnType<typeof setTimeout> | undefined;
  let abortReason: "timeout" | "interrupt" | "shutdown" | "stdin_closed" | undefined;
  let output = "";
  let recoveryOutput = "";
  let recoveringAfterTimeout = false;
  let producedToolCall = false;

  const setState = (next: WorkerState, extra: Record<string, unknown> = {}) => {
    state = next;
    emit({ type: "state", state: next, ...extra });
  };

  const wireEvents = (activeSession: AgentSession) => {
    const forwarded = [
      "thinking_delta",
      "tool_call_start",
      "tool_call_update",
      "tool_call_end",
      "turn_end",
      "max_turns",
      "turn_budget_extended",
      "truncated",
      "server_tool_call",
      "server_tool_result",
    ] as const;
    activeSession.eventBus.on("text_delta", (payload) => {
      if (recoveringAfterTimeout) {
        if (recoveryOutput.length < 200_000) recoveryOutput += payload.text;
      } else if (output.length < 200_000) {
        output += payload.text;
      }
      emit({ type: "event", event: "text_delta", payload });
    });
    for (const event of forwarded) {
      activeSession.eventBus.on(event, (payload) => {
        if (event === "tool_call_start") producedToolCall = true;
        emit({ type: "event", event, payload });
      });
    }
  };

  const createSession = async (options: SubagentWorkerInitialize): Promise<AgentSession> => {
    const { fallbackModel: _fallbackModel, childSessionPath, ...sessionOptions } = options;
    const next = new AgentSession({
      ...sessionOptions,
      maxTurns: 50,
      maxTurnExtensions: SUB_AGENT_MAX_TURN_EXTENSIONS,
      transient: false,
      sessionRootDir: options.sessionRootDir,
      sessionId: childSessionPath,
      signal: controller.signal,
      subagentWorker: true,
    });
    wireEvents(next);
    await next.initialize();
    return next;
  };

  const runTurn = (task: string) => {
    if (!session) throw new Error("Worker is not initialized");
    if (state === "running") throw new Error("Worker already has an active turn");
    output = "";
    recoveryOutput = "";
    recoveringAfterTimeout = false;
    producedToolCall = false;
    abortReason = undefined;
    controller = new AbortController();
    session.setSignal(controller.signal);
    setState("running");
    turnTimer = setTimeout(() => {
      abortReason = "timeout";
      controller.abort();
    }, SUB_AGENT_TIMEOUT_MS);
    activeTurn = (async () => {
      try {
        await session!.prompt(task);
      } catch (error) {
        const message = errorMessage(error);
        const fallbackModel = initializeOptions?.fallbackModel;
        if (abortReason === "timeout") {
          // The timed-out turn remains in the durable child transcript. Continue
          // below with one bounded summary turn using that same context.
        } else if (
          fallbackModel &&
          !controller.signal.aborted &&
          !output &&
          !producedToolCall &&
          isModelUnavailableError(message)
        ) {
          await session!.dispose();
          initializeOptions = {
            ...initializeOptions!,
            model: fallbackModel,
            fallbackModel: undefined,
          };
          session = await createSession(initializeOptions);
          await session.prompt(task);
        } else {
          throw error;
        }
      }
      clearTimeout(turnTimer);

      let recoveredAfterTimeout = false;
      if (abortReason === "timeout") {
        recoveringAfterTimeout = true;
        try {
          recoveredAfterTimeout = await recoverTimedOutTurn(
            session!,
            () => recoveryOutput,
            (recoveryController) => {
              controller = recoveryController;
            },
          );
        } finally {
          recoveringAfterTimeout = false;
        }
        if (recoveryOutput.trim()) {
          output += `\n\n[Timeout recovery summary]\n${recoveryOutput}`;
        }
      }

      const interrupted =
        controller.signal.aborted || (abortReason !== undefined && abortReason !== "timeout");
      const timedOut = abortReason === "timeout" && !recoveredAfterTimeout;
      setState(interrupted && !timedOut ? "interrupted" : "idle");
      emit({
        type: "turn_complete",
        status: recoveredAfterTimeout
          ? "completed"
          : timedOut
            ? "failed"
            : interrupted
              ? "interrupted"
              : "completed",
        output: boundSubAgentOutput(output),
        ...(recoveredAfterTimeout
          ? { recovered_after_timeout: true }
          : timedOut
            ? {
                error: `Timed out after ${Math.round(SUB_AGENT_TIMEOUT_MS / 60_000)} minutes; recovery summary failed`,
              }
            : interrupted
              ? { error: "Interrupted" }
              : {}),
        model: initializeOptions?.model,
      });
    })()
      .catch((error: unknown) => {
        clearTimeout(turnTimer);
        const interrupted = controller.signal.aborted;
        const timedOut = abortReason === "timeout";
        if (!interrupted) {
          captureSidecarError(error, "subagent-worker.turn", {
            provider: initializeOptions?.provider ?? "unknown",
            model: initializeOptions?.model ?? "unknown",
          });
        }
        setState(interrupted && !timedOut ? "interrupted" : "idle");
        emit({
          type: "turn_complete",
          status: timedOut ? "failed" : interrupted ? "interrupted" : "failed",
          output: boundSubAgentOutput(output),
          error: timedOut
            ? `Timed out after ${Math.round(SUB_AGENT_TIMEOUT_MS / 60_000)} minutes; recovery summary failed`
            : interrupted
              ? "Interrupted"
              : errorMessage(error),
          model: initializeOptions?.model,
        });
      })
      .finally(() => {
        activeTurn = undefined;
      });
  };

  const acknowledge = (requestId: string, result: Record<string, unknown> = {}) =>
    emit({ type: "ack", request_id: requestId, ok: true, ...result });
  const reject = (requestId: string, error: unknown) =>
    emit({ type: "ack", request_id: requestId, ok: false, error: errorMessage(error) });

  const handle = async (command: WorkerCommand): Promise<void> => {
    try {
      switch (command.command) {
        case "initialize": {
          if (session) throw new Error("Worker is already initialized");
          initializeOptions = command.options;
          session = await createSession(initializeOptions);
          setState("idle");
          const state = session.getState();
          initializeOptions = { ...initializeOptions, childSessionPath: state.sessionPath };
          acknowledge(command.request_id, {
            child_session_id: state.sessionId,
            child_session_path: state.sessionPath,
            model: initializeOptions.model,
          });
          return;
        }
        case "start":
        case "followup":
          if (!session) throw new Error("Worker is not initialized");
          if (state === "running") throw new Error("Worker already has an active turn");
          acknowledge(command.request_id, { status: "running" });
          runTurn(command.task);
          return;
        case "queue_message": {
          if (!session || state !== "running") throw new Error("Worker is not running");
          const queued = session.queueMessage(command.message);
          acknowledge(command.request_id, { queued });
          return;
        }
        case "interrupt":
          if (!session || state !== "running") throw new Error("Worker is not running");
          abortReason = "interrupt";
          controller.abort();
          acknowledge(command.request_id);
          return;
        case "shutdown":
          abortReason = "shutdown";
          controller.abort();
          await activeTurn?.catch(() => undefined);
          await session?.dispose();
          setState("closed");
          acknowledge(command.request_id);
          process.exitCode = 0;
          return;
      }
    } catch (error) {
      captureSidecarError(error, "subagent-worker.command", { command: command.command });
      reject(command.request_id, error);
    }
  };

  const lines = createInterface({ input: process.stdin, terminal: false });
  lines.on("line", (line) => {
    let command: WorkerCommand;
    try {
      command = JSON.parse(line) as WorkerCommand;
      if (!command.request_id || !command.command) throw new Error("Invalid command frame");
    } catch (error) {
      captureSidecarError(error, "subagent-worker.protocol");
      emit({ type: "protocol_error", error: errorMessage(error) });
      return;
    }
    void handle(command);
  });
  await new Promise<void>((resolve) => lines.once("close", resolve));
  abortReason = "stdin_closed";
  controller.abort();
  await activeTurn?.catch(() => undefined);
  await session?.dispose();
  await flushSidecarErrors();
}
