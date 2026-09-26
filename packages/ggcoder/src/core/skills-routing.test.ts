import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverSkills, formatSkillsForPrompt, type Skill } from "./skills.js";
import { createSkillTool } from "../tools/skill.js";
import { resolveContextLimits } from "./context-limits.js";

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

  it("counterbalances invocation pressure in both routing surfaces", () => {
    // Every pro-invocation instruction needs a brake, or topic overlap alone
    // pulls a skill in and burns context on work it would not change. The
    // brake lives here rather than in each skill's description, so it also
    // covers third-party skills written to maximize their own invocation.
    const prompt = formatSkillsForPrompt([skill]);
    expect(prompt).toContain("Match the work, not the topic");
    expect(prompt).toContain("Skip the skill when the task is routine");
    expect(prompt).toContain("Invoke at most one skill");
    expect(prompt).toContain("do not re-invoke a skill");

    const tool = createSkillTool([skill]);
    expect(tool.description).toContain("Match the work rather than the topic");
    expect(tool.description).toContain("skip it for routine or narrow changes");
    expect(tool.description).toContain("do not re-invoke a skill already loaded");
  });

  it("gives every bundled skill an explicit exclusion clause", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bundled-skills-"));
    try {
      const skills = await discoverSkills({ globalSkillsDir: path.join(root, "global") });
      const bundled = skills.filter((candidate) => candidate.source === "bundled");
      expect(bundled.length).toBeGreaterThan(0);

      for (const candidate of bundled) {
        // A description that only says when to fire has no off switch, and the
        // model resolves ambiguity by invoking.
        expect(candidate.description, `${candidate.name} lacks an exclusion`).toMatch(
          /Do NOT use|Exclude|excluding/i,
        );
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
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

  it("discovers compliance-guard for a fresh user from bundled assets", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bundled-skills-"));
    try {
      const skills = await discoverSkills({ globalSkillsDir: path.join(root, "global") });
      const complianceSkill = skills.find((candidate) => candidate.name === "compliance-guard");

      expect(complianceSkill?.source).toBe("bundled");
      expect(complianceSkill?.root).toContain(path.join("assets", "skills", "compliance-guard"));
      expect(complianceSkill?.content).toContain("# Compliance Guard");
      // The skill must never present itself as legal advice or certification.
      expect(complianceSkill?.content).toContain("Never certify");

      // A beginner will half-answer or ignore the intake questions, so the
      // defaults ARE the analysis. Promising defaults without stating them
      // lets the model invent a quieter reading than the user deserves.
      expect(complianceSkill?.content).toContain("Default if unanswered");
      expect(complianceSkill?.content).toContain("the cautious reading");
      // Findings a novice cannot act on produce no fixes.
      expect(complianceSkill?.content).toContain("never read a statute");
      // Reading code shows intent; running it shows what ships. A review that
      // asserts from grep alone misses runtime-injected tags entirely, and a
      // fix reported without verification is worse than the original finding.
      // Two-state "observed/inferred" was read as visible-in-code vs deduced,
      // not ran vs read, so a static review reported itself as verified.
      expect(complianceSkill?.content).toContain("RUNTIME");
      expect(complianceSkill?.content).toContain("DEDUCED");
      expect(complianceSkill?.content).toContain("Never relabel upward");
      expect(complianceSkill?.content).toContain("Never report a fix you did not verify");
      // Narrative review silently drops the boring blockers; the sweep is what
      // turns "did I notice it" into "did I check it".
      expect(complianceSkill?.content).toContain("coverage ledger");
      // An item never written down is an item never checked: evaluation showed
      // blockers 1 and 2 dropped while dramatic findings were reported.
      expect(complianceSkill?.content).toContain("one row per numbered item");
      // Audience and product claims live in prose, not in the schema.
      expect(complianceSkill?.content).toContain("Read the prose, not only the code");
      // Held-out evaluation: the code sweep reliably missed obligations that
      // arise from the product model or from two facts combined, and it
      // downgraded unlicensed-activity gates to BLOCKER.
      expect(complianceSkill?.content).toContain("second pass on the product model");
      expect(complianceSkill?.content).toContain("Severity rule for licensed activities");
      // Held-out evaluation: the review named the first instantiation of a duty
      // it thought of (DMCA, auto-renewal) and never reached the EU equivalent
      // (DSA, withdrawal rights) for an EU-established company.
      expect(complianceSkill?.content).toContain("Name every jurisdiction's version");
      // Mandatory coverage lived only in the ledger, so a findings-only output
      // format silently dropped it. Coverage must belong to the findings.
      expect(complianceSkill?.content).toContain("coverage survives the output format");
      // A prohibition reported as a disclosure duty authorises the banned
      // feature; and leading with the wrong jurisdiction sends the user to the
      // wrong kind of lawyer. Both were observed in evaluation runs.
      expect(complianceSkill?.content).toContain("Check for an outright ban");
      expect(complianceSkill?.content).toContain("Lead with the jurisdiction");
      // A point-in-time register rots; a failing test does not.
      expect(complianceSkill?.content).toContain("leave the check behind");

      // Every referenced file must exist, since the skill routes the model to them by path.
      const referenced = [...complianceSkill!.content.matchAll(/`(references\/[\w.-]+\.md)`/g)].map(
        (match) => match[1]!,
      );
      expect(referenced.length).toBeGreaterThan(0);
      const skillRoot = complianceSkill?.root ?? "";
      for (const relative of new Set(referenced)) {
        await expect(
          fs.access(path.join(skillRoot, ...relative.split("/"))),
        ).resolves.toBeUndefined();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("discovers bulletproof for a fresh user from bundled assets", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bundled-skills-"));
    try {
      const skills = await discoverSkills({ globalSkillsDir: path.join(root, "global") });
      const bulletproof = skills.find((candidate) => candidate.name === "bulletproof");

      expect(bulletproof?.source).toBe("bundled");
      expect(bulletproof?.root).toContain(path.join("assets", "skills", "bulletproof"));
      expect(bulletproof?.content).toContain("# Bulletproof");

      // Security work is worthless if the model declares victory: absence of
      // findings is not evidence of safety, and users read "hardened" as a
      // guarantee.
      expect(bulletproof?.content).toContain("Never certify");

      // The skill ships defensive guidance. A model that writes exploits to
      // "prove" a finding has produced attack tooling on the user's machine.
      expect(bulletproof?.content).toContain("Defensive output only");
      expect(bulletproof?.content).toContain("Hard stops");

      // Most users never ask for a security review, so the value is in the
      // inline path writing the safe version during normal feature work.
      expect(bulletproof?.content).toContain("Inline gate");
      expect(bulletproof?.content).toContain("Write the safe version the first time");

      // A grep-driven checklist produces noise; reachability is what separates
      // a finding from a pattern match.
      expect(bulletproof?.content).toContain("Reachability decides everything");

      // The intake must work for someone who cannot answer security questions.
      expect(bulletproof?.content).toContain("Default if unanswered");

      // Claiming a fix was verified when it was only read is the failure mode
      // that makes a security report actively harmful.
      expect(bulletproof?.content).toContain("RUNTIME");
      expect(bulletproof?.content).toContain("DEDUCED");

      // Silent scope gaps read as full coverage.
      expect(bulletproof?.content).toContain("what was not checked");

      // Threat data decays faster than anything else in the bundle; the model
      // must not assert a stale CVE or version as current.
      expect(bulletproof?.content).toContain("Date-check before asserting");

      // Every referenced file must exist, since the skill routes the model to them by path.
      const referenced = [...bulletproof!.content.matchAll(/`(references\/[\w.-]+\.md)`/g)].map(
        (match) => match[1]!,
      );
      expect(referenced.length).toBeGreaterThan(0);
      const skillRoot = bulletproof?.root ?? "";
      for (const relative of new Set(referenced)) {
        await expect(
          fs.access(path.join(skillRoot, ...relative.split("/"))),
        ).resolves.toBeUndefined();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("discovers the workflow skills for a fresh user from bundled assets", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bundled-skills-"));
    try {
      const skills = await discoverSkills({ globalSkillsDir: path.join(root, "global") });

      // Each bundled workflow skill carries the one discipline marker that
      // makes it work — a skill that loses its marker has become prose.
      const expectations: Array<{ name: string; markers: string[] }> = [
        // Interviews must not outsource homework to the user.
        { name: "clarify", markers: ["Never ask for facts", "Ask only the frontier"] },
        // Seams are agreed before tests exist; expected values never recompute
        // the implementation's logic.
        { name: "tdd", markers: ["No test at an unagreed seam", "outside source of truth"] },
        // Theory is gated behind a red, deterministic, fast repro command;
        // a "why" question must end at the answer, not a fix the user never
        // asked for (skills outrank the prompt, so the guard lives here too).
        {
          name: "root-cause",
          markers: [
            "No red command, no Phase 2",
            "One variable",
            "change code only when the user asks for the fix",
            // Suiteless projects: a mandated regression test would contradict
            // the prompt's "no suite unless asked" rule.
            "never introduce a suite unasked",
          ],
        },
        // The glossary stays a glossary; ADRs are superseded, never edited.
        // CONTEXT.md is not in CONTEXT_FILES, so the glossary only pays off
        // across sessions via the pointer line the skill plants.
        {
          name: "shared-language",
          markers: [
            "glossary and nothing else",
            "supersede, never edit",
            "CONTEXT.md is not auto-loaded",
          ],
        },
        // Spec and standards findings stay unlabeled-merge-proof; security
        // defers to bulletproof instead of duplicating its lane.
        { name: "code-review", markers: ["never merge the lists", "bulletproof"] },
      ];

      for (const { name, markers } of expectations) {
        const skill = skills.find((candidate) => candidate.name === name);
        expect(skill?.source, name).toBe("bundled");
        expect(skill?.root, name).toContain(path.join("assets", "skills", name));
        for (const marker of markers) {
          expect(skill?.content, `${name}: ${marker}`).toContain(marker);
        }
      }
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

describe("skill catalog byte budgets", () => {
  it("clamps an over-long description to the budget on a codepoint boundary", () => {
    const bloated: Skill = {
      ...skill,
      description: `Use for UI work. ${"😀".repeat(600)}`, // ~2.4KB, multibyte
    };
    const prompt = formatSkillsForPrompt([bloated]);
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(2000);
    expect(prompt).toContain("evidence-led-ui");
    expect(prompt).toContain("\u2026");
    expect(prompt).not.toContain("\ufffd");
  });

  it("drops overflow skills and names them in the section", () => {
    const many: Skill[] = Array.from({ length: 60 }, (_, i) => ({
      ...skill,
      name: `skill-${i}`,
      description: "x".repeat(500), // 60 × ~520B > 16KB catalog budget
    }));
    const prompt = formatSkillsForPrompt(many);
    expect(prompt).toContain("Skills omitted (catalog byte budget)");
    expect(prompt).toContain("skill-59");
    // Kept prefix skills still listed.
    expect(prompt).toContain("skill-0");
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThan(20 * 1024);
  });

  it("applies the same budget to the skill tool description", () => {
    const many: Skill[] = Array.from({ length: 60 }, (_, i) => ({
      ...skill,
      name: `skill-${i}`,
      description: "x".repeat(500),
    }));
    const tool = createSkillTool(many);
    expect(tool.description).toContain("Skills omitted (catalog byte budget)");
    expect(Buffer.byteLength(tool.description, "utf8")).toBeLessThan(20 * 1024);
  });

  it("honors raised limits", () => {
    const bloated: Skill = { ...skill, description: "x".repeat(2048) };
    const prompt = formatSkillsForPrompt(
      [bloated],
      resolveContextLimits({ skillDescriptionBytes: 4096 }),
    );
    expect(prompt).toContain("x".repeat(2048));
  });
});
