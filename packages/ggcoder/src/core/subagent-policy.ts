import type { Provider, ThinkingLevel } from "@kenkaiiii/gg-ai";

export const ASYNC_ORCHESTRATION_MARKER = "\n\n## Async subagent orchestration\n";

const ULTRA_ORCHESTRATION_PROMPT =
  `${ASYNC_ORCHESTRATION_MARKER}` +
  `Proactively use spawn_agent for substantial independent workstreams. Start every independent child before calling wait_agent, and continue useful parent work while children run. ` +
  `Use send_message to steer active work, followup_task to reuse an idle child's context, list_agents for status, interrupt_agent to stop a turn, and wait_agent to collect every required result before finalizing. ` +
  `Keep small, tightly coupled, or sequential work in the parent. Children share the same workspace: parallel writes must target clearly disjoint files or subsystems. Delegation never expands scope or bypasses approval boundaries.`;

const EXPLICIT_ORCHESTRATION_PROMPT =
  `${ASYNC_ORCHESTRATION_MARKER}` +
  `Use spawn_agent and the async agent controls only when the user or applicable project/skill instructions explicitly request delegation. Start independent children before waiting, avoid overlapping file edits, and collect required results before finalizing.`;

export function applyAsyncSubagentPolicy(
  prompt: string,
  provider: Provider,
  model: string,
  thinkingLevel: ThinkingLevel | undefined,
  toolNames: readonly string[],
): string {
  const markerIndex = prompt.indexOf(ASYNC_ORCHESTRATION_MARKER);
  const basePrompt = markerIndex === -1 ? prompt : prompt.slice(0, markerIndex);
  const supportsPolicy =
    toolNames.includes("spawn_agent") &&
    provider === "openai" &&
    (model === "gpt-5.6-sol" || model === "gpt-5.6-terra");
  if (!supportsPolicy) return basePrompt;
  return (
    basePrompt +
    (thinkingLevel === "ultra" ? ULTRA_ORCHESTRATION_PROMPT : EXPLICIT_ORCHESTRATION_PROMPT)
  );
}
