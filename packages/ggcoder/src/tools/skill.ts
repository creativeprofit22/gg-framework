import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { CONTEXT_LIMITS, type ContextLimits } from "../core/context-limits.js";
import { renderSkillLines, type Skill } from "../core/skills.js";

const parameters = z.object({
  skill: z.string().describe("The name of the skill to invoke"),
  args: z.string().optional().describe("Optional arguments or context for the skill"),
});

export function createSkillTool(
  skills: Skill[],
  limits: ContextLimits = CONTEXT_LIMITS,
): AgentTool<typeof parameters> {
  // Case-insensitive: discovery dedupes lowercase names, so `Foo` can be
  // listed while a literal lookup of `foo` (or vice versa) would miss.
  const skillMap = new Map(skills.map((s) => [s.name.toLowerCase(), s]));

  return {
    name: "skill",
    description: generateSkillDescription(skills, limits),
    parameters,
    async execute(input) {
      const skill = skillMap.get(input.skill.toLowerCase());
      if (!skill) {
        const available = skills.map((s) => s.name).join(", ");
        return `Error: Skill "${input.skill}" not found. Available skills: ${available || "none"}`;
      }

      const parts = [`<skill_content name="${skill.name}">`];
      if (skill.root) parts.push(`Skill root directory: ${skill.root}`);
      parts.push(skill.content, `</skill_content>`);
      if (input.args) {
        parts.push(`\nUser context: ${input.args}`);
      }
      parts.push(
        "\nTreat the above skill instructions as authoritative within their stated scope. Preserve higher-priority project and file/module rules while following the skill to complete the task.",
      );
      return parts.join("\n");
    },
  };
}

function generateSkillDescription(skills: Skill[], limits: ContextLimits = CONTEXT_LIMITS): string {
  if (skills.length === 0) {
    return "Invoke a skill by name. No skills are currently available.";
  }

  // Same byte budgets as the prompt's Skills section — this description ships
  // in the tool schema on every request, so a bloated skill list bills twice.
  const { lines, dropped } = renderSkillLines(skills, limits);
  const overflow =
    dropped.length > 0 ? `\n_Skills omitted (catalog byte budget): ${dropped.join(", ")}_` : "";

  return (
    `Invoke a skill by name to get specialized instructions for a task. ` +
    `Before acting, invoke a skill when the request matches its scope and respect explicit exclusions. ` +
    `Invoke as soon as the work enters a skill's scope — while building or when checking — not only for reviews. ` +
    `Match the work rather than the topic, skip it for routine or narrow changes, and do not re-invoke a skill already loaded in this conversation.\n\n` +
    `Available skills:\n${lines.join("\n")}${overflow}`
  );
}
