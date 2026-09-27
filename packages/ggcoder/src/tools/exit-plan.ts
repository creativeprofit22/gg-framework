import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { resolvePath } from "./path-utils.js";
import { extractPlanSteps } from "../utils/plan-steps.js";
import { checkPlanCitations, type ResearchSourceLedger } from "../core/research-sources.js";

const ExitPlanParams = z.object({
  plan_path: z.string().describe("Path to the plan markdown file; must be under .gg/plans/"),
});

export function createExitPlanTool(
  cwd: string,
  onExitPlan: (planPath: string, content: string) => Promise<string>,
  researchSources?: ResearchSourceLedger,
): AgentTool<typeof ExitPlanParams> {
  return {
    name: "exit_plan",
    description:
      "Submit a .gg/plans/ markdown plan for user review and leave the active research phase. " +
      "The user can approve it for implementation, reject it with feedback, or dismiss the review.",
    parameters: ExitPlanParams,
    executionMode: "sequential",
    // Every rejection throws so the agent loop marks the result `isError`
    // (keeping the full message for the model). Returning the text instead
    // made the desktop row read "Submitted plan" when no review was opened.
    async execute({ plan_path }) {
      const resolved = resolvePath(cwd, plan_path);
      const plansDir = path.join(cwd, ".gg", "plans");
      const relative = path.relative(plansDir, resolved);

      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`Error: plan_path must be under .gg/plans/. Got: ${plan_path}`);
      }

      let content: string;
      try {
        content = await fs.readFile(resolved, "utf-8");
      } catch {
        throw new Error(`Error: Could not read plan file at ${plan_path}. Make sure it exists.`);
      }
      if (!content.trim()) {
        throw new Error("Error: Plan file is empty. Write your plan before calling exit_plan.");
      }

      // Fail closed: a plan without extractable steps silently loses the
      // [DONE:n] progress contract after approval — reject with the exact
      // remediation so the model can self-repair in the same run (plan mode
      // allows writing under .gg/plans/).
      if (extractPlanSteps(content).length === 0) {
        throw new Error(
          "Plan rejected: no '## Steps' section with numbered steps found. " +
            "Append a literal '## Steps' heading followed by a flat numbered list " +
            "(1., 2., …) of concrete implementation steps, then call exit_plan again.",
        );
      }

      // Fail closed: corpus research that shaped the plan must be cited (or
      // explicitly declared unused) before the user reviews it.
      if (researchSources) {
        const citations = checkPlanCitations(content, researchSources);
        if (!citations.ok) throw new Error(citations.message);
      }

      // Carry the exact validated snapshot across the callback boundary; the path
      // may be edited or removed before a review checkpoint is persisted.
      const submitted = await onExitPlan(resolved, content);
      researchSources?.clear();
      return submitted;
    },
  };
}
