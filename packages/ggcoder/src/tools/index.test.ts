import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentDefinition } from "../core/agents.js";
import { ResearchSourceLedger } from "../core/research-sources.js";
import type { CreateToolsResult } from "./index.js";
import { createTools } from "./index.js";
import { localOperations } from "./operations.js";
import type { VerifyPlan } from "@kenkaiiii/gg-core/verify-plan";
import { useFakeHome } from "../test-support/fake-home.js";

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
  // Wait for spawned processes to exit before deleting their working
  // directories: a live child keeps the directory open on Windows (EBUSY).
  await Promise.all(
    results.splice(0).map(async ({ processManager, lspManager, subAgentManager }) => {
      await subAgentManager?.shutdownAll();
      await lspManager?.shutdownAll();
      await processManager.shutdownAllAndWait();
    }),
  );
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

describe("createTools LSP policy", () => {
  it("keeps the language-server manager when edit diagnostics are disabled", async () => {
    const result = await createTools(process.cwd(), { lspDiagnostics: false });
    results.push(result);

    expect(result.lspManager).toBeDefined();
  });
});

describe("createTools advisory-only corpus facade", () => {
  async function corpusToolNames(includeAdvisoryOnlyTools?: boolean): Promise<string[]> {
    const dir = mkdtempSync(path.join(tmpdir(), "gg-steroids-bin-"));
    dirs.push(dir);
    const steroidsBin = path.join(dir, "steroids");
    writeFileSync(steroidsBin, "");
    const result = await createTools(process.cwd(), {
      steroidsBin,
      lspDiagnostics: false,
      ...(includeAdvisoryOnlyTools === undefined ? {} : { includeAdvisoryOnlyTools }),
    });
    results.push(result);
    return result.tools
      .map((tool) => tool.name)
      .filter((name) => name === "steroids" || name === "research_corpus");
  }

  it("omits research_corpus by default so ordinary hosts route corpus work to steroids", async () => {
    expect(await corpusToolNames()).toEqual(["steroids"]);
  });

  it("includes research_corpus only when advisory-only tools are requested", async () => {
    expect(await corpusToolNames(true)).toEqual(["steroids", "research_corpus"]);
  });
});

describe("createTools advisory-only git history", () => {
  async function hasGitHistory(includeAdvisoryOnlyTools?: boolean): Promise<boolean> {
    const result = await createTools(process.cwd(), {
      steroidsBin: null,
      lspDiagnostics: false,
      ...(includeAdvisoryOnlyTools === undefined ? {} : { includeAdvisoryOnlyTools }),
    });
    results.push(result);
    return result.tools.some((tool) => tool.name === "git_history");
  }

  it("adds git_history only when advisory-only tools are requested", async () => {
    expect(await hasGitHistory()).toBe(false);
    expect(await hasGitHistory(false)).toBe(false);
    expect(await hasGitHistory(true)).toBe(true);
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
    const createCall = tui.slice(
      tui.indexOf("await createTools("),
      tui.indexOf("const mcpManager"),
    );
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

describe("createTools verify-plan wiring", () => {
  const plan: VerifyPlan = {
    version: 1,
    mode: "changed",
    advice: [],
    gates: [
      {
        id: "gate",
        argv: ["node", "gate.mjs"],
        cwd: ".",
        covers: [],
        fingerprint: null,
        quietBudgetSeconds: null,
        protectedPaths: [],
      },
    ],
  };

  async function runReviewedGate(getVerifyPlan?: () => VerifyPlan | null): Promise<string> {
    const cwd = mkdtempSync(path.join(tmpdir(), "gg-verify-plan-wiring-"));
    dirs.push(cwd);
    writeFileSync(path.join(cwd, "gate.mjs"), "console.log('gate ok');\n");
    const restoreHome = useFakeHome(cwd);
    try {
      const result = await createTools(cwd, {
        steroidsBin: null,
        lspDiagnostics: false,
        ...(getVerifyPlan ? { getVerifyPlan } : {}),
      });
      results.push(result);
      const bash = result.tools.find((tool) => tool.name === "bash");
      if (!bash) throw new Error("bash tool missing");
      const output = await bash.execute({ command: "node gate.mjs", review: true }, {
        signal: new AbortController().signal,
        toolCallId: "gate",
      } as Parameters<typeof bash.execute>[1]);
      return typeof output === "string" ? output : String((output as { content: unknown }).content);
    } finally {
      restoreHome();
    }
  }

  it("forwards getVerifyPlan to bash so review accepts an exact plan gate", async () => {
    expect(await runReviewedGate()).toContain("Nothing was run");
    const accepted = await runReviewedGate(() => plan);
    expect(accepted).not.toContain("Nothing was run");
    expect(accepted).toMatch(/^Exit code: 0\b/);
  });

  it("passes a verify-plan loader from runInkTUI into createTools", () => {
    const source = readFileSync(new URL("../cli.ts", import.meta.url), "utf8");
    const tui = source.slice(
      source.indexOf("async function runInkTUI("),
      source.indexOf("// ── Sessions"),
    );
    expect(tui).toContain("const verifyPlanLoader = new VerifyPlanLoader({");
    expect(tui).toContain("void verifyPlanLoader.refresh();");
    const createCall = tui.slice(
      tui.indexOf("await createTools("),
      tui.indexOf("const mcpManager"),
    );
    expect(createCall).toContain("getVerifyPlan: () => verifyPlanLoader.get(),");
    expect(createCall).toContain("verifyPlanLoader.noteFileMutated(filePath)");
    expect(tui.match(/verifyPlanLoader\.dispose\(\);/g)).toHaveLength(2);
  });
});

describe("createTools dev_app wiring", () => {
  it("registers dev_app with a manager only for local operations", async () => {
    const local = await createTools(process.cwd(), { steroidsBin: null, lspDiagnostics: false });
    results.push(local);
    expect(local.tools.some((tool) => tool.name === "dev_app")).toBe(true);
    expect(local.devAppManager).toBeDefined();

    const remote = await createTools(process.cwd(), {
      steroidsBin: null,
      lspDiagnostics: false,
      operations: { ...localOperations },
    });
    results.push(remote);
    expect(remote.tools.some((tool) => tool.name === "dev_app")).toBe(false);
    expect(remote.devAppManager).toBeUndefined();
  });
});
