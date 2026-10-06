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
  // Core wherever it is registered at all (the app sidecar): a question the
  // model must `tool_search` for first is a question it writes in prose
  // instead. Hosts with nobody to answer never build it, so they pay nothing.
  "ask_user",
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
  "code_search",
  "code_nav",
  "web_fetch",
  "task_output",
  "task_send",
  "task_stop",
  "spawn_agent",
  "skill",
  "enter_plan",
  "exit_plan",
  "tool_search",
];

/**
 * Built-ins that live in the catalog as index lines until `tool_search` is
 * called. Each one is either rare (image generation, screenshots, the
 * debugger, package source resolution) or only reachable after another tool has already run
 * (the child-agent control cluster follows `spawn_agent`).
 *
 * `web_search` moved here after a 30-day usage count over 718 local sessions
 * found it in ~6% of working sessions. `steroids` (~8%; 8.6% across 723 Local Fork working sessions, 2026-10) and `subagent` (~15%; 5.5% locally)
 * followed after a 2026-10 count over 255 working sessions, and a GLM-5.3
 * head-to-head with Dirac (bench/h2h/DIRAC-FINDINGS.md) showed the always-on
 * prefix — ~5.4k chars for these two schemas — was GG's main per-request
 * overhead. `spawn_agent` (~22%) stays core. `task_send`
 * stays core even though it is rarer: bash's own description points at it,
 * and promoting it mid-session would change the tool list, which restarts
 * Anthropic's prompt cache (tools are cached ahead of system and messages).
 */
export const DEFERRED_TOOL_NAMES: readonly string[] = [
  "web_search",
  "steroids",
  "subagent",
  "ui_registry",
  "ui_adopt",
  "source_path",
  "tauri_package",
  "programmatic_profile",
  "programmatic_scan",
  "programmatic_command",
  "command_information",
  "research_corpus",
  "screenshot",
  "debug",
  "generate_image",
  "tasks",
  "checklist",
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
