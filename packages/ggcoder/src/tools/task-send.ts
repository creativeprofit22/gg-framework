import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { ProcessManager } from "../core/process-manager.js";
import { checkDestructiveGit } from "../core/destructive-git-guard.js";
import { shellThreatBlockMessage } from "../core/shell-threats.js";

const TaskSendParams = z.object({
  id: z.string(),
  input: z.string().optional(),
  enter: z.boolean().optional().describe("Default true"),
  eof: z.boolean().optional().describe("Close stdin (Ctrl-D)"),
});

export function createTaskSendTool(
  processManager: ProcessManager,
  cwd?: string,
): AgentTool<typeof TaskSendParams> {
  return {
    name: "task_send",
    description: "Type into a background process's stdin.",
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
