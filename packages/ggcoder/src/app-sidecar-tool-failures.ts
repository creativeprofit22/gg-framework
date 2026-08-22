import { redactValue, type Message, type ToolResultContent } from "@kenkaiiii/gg-ai";

export interface PersistedMcpToolFailure {
  toolCallId: string;
  name: string;
  result: string;
}

function toolResultText(content: ToolResultContent): string {
  if (typeof content === "string") return content;
  return content
    .filter(
      (block): block is Extract<(typeof content)[number], { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("\n");
}

/**
 * Recover failed MCP results from persisted provider messages. Tool output is
 * redacted again at this boundary because session files are untrusted input.
 */
export function collectPersistedMcpToolFailures(
  messages: readonly Message[],
  secrets: readonly string[] = [],
): Map<string, PersistedMcpToolFailure> {
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.type === "tool_call" && block.name.startsWith("mcp__")) {
        toolNames.set(block.id, block.name);
      }
    }
  }

  const failures = new Map<string, PersistedMcpToolFailure>();
  for (const message of messages) {
    if (message.role !== "tool") continue;
    for (const result of message.content) {
      const name = toolNames.get(result.toolCallId);
      if (!name || result.isError !== true) continue;
      const sanitized = redactValue(result.content, { secrets });
      failures.set(result.toolCallId, {
        toolCallId: result.toolCallId,
        name,
        result: toolResultText(sanitized).trim() || "MCP tool reported a failure.",
      });
    }
  }
  return failures;
}
