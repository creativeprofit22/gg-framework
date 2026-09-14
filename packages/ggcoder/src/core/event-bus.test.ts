import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@kenkaiiii/gg-agent";
import { EventBus } from "./event-bus.js";

describe("EventBus tool-call presentation identity", () => {
  it("forwards MCP display identity without replacing the provider alias", () => {
    const bus = new EventBus();
    const listener = vi.fn();
    bus.on("tool_call_start", listener);
    const event: AgentEvent = {
      type: "tool_call_start",
      toolCallId: "opaque-call",
      name: "mcp__id__opaquehash",
      args: { query: "needle" },
    };

    bus.forwardAgentEvent(event, {
      displayName: "server name / tool:name",
      mcpServerName: "server name",
      mcpToolName: "tool:name",
    });

    expect(listener).toHaveBeenCalledWith({
      toolCallId: "opaque-call",
      name: "mcp__id__opaquehash",
      args: { query: "needle" },
      displayName: "server name / tool:name",
      mcpServerName: "server name",
      mcpToolName: "tool:name",
    });
  });

  it("preserves sanitized explicit MCP failure content and isError", () => {
    const bus = new EventBus();
    const listener = vi.fn();
    bus.on("tool_call_end", listener);
    bus.forwardAgentEvent({
      type: "tool_call_end",
      toolCallId: "fixture-error-call",
      result: "fixture-is-error: rejected [REDACTED]",
      isError: true,
      durationMs: 12,
    });
    expect(listener).toHaveBeenCalledWith({
      toolCallId: "fixture-error-call",
      result: "fixture-is-error: rejected [REDACTED]",
      isError: true,
      durationMs: 12,
      invalidArgAttempt: undefined,
      details: undefined,
    });
  });

  it("does not add display fields to ordinary tool events", () => {
    const bus = new EventBus();
    const listener = vi.fn();
    bus.on("tool_call_start", listener);
    bus.forwardAgentEvent({
      type: "tool_call_start",
      toolCallId: "ordinary-call",
      name: "read",
      args: { file_path: "a.ts" },
    });
    expect(listener).toHaveBeenCalledWith({
      toolCallId: "ordinary-call",
      name: "read",
      args: { file_path: "a.ts" },
    });
  });
});

describe("EventBus.forwardAgentEvent", () => {
  it("carries invalidArgAttempt through to listeners", () => {
    const bus = new EventBus();
    const seen: (number | undefined)[] = [];
    bus.on("tool_call_end", (data) => seen.push(data.invalidArgAttempt));

    bus.forwardAgentEvent({
      type: "tool_call_end",
      toolCallId: "t1",
      result: "Invalid arguments for tool `edit`",
      isError: true,
      durationMs: 0,
      invalidArgAttempt: 2,
    });
    bus.forwardAgentEvent({
      type: "tool_call_end",
      toolCallId: "t2",
      result: "applied",
      isError: false,
      durationMs: 5,
    });

    expect(seen).toEqual([2, undefined]);
  });
});
