import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUNDLED_AGENTS, discoverAgents, mcpServersForAgent, parseAgentFile } from "./agents.js";

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

describe("bundled agents", () => {
  it("ships auditor and skeptic so /bullet-proof always resolves them", () => {
    const names = BUNDLED_AGENTS.map((a) => a.name);
    expect(names).toContain("auditor");
    expect(names).toContain("skeptic");
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
