import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BUNDLED_AGENTS,
  discoverAgents,
  mcpServersForAgent,
  parseAgentFile,
  validateAgentTools,
} from "./agents.js";

describe("mcpServersForAgent", () => {
  it("derives server names from mcp__<server>__<tool> entries", () => {
    expect(
      mcpServersForAgent([
        "read",
        "grep",
        "mcp__kencode-search__searchCode",
        "mcp__kencode-search__discoverRepos",
      ]),
    ).toEqual(["kencode-search"]);
  });

  it("returns an empty list when no MCP tools are requested", () => {
    expect(mcpServersForAgent(["read", "write", "bash"])).toEqual([]);
  });

  it("keeps distinct servers and tolerates underscores in tool names", () => {
    expect(
      mcpServersForAgent(["mcp__notion__search_pages", "mcp__linear__list_issues"]).sort(),
    ).toEqual(["linear", "notion"]);
  });

  it("ignores malformed mcp entries", () => {
    expect(mcpServersForAgent(["mcp__", "mcp__onlyserver", "mcp____", "notmcp__x__y"])).toEqual([]);
  });

  it("derives the whitelist from a real agent file's frontmatter", () => {
    const agent = parseAgentFile(
      [
        "---",
        "name: scout",
        "description: researcher",
        "tools: read, grep, mcp__kencode-search__searchCode",
        "---",
        "You scout.",
      ].join("\n"),
      "project",
    );

    expect(mcpServersForAgent(agent.tools)).toEqual(["kencode-search"]);
  });
});

describe("parseAgentFile", () => {
  it("reads the model and context policies from frontmatter", () => {
    const agent = parseAgentFile(
      [
        "---",
        "name: scout",
        "description: Recon",
        "tools: read, grep",
        "model: fast",
        "context: none",
        "---",
        "Scout it.",
      ].join("\n"),
      "project",
    );

    expect(agent.model).toBe("fast");
    expect(agent.context).toBe("none");
    expect(agent.systemPrompt).toBe("Scout it.");
  });

  it("leaves both unset when absent, and ignores unknown keys", () => {
    const agent = parseAgentFile(
      ["---", "name: scout", "description: Recon", "temperature: 0.3", "---", "Scout."].join("\n"),
      "project",
    );

    expect(agent.model).toBeUndefined();
    expect(agent.context).toBeUndefined();
    expect(agent.name).toBe("scout");
  });

  it("accepts an explicit model id and rejects a nonsense context", () => {
    const agent = parseAgentFile(
      [
        "---",
        "name: scout",
        "description: Recon",
        "model: claude-haiku-4-5",
        "context: sometimes",
        "---",
        "Scout.",
      ].join("\n"),
      "project",
    );

    expect(agent.model).toBe("claude-haiku-4-5");
    expect(agent.context).toBeUndefined();
  });
});

describe("validateAgentTools", () => {
  const base = {
    name: "scout",
    description: "Recon",
    systemPrompt: "x",
    source: "project",
  } as const;

  it("accepts built-in and mcp__<server>__<tool> names", () => {
    expect(
      validateAgentTools(
        { ...base, tools: ["read", "code_search", "mcp__kencode-search__searchCode"] },
        "test",
      ),
    ).toEqual([]);
  });

  it("reports names no session could ever register", () => {
    expect(
      validateAgentTools({ ...base, tools: ["read", "webfetch", "Bash", "mcp__broken"] }, "test"),
    ).toEqual(["webfetch", "Bash", "mcp__broken"]);
  });
});

describe("bundled agents", () => {
  it("ships all six agents on a fresh install", () => {
    expect(BUNDLED_AGENTS.map((a) => a.name).sort()).toEqual([
      "auditor",
      "bee",
      "owl",
      "researcher",
      "skeptic",
      "worker",
    ]);
  });

  it("lists only tools a session can actually register", () => {
    for (const agent of BUNDLED_AGENTS) {
      expect(validateAgentTools(agent, "bundled"), agent.name).toEqual([]);
    }
  });

  it("declares its model policy instead of leaving it to inference", () => {
    for (const agent of BUNDLED_AGENTS) {
      expect(agent.model, agent.name).toBeDefined();
    }
    // Only cheap structural recon opts out of the parent's model.
    const fast = BUNDLED_AGENTS.filter((a) => a.model === "fast").map((a) => a.name);
    expect(fast).toEqual(["owl"]);
  });

  it("writes descriptions that route — distinct, and never 'does anything'", () => {
    const descriptions = BUNDLED_AGENTS.map((a) => a.description);
    expect(new Set(descriptions).size).toBe(BUNDLED_AGENTS.length);
    for (const description of descriptions) {
      expect(description.toLowerCase()).not.toContain("does anything");
      expect(description.length).toBeGreaterThan(40);
    }
  });

  it("gives the researcher live code search so it cannot fall back to training data", () => {
    const researcher = BUNDLED_AGENTS.find((a) => a.name === "researcher")!;
    expect(mcpServersForAgent(researcher.tools)).toEqual(["kencode-search"]);
  });

  it("does not shadow bundled agents unless the user defines that name", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-agents-"));
    try {
      const agents = await discoverAgents({ globalAgentsDir: dir });
      const auditor = agents.find((a) => a.name === "auditor");
      expect(auditor?.source).toBe("bundled");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lets a user-defined agent of the same name win", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gg-agents-"));
    try {
      fs.writeFileSync(
        path.join(dir, "auditor.md"),
        "---\nname: auditor\ndescription: mine\ntools: read\n---\nMine.\n",
        "utf-8",
      );
      const agents = await discoverAgents({ globalAgentsDir: dir });
      const auditors = agents.filter((a) => a.name === "auditor");
      expect(auditors).toHaveLength(1);
      expect(auditors[0].source).toBe("global");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
