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
      if (skill.root) {
        // Children start with an empty context: a brief that says "follow the
        // skill" without its path silently drops the skill's rules.
        parts.push(
          `If you delegate part of this work to a child agent, it cannot see these instructions: put the skill root (${skill.root}), the exact reference files it must read, and the output you need in its brief.`,
        );
      }
      return parts.join("\n");
    },
  };
}

function generateSkillDescription(skills: Skill[], limits: ContextLimits = CONTEXT_LIMITS): string {
  if (skills.length === 0) {
    return "Invoke a skill by name. No skills are currently available.";
  }

  // The active schema owns skill discovery; the system prompt omits its duplicate catalog.
  const { lines, dropped } = renderSkillLines(skills, limits);
  const overflow =
    dropped.length > 0 ? `\n_Skills omitted (catalog byte budget): ${dropped.join(", ")}_` : "";

  return (
    // Replay-tested on gpt-6-astra (Codex head-to-head): the previous "Before
    // acting, invoke a skill…" opener made the model spend a whole turn loading
    // `bulletproof` for a plain rename 6/6 times; this wording, 0/6.
    `Load a skill only for work that clearly needs its specialised method; most bug fixes, renames and refactors need none. ` +
    `Respect explicit exclusions. Match the work rather than the topic, and do not re-invoke a skill already loaded in this conversation.\n\n` +
    `Available skills:\n${lines.join("\n")}${overflow}`
  );
}
