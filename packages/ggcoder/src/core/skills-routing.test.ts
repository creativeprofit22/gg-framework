import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverSkills, formatSkillsForPrompt, type Skill } from "./skills.js";
import { createSkillTool } from "../tools/skill.js";

const skill: Skill = {
  name: "evidence-led-ui",
  description: "Use for UI work. Exclude backend-only tasks.",
  content: "Inspect before inventing.",
  source: "global",
  root: "/skills/evidence-led-ui",
};

describe("skill routing prompts", () => {
  it("requires matching skills before decisions or edits", () => {
    const prompt = formatSkillsForPrompt([skill]);

    expect(prompt).toContain("compare the user's request with every skill description");
    expect(prompt).toContain("before making decisions or edits");
    expect(prompt).toContain("Respect explicit exclusions");
    expect(prompt).toContain("do not override project or file/module rules");
    expect(prompt).toContain("evidence-led-ui");
  });

  it("places the same routing rule in the skill tool description", () => {
    const tool = createSkillTool([skill]);

    expect(tool.description).toContain("Before acting");
    expect(tool.description).toContain("matches its scope");
    expect(tool.description).toContain("respect explicit exclusions");
  });

  it("keeps loaded skill instructions below project and file/module rules", async () => {
    const tool = createSkillTool([skill]);
    const result = await tool.execute(
      { skill: skill.name },
      { signal: new AbortController().signal, toolCallId: "test" },
    );

    expect(result).toContain("Skill root directory: /skills/evidence-led-ui");
    expect(result).toContain("authoritative within their stated scope");
    expect(result).toContain("Preserve higher-priority project and file/module rules");
  });

  it("discovers evidence-led-ui for a fresh user from bundled assets", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bundled-skills-"));
    try {
      const skills = await discoverSkills({ globalSkillsDir: path.join(root, "global") });
      const evidenceSkill = skills.find((candidate) => candidate.name === "evidence-led-ui");

      expect(evidenceSkill?.source).toBe("bundled");
      // `root` is a real filesystem path and uses the platform separator, so
      // build the expected fragment the same way instead of hardcoding "/".
      expect(evidenceSkill?.root).toContain(path.join("assets", "skills", "evidence-led-ui"));
      expect(evidenceSkill?.content).toContain("# Evidence-Led UI");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("lets project skills override global and bundled definitions by name", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-precedence-"));
    const globalSkillsDir = path.join(root, "global");
    const projectDir = path.join(root, "project");
    const projectSkillsDir = path.join(projectDir, ".gg", "skills");
    try {
      await fs.mkdir(globalSkillsDir, { recursive: true });
      await fs.mkdir(projectSkillsDir, { recursive: true });
      await fs.writeFile(
        path.join(globalSkillsDir, "evidence.md"),
        "---\nname: evidence-led-ui\ndescription: global\n---\nGlobal guidance.",
      );
      await fs.writeFile(
        path.join(projectSkillsDir, "evidence.md"),
        "---\nname: evidence-led-ui\ndescription: project\n---\nProject guidance.",
      );

      const skills = await discoverSkills({ globalSkillsDir, projectDir });
      const matching = skills.filter((candidate) => candidate.name === "evidence-led-ui");

      expect(matching).toHaveLength(1);
      expect(matching[0]?.source).toBe("project");
      expect(matching[0]?.content).toBe("Project guidance.");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
