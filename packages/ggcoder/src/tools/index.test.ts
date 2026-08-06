import { afterEach, describe, expect, it } from "vitest";
import type { AgentDefinition } from "../core/agents.js";
import type { CreateToolsResult } from "./index.js";
import { createTools } from "./index.js";

const agent: AgentDefinition = {
  name: "researcher",
  description: "Researches a focused question",
  tools: ["read"],
  systemPrompt: "Research carefully.",
  source: "bundled",
};

const results: CreateToolsResult[] = [];

afterEach(async () => {
  await Promise.all(
    results.splice(0).map(async ({ processManager, lspManager, subAgentManager }) => {
      await subAgentManager?.shutdownAll();
      await lspManager?.shutdownAll();
      processManager.shutdownAll();
    }),
  );
});

describe("createTools subagent depth policy", () => {
  it("registers both blocking and persistent subagent tools for a parent", async () => {
    const result = await createTools(process.cwd(), {
      agents: [agent],
      provider: "openai",
      model: "gpt-5.6-luna",
      lspDiagnostics: false,
    });
    results.push(result);

    const names = result.tools.map((tool) => tool.name);
    expect(names).toContain("subagent");
    expect(names).toContain("spawn_agent");
    expect(result.subAgentManager).toBeDefined();
  });

  it("omits every subagent tool inside a persistent child worker", async () => {
    const result = await createTools(process.cwd(), {
      agents: [agent],
      provider: "openai",
      model: "gpt-5.6-luna",
      disableSubagents: true,
      lspDiagnostics: false,
    });
    results.push(result);

    const names = result.tools.map((tool) => tool.name);
    const delegationTools = [
      "subagent",
      "spawn_agent",
      "send_message",
      "followup_task",
      "wait_agent",
      "list_agents",
      "interrupt_agent",
    ];
    expect(names.filter((name) => delegationTools.includes(name))).toEqual([]);
    expect(result.subAgentManager).toBeUndefined();
  });
});
