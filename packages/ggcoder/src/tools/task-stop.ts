import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { ProcessManager } from "../core/process-manager.js";

const TaskStopParams = z.object({
  id: z.string(),
});

export function createTaskStopTool(
  processManager: ProcessManager,
): AgentTool<typeof TaskStopParams> {
  return {
    name: "task_stop",
    description: "Stop a background process (stdin EOF first, then process-tree kill).",
    parameters: TaskStopParams,
    executionMode: "sequential",
    async execute({ id }) {
      return processManager.stop(id);
    },
  };
}
