import { describe, it, expect } from "vitest";
import os from "node:os";
import { BUNDLED_AGENTS, parseAgentFile } from "./agents.js";
import { AgentSession, resolveEffectiveAllowedTools } from "./agent-session.js";
import { createTools } from "../tools/index.js";

function filterToAllowed(toolNames: string[], allowed: string[] | undefined): string[] {
  const effective = resolveEffectiveAllowedTools(allowed);
  if (!effective) return toolNames;
  return toolNames.filter((name) => effective.has(name));
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

      // Read-only lists gain no managed-process controls or unrelated tools.
      for (const banned of ["write", "edit", "bash", "task_output", "task_send", "task_stop"]) {
        expect(allowedNames).not.toContain(banned);
      }
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
      // The subagent omits --tools for an empty declaration, so the child receives
      // undefined and keeps every tool.
      const allowedNames = filterToAllowed(
        allNames,
        agent.tools.length > 0 ? agent.tools : undefined,
      );
      expect(allowedNames).toEqual(allNames);
      for (const tool of ["read", "write", "edit", "bash"]) {
        expect(allowedNames).toContain(tool);
      }
    } finally {
      processManager.shutdownAll();
      lspManager?.shutdownAll();
    }
  });

  it("adds exactly the three managed-process controls when bash is allowed", () => {
    const effective = resolveEffectiveAllowedTools(["bash"]);

    expect([...effective!]).toEqual(["bash", "task_output", "task_send", "task_stop"]);
    expect(effective?.has("write")).toBe(false);
    expect(effective?.has("tasks")).toBe(false);
  });

  it("gives bundled bash agents live controls and matching system guidance", async () => {
    for (const agentName of ["auditor", "skeptic"]) {
      const agent = BUNDLED_AGENTS.find((candidate) => candidate.name === agentName);
      expect(agent).toBeDefined();

      const session = new AgentSession({
        provider: "openai",
        model: "gpt-5.5-codex",
        cwd: os.tmpdir(),
        transient: true,
        allowedTools: agent!.tools,
        projectCustomization: false,
        loadExtensions: false,
        coderSlashCommands: false,
        selfCorrectionHooks: false,
        orchestrationPrompt: false,
      });
      try {
        await session.initialize();
        const liveToolNames = (session as unknown as { tools: Array<{ name: string }> }).tools.map(
          (tool) => tool.name,
        );
        expect(liveToolNames.sort()).toEqual(
          [...agent!.tools, "task_output", "task_send", "task_stop"].sort(),
        );
        expect(liveToolNames).not.toContain("write");
        expect(liveToolNames).not.toContain("edit");

        const prompt = String(session.getMessages()[0]?.content ?? "");
        // Only controls with non-obvious usage have dedicated system-prompt hints;
        // task_send remains available through the live provider tool schema.
        for (const toolName of ["task_output", "task_stop"]) {
          expect(prompt).toContain(`**${toolName}**`);
        }
        expect(prompt).not.toContain("**write**");
      } finally {
        await session.dispose();
      }
    }
  });
});
