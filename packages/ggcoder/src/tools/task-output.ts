import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import {
  MAX_PROCESS_WAIT_MS,
  describeStopReason,
  type BackgroundStopReason,
  type ProcessManager,
} from "../core/process-manager.js";
import { truncateTail, describeCompressed } from "./truncate.js";
import { compressToolOutput } from "./compress.js";

const TaskOutputParams = z.object({
  id: z.string(),
  from_start: z.boolean().optional(),
  wait_ms: z
    .number()
    .int()
    .min(1000)
    .max(MAX_PROCESS_WAIT_MS)
    .optional()
    .describe(`Block until exit or a wake fires (max ${MAX_PROCESS_WAIT_MS})`),
});

export interface TaskOutputDetails {
  /** Background task ID that was read (matches bash `backgroundTaskId`). */
  id: string;
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
  /** Set when the manager stopped a handed-off command automatically. */
  stopReason: BackgroundStopReason | null;
}

export interface TaskOutputToolResultDetails {
  taskOutput: TaskOutputDetails;
}

export function createTaskOutputTool(
  processManager: ProcessManager,
): AgentTool<typeof TaskOutputParams> {
  return {
    name: "task_output",
    description: "Read a background process's new output (a wake match is not success).",
    parameters: TaskOutputParams,
    executionMode: "sequential",
    // Waiting can exceed the default per-tool ceiling but remains process-bounded.
    timeoutMs: MAX_PROCESS_WAIT_MS + 30_000,
    async execute({ id, from_start, wait_ms }, context) {
      let waitNotice = "";
      if (wait_ms !== undefined) {
        const { reason, detail } = await processManager.waitForActivity(
          id,
          wait_ms,
          context?.signal,
        );
        if (reason === "timeout") {
          waitNotice = ` — still running after waiting ${Math.round(wait_ms / 1000)}s`;
        } else if (reason === "pattern") {
          waitNotice = " — wake pattern matched; inspect output before declaring success";
        } else if (reason === "silence") {
          waitNotice = " — silence wake fired; process may be stalled, not necessarily ready";
        } else if (reason === "failure") {
          waitNotice =
            " — stopped waiting: the output shows a failure while it is still running; " +
            "read it and act now rather than waiting for the exit";
        } else if (reason === "other") {
          waitNotice =
            " — stopped waiting early because other background work needs attention" +
            (detail ? `: ${detail}` : "");
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
          : `exited (${terminalDetails.length > 0 ? terminalDetails.join(", ") : "status unavailable"})` +
            (result.stopReason ? ` — ${describeStopReason(result.stopReason)}` : "")) + waitNotice;
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
          const what = describeCompressed(output, c.content);
          output = `[${c.notice}${what ? ` ${what}` : ""}${fullOutputNotice}]\n${c.content}`;
        } else {
          output = truncated.content;
        }
      } else {
        output = "(no new output)";
      }

      const notices = rangeNotices.length > 0 ? `${rangeNotices.join("\n")}\n` : "";
      const content = `Process ${id}: ${status}\n${notices}${output}`;
      const taskOutput: TaskOutputDetails = {
        id,
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
        stopReason: result.stopReason,
      };
      return { content, details: { taskOutput } satisfies TaskOutputToolResultDetails };
    },
  };
}
