import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";

const EnterPlanParams = z.object({
  reason: z
    .string()
    .optional()
    .describe("Why you are entering plan mode, e.g. a complex multi-file task"),
});

export function createEnterPlanTool(
  onEnterPlan: (reason?: string) => void | Promise<void>,
): AgentTool<typeof EnterPlanParams> {
  return {
    name: "enter_plan",
    description:
      "Enter plan mode for safe, read-only exploration before making changes. " +
      "Use this when a complex or risky task benefits from research and an explicit plan. " +
      "In plan mode, bash, edit, subagent, and normal writes are restricted; write is only allowed under .gg/plans/.",
    parameters: EnterPlanParams,
    executionMode: "sequential",
    async execute({ reason }) {
      await onEnterPlan(reason);
      return (
        "Plan mode activated. You are now in read-only research mode.\n\n" +
        "Allowed actions:\n" +
        "- Use read, grep, find, ls, source_path, web_fetch/web_search, steroids (corpus), and code search tools to investigate\n" +
        "- Write the implementation plan to .gg/plans/<name>.md\n" +
        "- Cite external code that informed the plan in a '## Sources' section, using the commit permalink `url` from steroids search/define results. exit_plan rejects plans that omit corpus code retrieved this session unless the plan states 'Sources: none' with a reason.\n\n" +
        "Restricted: bash, edit, write outside .gg/plans/, subagent, and task mutation.\n\n" +
        "When the plan is ready, call exit_plan with the plan file path."
      );
    },
  };
}
