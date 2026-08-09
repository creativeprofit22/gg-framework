import type { AgentTool } from "@kenkaiiii/gg-agent";

/**
 * Two-tier split of the built-in toolset.
 *
 * Every tool in `this.tools` ships its full JSON parameter schema on every
 * request, inside the cached prefix. A core tool earns that cost because it is
 * reached in most sessions. A deferred tool does not: it contributes one
 * `- **name**: hint` line to the system prompt's Tools section (~15-25 tokens)
 * instead of a full schema (~300-500 tokens), and `tool_search` promotes it
 * into the live toolset the moment the model asks for that capability.
 *
 * The index line is what makes deferral safe. Dropping a schema WITHOUT
 * advertising the capability trades tokens for capability blindness — the model
 * cannot search for a tool it does not know exists. That is why every deferred
 * name is required to carry a `TOOL_PROMPT_HINTS` entry (enforced by test).
 *
 * Tier membership rule: a tool stays core if it is reached in more than roughly
 * one in five sessions. Deferring a tool is only safe while capability-discovery
 * rates hold: measure that, not just the token saving, before moving a name.
 */
export const CORE_TOOL_NAMES: readonly string[] = [
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
  "code_search",
  "code_nav",
  "web_search",
  "web_fetch",
  // The app and orchestrator expose task handoff directly; preserve that local
  // contract instead of requiring capability discovery before task completion.
  "tasks",
  "task_output",
  "task_send",
  "task_stop",
  "subagent",
  "spawn_agent",
  "skill",
  "enter_plan",
  "exit_plan",
  "tool_search",
];

/**
 * Built-ins that live in the catalog as index lines until `tool_search` is
 * called. Each one is either rare (image generation, screenshots, package
 * source resolution) or only reachable after another tool has already run
 * (the child-agent control cluster follows `spawn_agent`).
 */
export const DEFERRED_TOOL_NAMES: readonly string[] = [
  "source_path",
  "screenshot",
  "generate_image",
  "send_message",
  "followup_task",
  "wait_agent",
  "list_agents",
  "interrupt_agent",
];

const DEFERRED_SET: ReadonlySet<string> = new Set(DEFERRED_TOOL_NAMES);

export interface ToolTierPartition {
  /** Tools whose full schema stays in every request. */
  core: AgentTool[];
  /** Tools held in the deferred catalog until `tool_search` promotes them. */
  deferred: AgentTool[];
}

/**
 * Split a freshly built toolset into its two tiers, preserving input order
 * within each tier. An unrecognised name (a future built-in, an MCP tool that
 * reached this path) defaults to `core`: shipping one extra schema is a token
 * cost, whereas silently hiding an unknown capability is a behaviour loss.
 */
export function partitionToolsByTier(tools: readonly AgentTool[]): ToolTierPartition {
  const core: AgentTool[] = [];
  const deferred: AgentTool[] = [];
  for (const tool of tools) {
    if (DEFERRED_SET.has(tool.name)) deferred.push(tool);
    else core.push(tool);
  }
  return { core, deferred };
}
