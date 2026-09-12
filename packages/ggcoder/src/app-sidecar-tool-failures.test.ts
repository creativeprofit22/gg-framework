import { describe, expect, it } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import { collectPersistedMcpToolFailures } from "./app-sidecar-tool-failures.js";

describe("persisted MCP tool failures", () => {
  it("rehydrates sanitized explicit isError content and ignores successes", () => {
    const secret = "acceptance-secret-value";
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "failed-call",
            name: "mcp__acceptance__fixture_is_error",
            args: {},
          },
          {
            type: "tool_call",
            id: "successful-call",
            name: "mcp__acceptance__echo",
            args: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: "failed-call",
            content: `fixture-is-error: rejected ${secret}`,
            isError: true,
          },
          {
            type: "tool_result",
            toolCallId: "successful-call",
            content: "acceptance-ok",
          },
        ],
      },
    ];

    expect([...collectPersistedMcpToolFailures(messages, [secret]).values()]).toEqual([
      {
        toolCallId: "failed-call",
        name: "mcp__acceptance__fixture_is_error",
        result: "fixture-is-error: rejected [REDACTED]",
      },
    ]);
  });

  it("does not turn failed built-in tools into durable MCP rows", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "read-call", name: "read", args: {} }],
      },
      {
        role: "tool",
        content: [
          { type: "tool_result", toolCallId: "read-call", content: "missing", isError: true },
        ],
      },
    ];

    expect(collectPersistedMcpToolFailures(messages).size).toBe(0);
  });
});
