import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "./frontmatter.js";
import { parseSkillFile } from "./skills.js";
import { parseAgentFile } from "./agents.js";

describe("parseFrontmatter", () => {
  it("folds a `>` block scalar into one line", () => {
    const raw = [
      "---",
      "name: apple-design",
      "description: >",
      "  Cross-platform UI reviewer.",
      "  Use this skill to audit designs.",
      "---",
      "Body",
    ].join("\n");
    expect(parseFrontmatter(raw)).toEqual({
      fields: {
        name: "apple-design",
        description: "Cross-platform UI reviewer. Use this skill to audit designs.",
      },
      body: "Body",
      hasFrontmatter: true,
    });
  });

  it("keeps newlines for `|` and accepts chomping indicators", () => {
    const raw = "---\ndescription: |-\n  line one\n  line two\n---\n";
    expect(parseFrontmatter(raw).fields.description).toBe("line one\nline two");
  });

  it("strips matching quotes and unescapes them", () => {
    const raw = [
      "---",
      `description: "Auditor \u2014 says \\"hi\\"."`,
      "note: 'it''s fine'",
      "---",
    ].join("\n");
    expect(parseFrontmatter(raw).fields).toEqual({
      description: 'Auditor \u2014 says "hi".',
      note: "it's fine",
    });
  });

  it("joins plain multi-line continuation values", () => {
    const raw = "---\ndescription: first part\n  second part\nname: x\n---\n";
    expect(parseFrontmatter(raw).fields).toEqual({
      description: "first part second part",
      name: "x",
    });
  });

  it("does not close on a `---` inside a value, and handles CRLF", () => {
    const raw = "---\r\ndescription: a --- b\r\n---\r\nBody --- text";
    const parsed = parseFrontmatter(raw);
    expect(parsed.fields.description).toBe("a --- b");
    expect(parsed.body).toBe("Body --- text");
  });

  it("returns the input unchanged when there is no frontmatter", () => {
    expect(parseFrontmatter("# Just markdown\n")).toEqual({
      fields: {},
      body: "# Just markdown\n",
      hasFrontmatter: false,
    });
    expect(parseFrontmatter("---\nname: x\nno close").hasFrontmatter).toBe(false);
  });
});

describe("skill/agent files use full frontmatter parsing", () => {
  it("reads a folded skill description", () => {
    const skill = parseSkillFile(
      "---\nname: s\ndescription: >\n  Use when X.\n  Not for Y.\n---\nDo it.",
      "project",
    );
    expect(skill).toMatchObject({
      name: "s",
      description: "Use when X. Not for Y.",
      content: "Do it.",
    });
  });

  it("reads quoted agent fields and list-style tools", () => {
    const agent = parseAgentFile(
      '---\nname: v\ndescription: "Checks controls."\ntools: [read, "grep"]\nmodel: fast\ncontext: None\n---\nPrompt',
      "project",
    );
    expect(agent).toMatchObject({
      name: "v",
      description: "Checks controls.",
      tools: ["read", "grep"],
      model: "fast",
      context: "none",
      systemPrompt: "Prompt",
    });
  });
});
