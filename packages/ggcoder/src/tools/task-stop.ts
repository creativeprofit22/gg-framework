import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { ProcessManager } from "../core/process-manager.js";

const TaskStopParams = z.object({
  id: z.string().describe("The background process ID to stop"),
});

export function createTaskStopTool(
  processManager: ProcessManager,
): AgentTool<typeof TaskStopParams> {
  return {
    name: "task_stop",
    description:
      "Stop a background process tree by ID. On POSIX, sends SIGTERM, waits 500ms, then hard-kills survivors; on Windows, force-terminates the PID tree immediately.",
    parameters: TaskStopParams,
    async execute({ id }) {
      return processManager.stop(id);
    },
  };
}
