import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppSidecarPlanGate, hashPlanContent } from "../app-sidecar-plan-gate.js";
import { createExitPlanTool } from "./exit-plan.js";
import {
  ResearchSourceLedger,
  checkPlanCitations,
  withDelegatedSourceRecording,
} from "../core/research-sources.js";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { z } from "zod";

const context = () => ({ signal: new AbortController().signal, toolCallId: "exit-plan-test" });

function asText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "content" in result) {
    const c = (result as { content: unknown }).content;
    if (typeof c === "string") return c;
  }
  return String(result);
}

describe("createExitPlanTool", () => {
  let cwd: string;
  let plansDir: string;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "exit-plan-test-"));
    plansDir = path.join(cwd, ".gg", "plans");
    await fs.mkdir(plansDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it("passes a valid plan with a ## Steps section through to onExitPlan", async () => {
    const planPath = path.join(plansDir, "plan.md");
    await fs.writeFile(
      planPath,
      "# My Plan\n\nContext here.\n\n## Steps\n\n1. Implement the feature in src/a.ts\n2. Add tests for the feature\n",
    );
    const onExitPlan = vi.fn().mockResolvedValue("Plan submitted.");
    const tool = createExitPlanTool(cwd, onExitPlan);

    const result = await tool.execute({ plan_path: ".gg/plans/plan.md" }, context());

    expect(asText(result)).toBe("Plan submitted.");
    expect(onExitPlan).toHaveBeenCalledWith(
      planPath,
      "# My Plan\n\nContext here.\n\n## Steps\n\n1. Implement the feature in src/a.ts\n2. Add tests for the feature\n",
    );
  });

  it.each(["replaced", "removed"] as const)(
    "persists the exact validated bytes when the plan file is %s after validation",
    async (mutation) => {
      const planPath = path.join(plansDir, "immutable.md");
      const validatedContent = "# Immutable Plan\n\n## Steps\n\n1. Persist these exact bytes\n";
      await fs.writeFile(planPath, validatedContent);
      const persisted: Array<{ content: string; contentHash: string }> = [];
      const gate = new AppSidecarPlanGate([], async (checkpoint) => {
        persisted.push(checkpoint);
      });
      const tool = createExitPlanTool(cwd, async (submittedPath, content) => {
        if (mutation === "replaced") {
          await fs.writeFile(submittedPath, "# Substituted after validation\n");
        } else {
          await fs.rm(submittedPath);
        }
        await gate.submit(submittedPath, content);
        return "Plan submitted.";
      });

      const result = await tool.execute({ plan_path: ".gg/plans/immutable.md" }, context());

      expect(asText(result)).toBe("Plan submitted.");
      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toMatchObject({
        content: validatedContent,
        contentHash: hashPlanContent(validatedContent),
      });
    },
  );

  it("rejects a step-less plan with the remediation message and never calls onExitPlan", async () => {
    await fs.writeFile(
      path.join(plansDir, "plan.md"),
      "# My Plan\n\nJust prose describing the approach with no step section.\n",
    );
    const onExitPlan = vi.fn();
    const tool = createExitPlanTool(cwd, onExitPlan);

    const result = tool.execute({ plan_path: ".gg/plans/plan.md" }, context());

    await expect(result).rejects.toThrow("Plan rejected: no '## Steps' section");
    await expect(result).rejects.toThrow("call exit_plan again");
    expect(onExitPlan).not.toHaveBeenCalled();
  });

  it("rejects a plan whose ## Steps section has only prose bullets", async () => {
    await fs.writeFile(
      path.join(plansDir, "plan.md"),
      "# My Plan\n\n## Steps\n\n- do the first thing\n- do the second thing\n",
    );
    const onExitPlan = vi.fn();
    const tool = createExitPlanTool(cwd, onExitPlan);

    await expect(tool.execute({ plan_path: ".gg/plans/plan.md" }, context())).rejects.toThrow(
      "Plan rejected",
    );
    expect(onExitPlan).not.toHaveBeenCalled();
  });

  it("rejects an empty plan file", async () => {
    await fs.writeFile(path.join(plansDir, "plan.md"), "   \n");
    const onExitPlan = vi.fn();
    const tool = createExitPlanTool(cwd, onExitPlan);

    await expect(tool.execute({ plan_path: ".gg/plans/plan.md" }, context())).rejects.toThrow(
      "Plan file is empty",
    );
    expect(onExitPlan).not.toHaveBeenCalled();
  });

  it("rejects a plan that omits corpus code retrieved this session, then accepts it once cited", async () => {
    const permalink =
      "https://github.com/vercel/turborepo/blob/c42dc5320e1e62342d6cde0a05b8f027627f1412/a.ts#L8";
    const ledger = new ResearchSourceLedger();
    ledger.recordCorpusResult(
      { action: "search" },
      JSON.stringify({ matches: [{ repo: "vercel/turborepo", url: permalink }] }),
    );
    const planPath = path.join(plansDir, "plan.md");
    const body = "# Plan\n\n## Steps\n\n1. Implement the server in src/a.ts\n";
    await fs.writeFile(planPath, body);
    const onExitPlan = vi.fn().mockResolvedValue("Plan submitted.");
    const tool = createExitPlanTool(cwd, onExitPlan, ledger);

    const rejected = tool.execute({ plan_path: ".gg/plans/plan.md" }, context());
    await expect(rejected).rejects.toThrow("Plan rejected");
    await expect(rejected).rejects.toThrow(permalink);
    expect(onExitPlan).not.toHaveBeenCalled();

    await fs.writeFile(planPath, `${body}\n## Sources\n\n- ${permalink}\n`);
    const accepted = asText(await tool.execute({ plan_path: ".gg/plans/plan.md" }, context()));
    expect(accepted).toBe("Plan submitted.");
    expect(ledger.isEmpty()).toBe(true);
  });

  it("requires citing permalinks returned by a delegated research agent", async () => {
    const permalink =
      "https://github.com/vercel/turborepo/blob/c42dc5320e1e62342d6cde0a05b8f027627f1412/a.ts#L8";
    const fakeSubagent: AgentTool = {
      name: "subagent",
      description: "fake",
      parameters: z.object({}),
      execute: async () => ({ content: `Found the pattern: ${permalink}` }),
    };
    const failedSubagent: AgentTool = {
      ...fakeSubagent,
      execute: async () => ({ content: `Sub-agent failed (exit 1): boom\n${permalink}` }),
    };
    const ledger = new ResearchSourceLedger();
    const plan = "# Plan\n\n## Steps\n\n1. Implement the server in src/a.ts\n";

    await withDelegatedSourceRecording(failedSubagent, ledger).execute({}, context());
    expect(ledger.isEmpty()).toBe(true);
    expect(checkPlanCitations(plan, ledger)).toEqual({ ok: true });

    await withDelegatedSourceRecording(fakeSubagent, ledger).execute({}, context());
    const result = checkPlanCitations(plan, ledger);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(permalink);
  });

  it("still rejects paths outside .gg/plans/", async () => {
    const onExitPlan = vi.fn();
    const tool = createExitPlanTool(cwd, onExitPlan);

    for (const bad of ["plan.md", "../plan.md", ".gg/plans/../../etc/passwd"]) {
      await expect(tool.execute({ plan_path: bad }, context())).rejects.toThrow(
        "must be under .gg/plans/",
      );
    }
    expect(onExitPlan).not.toHaveBeenCalled();
  });
});
