import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppSidecarPlanGate, hashPlanContent } from "../app-sidecar-plan-gate.js";
import { agentLoop, type AgentEvent, type ToolExecuteResult } from "@kenkaiiii/gg-agent";
import { stream, StreamResult, type Message, type StreamResponse } from "@kenkaiiii/gg-ai";
import { createExitPlanTool } from "./exit-plan.js";
import {
  ResearchSourceLedger,
  checkPlanCitations,
  withDelegatedSourceRecording,
} from "../core/research-sources.js";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import { z } from "zod";
import { shouldStartAutopilotCycle } from "../core/autopilot-gate.js";
import { driveAutopilotCycle } from "../core/autopilot-cycle.js";

vi.mock("@kenkaiiii/gg-ai", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("@kenkaiiii/gg-ai")>();
  return { ...actual, stream: vi.fn() };
});

function responseStream(response: StreamResponse): StreamResult {
  return new StreamResult(
    (async function* () {
      yield* [];
      return response;
    })(),
  );
}

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
    vi.mocked(stream).mockReset();
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

  it.each([false, true])(
    "ends the research run and waits for review (autopilot=%s)",
    async (autopilot) => {
      await fs.writeFile(path.join(plansDir, "plan.md"), "# Plan\n\n## Steps\n\n1. Add tests\n");
      let pendingPlan = false;
      const onExitPlan = vi.fn(async (): Promise<string> => {
        pendingPlan = true;
        return "Plan submitted. Wait for approval.";
      });
      const usage = { inputTokens: 100, outputTokens: 10 };
      vi.mocked(stream)
        .mockImplementationOnce(() =>
          responseStream({
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_call",
                  id: "submit",
                  name: "exit_plan",
                  args: { plan_path: ".gg/plans/plan.md" },
                },
              ],
            },
            stopReason: "tool_use",
            usage,
          }),
        )
        // Replay the session failure: the model obeys "wait" and sends no text.
        .mockImplementation(() =>
          responseStream({
            message: { role: "assistant", content: [] },
            stopReason: "end_turn",
            usage,
          }),
        );
      const messages: Message[] = [{ role: "user", content: "Submit the plan for review." }];
      const events: AgentEvent[] = [];

      for await (const event of agentLoop(messages, {
        provider: "openai",
        model: "test",
        tools: [createExitPlanTool(cwd, onExitPlan)],
      })) {
        events.push(event);
      }

      expect(onExitPlan).toHaveBeenCalledOnce();
      expect(events.filter((event) => event.type === "truncated")).toEqual([]);
      expect(events.filter((event) => event.type === "retry")).toEqual([]);
      expect(stream).toHaveBeenCalledOnce();
      expect(events.at(-1)).toMatchObject({ type: "agent_done", totalTurns: 1 });
      expect(messages.at(-1)).toMatchObject({
        role: "tool",
        content: [{ toolCallId: "submit", content: "Plan submitted. Wait for approval." }],
      });
      expect(pendingPlan).toBe(true);

      // Exercise the same post-run gate/cycle used by the desktop. Submission
      // alone must never implement; only the chosen reviewer may approve it.
      const gate = shouldStartAutopilotCycle({
        enabled: autopilot,
        cancelled: false,
        planMode: false,
        planPending: pendingPlan,
        workflowCommand: false,
        assistantMessagesAdded: 1,
      });
      expect(gate).toEqual(
        autopilot ? { start: true, kind: "plan" } : { start: false, reason: "disabled" },
      );
      const reviewPlan = vi.fn(async () => ({ kind: "all_clear" as const }));
      const acceptPlan = vi.fn(async (): Promise<boolean> => {
        pendingPlan = false;
        return true;
      });
      const runImplement = vi.fn(async (): Promise<void> => {
        expect(pendingPlan).toBe(false);
        vi.mocked(stream).mockImplementation(() =>
          responseStream({
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Implementation complete." }],
            },
            stopReason: "end_turn",
            usage,
          }),
        );
        const approvedMessages: Message[] = [
          { role: "user", content: "The plan has been approved. Implement it now." },
        ];
        for await (const event of agentLoop(approvedMessages, {
          provider: "openai",
          model: "test",
          tools: [createExitPlanTool(cwd, onExitPlan)],
        })) {
          expect(event.type).not.toBe("truncated");
        }
        expect(approvedMessages.at(-1)).toMatchObject({
          role: "assistant",
          content: [{ type: "text", text: "Implementation complete." }],
        });
      });
      // Local Fork: Ken's all-clear only marks the plan ready; the user still
      // accepts it, so the cycle itself never starts implementation.
      const markPlanReady = vi.fn(async () => ({ checkpointId: "plan-1", generation: 1 }));
      const emit = vi.fn();
      if (gate.start) {
        await driveAutopilotCycle({
          maxRounds: 2,
          isCancelled: () => false,
          isPlanMode: () => false,
          planPending: () => pendingPlan,
          resetReviewer: async (): Promise<void> => {},
          reviewPlan,
          markPlanReady,
          requestPlanRevision: vi.fn(async () => false),
          review: async () => ({ kind: "all_clear" as const }),
          runPrompt: vi.fn(),
          onInjected: vi.fn(),
          emit,
        });
        expect(markPlanReady).toHaveBeenCalledOnce();
        expect(emit).toHaveBeenCalledWith(
          expect.objectContaining({ type: "autopilot_plan_ready" }),
        );
        expect(pendingPlan).toBe(true);
      } else {
        expect(reviewPlan).not.toHaveBeenCalled();
        expect(markPlanReady).not.toHaveBeenCalled();
      }
      expect(acceptPlan).not.toHaveBeenCalled();
      expect(runImplement).not.toHaveBeenCalled();
      // Accept starts a fresh implementation run, not a continuation of the
      // now-finished research run.
      await acceptPlan();
      await runImplement();
      expect(reviewPlan).toHaveBeenCalledTimes(autopilot ? 1 : 0);
      expect(acceptPlan).toHaveBeenCalledOnce();
      expect(runImplement).toHaveBeenCalledOnce();
      expect(stream).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["inline approval", "invalid plan"])("continues the loop after %s", async (outcome) => {
    await fs.writeFile(
      path.join(plansDir, "plan.md"),
      outcome === "invalid plan"
        ? "# Plan\n\nNo steps yet."
        : "# Plan\n\n## Steps\n\n1. Add tests\n",
    );
    const onExitPlan = vi.fn(async (): Promise<ToolExecuteResult> => ({
      content: "Plan approved. Proceed with implementation.",
      endRun: false,
    }));
    const usage = { inputTokens: 100, outputTokens: 10 };
    vi.mocked(stream)
      .mockImplementationOnce(() =>
        responseStream({
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_call",
                id: "submit",
                name: "exit_plan",
                args: { plan_path: ".gg/plans/plan.md" },
              },
            ],
          },
          stopReason: "tool_use",
          usage,
        }),
      )
      .mockImplementationOnce(() =>
        responseStream({
          message: { role: "assistant", content: [{ type: "text", text: "Continuing." }] },
          stopReason: "end_turn",
          usage,
        }),
      );
    const events: AgentEvent[] = [];
    for await (const event of agentLoop([{ role: "user", content: "Review the plan." }], {
      provider: "openai",
      model: "test",
      tools: [createExitPlanTool(cwd, onExitPlan)],
    }))
      events.push(event);

    expect(onExitPlan).toHaveBeenCalledTimes(outcome === "invalid plan" ? 0 : 1);
    expect(stream).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toMatchObject({ type: "agent_done", totalTurns: 2 });
  });

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
