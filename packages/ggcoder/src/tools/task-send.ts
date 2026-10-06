import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { ProcessManager } from "../core/process-manager.js";
import { checkDestructiveGit } from "../core/destructive-git-guard.js";
import { shellThreatBlockMessage } from "../core/shell-threats.js";

const TaskSendParams = z.object({
  id: z.string().describe("The background process ID to send input to"),
  input: z
    .string()
    .optional()
    .describe("Text to type into the process's stdin (e.g. an answer to a prompt or a REPL line)"),
  enter: z
    .boolean()
    .optional()
    .describe(
      "Append a newline (press Enter) after the input. Defaults to true when input is supplied; set true without input to press Enter only.",
    ),
  eof: z
    .boolean()
    .optional()
    .describe("Close stdin after any text/newline, signalling end-of-input (Ctrl-D)."),
});

export function createTaskSendTool(
  processManager: ProcessManager,
  cwd?: string,
): AgentTool<typeof TaskSendParams> {
  return {
    name: "task_send",
    description:
      "Send text, press Enter, or close stdin for a running background process (started with " +
      "run_in_background). Text is followed by Enter by default. Use enter=true without input " +
      "for a newline only, or eof=true without input to close stdin without a newline. After " +
      "sending, call task_output to read the process's response.",
    parameters: TaskSendParams,
    executionMode: "sequential",
    async execute({ id, input, enter, eof }) {
      const sendsEnter = enter ?? input !== undefined;
      if ((input === undefined || input === "") && !sendsEnter && !eof) {
        return "Nothing to send: provide text, set enter=true to press Enter, or set eof=true to close stdin.";
      }
      // Input typed into a background shell is a shell command too. Background
      // processes start in the tool cwd; a later `cd` inside them is not seen.
      if (cwd !== undefined && input) {
        const gitBlocked = await checkDestructiveGit(input, { cwd });
        if (gitBlocked) return `Error: input not sent. ${gitBlocked}`;
      }
      if (input) {
        const threatBlocked = shellThreatBlockMessage(input);
        if (threatBlocked) return `Error: input not sent. ${threatBlocked}`;
      }
      return processManager.sendInput(id, input, { enter, eof });
    },
  };
}
