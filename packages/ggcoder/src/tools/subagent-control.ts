import { z } from "zod";
import type { AgentTool } from "@kenkaiiii/gg-agent";
import type { SubAgentManager } from "../core/subagent-manager.js";
import { isPlanModeActive, planModeRestriction } from "../core/runtime-mode.js";

const AgentId = z.string().min(1).describe("Eight-character agent ID returned by spawn_agent");

function json(value: unknown): { content: string } {
  return { content: JSON.stringify(value) };
}

export function createSubAgentControlTools(
  manager: SubAgentManager,
  planModeRef?: { current: boolean },
): AgentTool[] {
  const blocked = (name: string) =>
    isPlanModeActive(planModeRef) ? planModeRestriction(name) : undefined;

  const spawnParams = z.object({
    task_name: z.string().min(1).describe("Short unique name for this delegated task"),
    task: z.string().min(1).describe("Standalone task instruction for the child agent"),
    agent: z.string().optional().describe("Optional named agent definition"),
  });
  const spawnTool: AgentTool<typeof spawnParams> = {
    name: "spawn_agent",
    description:
      "Start an isolated persistent child agent and return immediately after launch. " +
      "Start all independent agents, then keep working \u2014 each child announces its own " +
      "completion to you, so you do not need to wait or poll. Shared files are not isolated.",
    parameters: spawnParams,
    executionMode: "parallel",
    async execute(args) {
      const restriction = blocked("spawn_agent");
      if (restriction) return restriction;
      return json(await manager.spawn(args.task_name, args.task, args.agent));
    },
  };

  const messageParams = z.object({ agent_id: AgentId, message: z.string().min(1) });
  const messageTool: AgentTool<typeof messageParams> = {
    name: "send_message",
    description: "Queue steering into a running child agent without starting another turn.",
    parameters: messageParams,
    async execute(args) {
      const restriction = blocked("send_message");
      if (restriction) return restriction;
      return json({
        agent_id: args.agent_id,
        queued: await manager.sendMessage(args.agent_id, args.message),
      });
    },
  };

  const followupParams = z.object({ agent_id: AgentId, task: z.string().min(1) });
  const followupTool: AgentTool<typeof followupParams> = {
    name: "followup_task",
    description: "Start another turn in an idle child while preserving that child's context.",
    parameters: followupParams,
    async execute(args) {
      const restriction = blocked("followup_task");
      if (restriction) return restriction;
      return json(await manager.followup(args.agent_id, args.task));
    },
  };

  const waitParams = z.object({
    agent_ids: z
      .array(AgentId)
      .optional()
      .describe("Agents to wait for; omitted means active agents"),
    condition: z.enum(["any", "all"]).optional().describe("Default: any"),
    timeout_ms: z
      .number()
      .int()
      .min(0)
      .max(300_000)
      .optional()
      .describe("Default 30000; max 300000"),
  });
  const waitTool: AgentTool<typeof waitParams> = {
    name: "wait_agent",
    description:
      "Block until child agents finish and return their bounded output snapshots. " +
      "Completions already arrive on their own \u2014 use this only when you need a child's " +
      "actual output before you can continue, or to collect results before finishing.",
    parameters: waitParams,
    async execute(args) {
      return json(await manager.wait(args.agent_ids, args.condition, args.timeout_ms));
    },
  };

  const listParams = z.object({});
  const listTool: AgentTool<typeof listParams> = {
    name: "list_agents",
    description:
      "List child IDs, task names, lifecycle states, activity, turns, tools, and token totals.",
    parameters: listParams,
    async execute() {
      return json(manager.list().map(({ output: _output, error: _error, ...summary }) => summary));
    },
  };

  const interruptParams = z.object({ agent_id: AgentId });
  const interruptTool: AgentTool<typeof interruptParams> = {
    name: "interrupt_agent",
    description:
      "Interrupt a child's current turn while retaining its context for a later follow-up.",
    parameters: interruptParams,
    async execute(args) {
      return json(await manager.interrupt(args.agent_id));
    },
  };

  return [spawnTool, messageTool, followupTool, waitTool, listTool, interruptTool];
}
