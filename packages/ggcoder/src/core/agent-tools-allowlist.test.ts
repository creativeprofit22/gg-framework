import { describe, it, expect } from "vitest";
import os from "node:os";
import { parseAgentFile } from "./agents.js";
import { createTools } from "../tools/index.js";

// Mirror of AgentSession.isToolAllowed (private): with an allow-list, a tool
// passes only when its exact name is listed. MCP tools are the one exception —
// they pass when their `mcp__<server>__*` server is in `allowedMcpServers`,
// which the subagent path derives from the agent's own `tools:` frontmatter
// (see `mcpServersForAgent`). This helper covers the non-MCP names only, and is
// kept in lockstep with the real filter so this test tracks production behavior.
function filterToAllowed(toolNames: string[], allowed: string[] | undefined): string[] {
  if (!allowed || allowed.length === 0) return toolNames;
  return toolNames.filter((name) => allowed.includes(name));
}

describe("agent tools frontmatter → allow-list enforcement", () => {
  it("a `tools: read, grep` agent cannot call write, edit, or bash", async () => {
    // The frontmatter is parsed into AgentDefinition.tools, which the subagent
    // spawner forwards to the child as --tools and AgentSession enforces by
    // filtering the registered tool set to those names.
    const agent = parseAgentFile(
      [
        "---",
        "name: reader",
        "description: read-only",
        "tools: read, grep",
        "---",
        "You read.",
      ].join("\n"),
      "project",
    );
    expect(agent.tools).toEqual(["read", "grep"]);

    const { tools, processManager, lspManager } = await createTools(os.tmpdir(), {
      lspDiagnostics: false,
    });
    try {
      const allNames = tools.map((t) => t.name);
      // Sanity: the mutating tools DO exist in the unfiltered set — so the
      // filter is what removes them, not their absence.
      for (const mutating of ["write", "edit", "bash"]) {
        expect(allNames).toContain(mutating);
      }

      const allowedNames = filterToAllowed(allNames, agent.tools);

      // The mutating tools must NOT survive the agent's allow-list.
      for (const banned of ["write", "edit", "bash"]) {
        expect(allowedNames).not.toContain(banned);
      }
      // Exactly the declared read-only tools survive.
      expect(allowedNames.sort()).toEqual(["grep", "read"]);
    } finally {
      processManager.shutdownAll();
      lspManager?.shutdownAll();
    }
  });

  it("an agent with no `tools:` frontmatter keeps the full toolset (backward compatible)", async () => {
    const agent = parseAgentFile(
      ["---", "name: worker", "description: does anything", "---", "You do the work."].join("\n"),
      "project",
    );
    expect(agent.tools).toEqual([]);

    const { tools, processManager, lspManager } = await createTools(os.tmpdir(), {
      lspDiagnostics: false,
    });
    try {
      const allNames = tools.map((t) => t.name);
      // Empty/unset allow-list is a pass-through: the child keeps every tool.
      const allowedNames = filterToAllowed(allNames, agent.tools);
      expect(allowedNames).toEqual(allNames);
      for (const tool of ["read", "write", "edit", "bash"]) {
        expect(allowedNames).toContain(tool);
      }
    } finally {
      processManager.shutdownAll();
      lspManager?.shutdownAll();
    }
  });
});
