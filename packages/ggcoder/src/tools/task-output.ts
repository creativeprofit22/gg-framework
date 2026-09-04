import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { MAX_PROCESS_WAIT_MS, type ProcessManager } from "../core/process-manager.js";
import { truncateTail } from "./truncate.js";
import { compressToolOutput } from "./compress.js";

const TaskOutputParams = z.object({
  id: z.string().describe("The background process ID"),
  from_start: z
    .boolean()
    .optional()
    .describe("If true, read output from the beginning instead of incrementally"),
  wait_ms: z
    .number()
    .int()
    .min(1000)
    .max(MAX_PROCESS_WAIT_MS)
    .optional()
    .describe(
      `Block until the process exits, up to this many ms (max ${MAX_PROCESS_WAIT_MS}), then ` +
        "read. Returns the moment it finishes — use this instead of sleeping for a " +
        "guessed duration when you have nothing else to do until it is done.",
    ),
});

export interface TaskOutputDetails {
  isRunning: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  completedAt: number | null;
  startOffset: number;
  endOffset: number;
  skippedBytes: number;
  remainingBytes: number;
  logFile: string | null;
  presentationCapped: boolean;
}

export interface TaskOutputToolResultDetails {
  taskOutput: TaskOutputDetails;
}

export function createTaskOutputTool(
  processManager: ProcessManager,
): AgentTool<typeof TaskOutputParams> {
  return {
    name: "task_output",
    description:
      "Read output from a background process. Returns new output since last read by default. " +
      "Use from_start=true to read from the beginning. Progress and exit status arrive " +
      "automatically for background processes \u2014 call this when you need the full output, " +
      "not merely to check whether something finished. Set wait_ms to block until the " +
      "process exits rather than sleeping for a guessed duration (wait_agent is for child " +
      "agents, not background processes).",
    parameters: TaskOutputParams,
    executionMode: "sequential",
    // Waiting can exceed the default per-tool ceiling but remains process-bounded.
    timeoutMs: MAX_PROCESS_WAIT_MS + 30_000,
    async execute({ id, from_start, wait_ms }, context) {
      let waitNotice = "";
      if (wait_ms !== undefined) {
        const reason = await processManager.waitForExit(id, wait_ms, context?.signal);
        if (reason === "timeout") {
          waitNotice = ` — still running after waiting ${Math.round(wait_ms / 1000)}s`;
        }
      }
      const result = await processManager.readOutput(id, from_start);

      const terminalDetails = [
        result.exitCode !== null ? `code ${result.exitCode}` : null,
        result.signal ? `signal ${result.signal}` : null,
        result.completedAt !== null
          ? `completed ${new Date(result.completedAt).toISOString()}`
          : null,
      ].filter((detail): detail is string => detail !== null);
      const status =
        (result.isRunning
          ? "running"
          : `exited (${terminalDetails.length > 0 ? terminalDetails.join(", ") : "status unavailable"})`) +
        waitNotice;
      const retainedLogReference = result.logFile ? ` Retained log: ${result.logFile}` : "";
      const rangeNotices = [
        result.skippedBytes > 0
          ? `[${result.skippedBytes} earlier bytes skipped.${retainedLogReference}]`
          : null,
        result.remainingBytes > 0
          ? `[${result.remainingBytes} bytes remain unread. Invoke task_output again with id="${id}" to read the next page.${retainedLogReference}]`
          : null,
      ].filter((notice): notice is string => notice !== null);

      let output = result.output;
      let presentationCapped = false;
      if (output) {
        const truncated = truncateTail(output);
        presentationCapped = truncated.truncated;
        if (presentationCapped) {
          const fullOutputNotice = result.logFile ? ` Full output: ${result.logFile}` : "";
          const c = compressToolOutput(output);
          output = `[${c.notice}${fullOutputNotice}]\n${c.content}`;
        } else {
          output = truncated.content;
        }
      } else {
        output = "(no new output)";
      }

      const notices = rangeNotices.length > 0 ? `${rangeNotices.join("\n")}\n` : "";
      const content = `Process ${id}: ${status}\n${notices}${output}`;
      const taskOutput: TaskOutputDetails = {
        isRunning: result.isRunning,
        exitCode: result.exitCode,
        signal: result.signal,
        completedAt: result.completedAt,
        startOffset: result.startOffset,
        endOffset: result.endOffset,
        skippedBytes: result.skippedBytes,
        remainingBytes: result.remainingBytes,
        logFile: result.logFile,
        presentationCapped,
      };
      return { content, details: { taskOutput } satisfies TaskOutputToolResultDetails };
    },
  };
}
