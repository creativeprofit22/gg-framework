import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentDefinition } from "../core/agents.js";
import { ResearchSourceLedger } from "../core/research-sources.js";
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
const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  await Promise.all(
    results.splice(0).map(async ({ processManager, lspManager, subAgentManager }) => {
      await subAgentManager?.shutdownAll();
      await lspManager?.shutdownAll();
      processManager.shutdownAll();
    }),
  );
});

describe("createTools LSP policy", () => {
  it("keeps local navigation available when edit diagnostics are disabled", async () => {
    const result = await createTools(process.cwd(), { lspDiagnostics: false });
    results.push(result);

    expect(result.lspManager).toBeDefined();
    expect(result.tools.map((tool) => tool.name)).toContain("code_nav");
  });
});

describe("createTools research citation gate (terminal TUI wiring)", () => {
  const PLAN_STEPS = "\n\n## Steps\n1. Do the thing.\n";

  it("passes a research ledger from runInkTUI into createTools and renderApp", () => {
    const source = readFileSync(new URL("../cli.ts", import.meta.url), "utf8");
    const tui = source.slice(
      source.indexOf("async function runInkTUI("),
      source.indexOf("// ── Sessions"),
    );
    expect(tui).toContain("const researchSources = new ResearchSourceLedger();");
    const createCall = tui.slice(tui.indexOf("await createTools("), tui.indexOf("const mcpManager"));
    expect(createCall).toMatch(/^\s+researchSources,$/m);
    const renderCall = tui.slice(tui.indexOf("await renderApp("));
    expect(renderCall).toMatch(/^\s+researchSources,$/m);
  });

  it("returns an exit_plan that rejects an uncited plan after recorded corpus research", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "gg-cite-gate-"));
    dirs.push(cwd);
    mkdirSync(path.join(cwd, ".gg", "plans"), { recursive: true });
    const researchSources = new ResearchSourceLedger();
    const submitted: string[] = [];
    // Same option shape runInkTUI passes (plan callbacks + agents + ledger).
    const result = await createTools(cwd, {
      agents: [agent],
      provider: "openai",
      model: "gpt-6-luna",
      planModeRef: { current: true },
      researchSources,
      onEnterPlan: () => {},
      onExitPlan: async (planPath) => {
        submitted.push(planPath);
        return "Plan submitted.";
      },
      steroidsBin: null,
      lspDiagnostics: false,
    });
    results.push(result);
    const exitPlan = result.tools.find((tool) => tool.name === "exit_plan");
    expect(exitPlan).toBeDefined();
    if (!exitPlan) return;

    const permalink = "https://github.com/acme/widgets/blob/0123456789abcdef/src/a.ts#L1";
    researchSources.recordCorpusResult(
      { action: "search", pattern: "x" },
      JSON.stringify({ matches: [{ repo: "acme/widgets", url: permalink }] }),
    );
    const signal = new AbortController().signal;
    const ctx = { signal, toolCallId: "t1" } as Parameters<typeof exitPlan.execute>[1];

    writeFileSync(path.join(cwd, ".gg", "plans", "p.md"), `# Plan${PLAN_STEPS}`);
    await expect(exitPlan.execute({ plan_path: ".gg/plans/p.md" }, ctx)).rejects.toThrow(
      /cites none of it/,
    );
    expect(submitted).toEqual([]);

    writeFileSync(
      path.join(cwd, ".gg", "plans", "p.md"),
      `# Plan\n\n## Sources\n- ${permalink}${PLAN_STEPS}`,
    );
    await exitPlan.execute({ plan_path: ".gg/plans/p.md" }, ctx);
    expect(submitted).toHaveLength(1);
    expect(researchSources.isEmpty()).toBe(true);
  });
});

describe("createTools subagent depth policy", () => {
  it("registers both blocking and persistent subagent tools for a parent", async () => {
    const result = await createTools(process.cwd(), {
      agents: [agent],
      provider: "openai",
      model: "gpt-6-luna",
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
      model: "gpt-6-luna",
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
