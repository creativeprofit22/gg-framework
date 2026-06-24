import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { ProcessManager } from "../core/process-manager.js";
import { truncateTail } from "./truncate.js";
import { compressToolOutput } from "./compress.js";
import { writeOverflow } from "./overflow.js";

const TaskOutputParams = z.object({
  id: z.string().describe("The background process ID"),
  from_start: z
    .boolean()
    .optional()
    .describe("If true, read output from the beginning instead of incrementally"),
});

export function createTaskOutputTool(
  processManager: ProcessManager,
): AgentTool<typeof TaskOutputParams> {
  return {
    name: "task_output",
    description:
      "Read output from a background process. Returns new output since last read by default. " +
      "Use from_start=true to read from the beginning.",
    parameters: TaskOutputParams,
    async execute({ id, from_start }) {
      const result = await processManager.readOutput(id, from_start);

      const status = result.isRunning ? "running" : `exited (code ${result.exitCode})`;

      let output = result.output;
      if (output) {
        const truncated = truncateTail(output);
        if (truncated.truncated) {
          // Over-limit: compress (keeps errors + head/tail) rather than a blind
          // tail slice; overflow file preserves the full original.
          const overflowPath = await writeOverflow(output, "task-output").catch(() => null);
          const overflowNotice = overflowPath ? ` Full output: ${overflowPath}` : "";
          const c = compressToolOutput(output);
          output = `[${c.notice}${overflowNotice}]\n${c.content}`;
        } else {
          output = truncated.content;
        }
      } else {
        output = "(no new output)";
      }

      return `Process ${id}: ${status}\n${output}`;
    },
  };
}
