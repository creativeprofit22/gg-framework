import { describe, expect, it, vi } from "vitest";
import type { SubAgentManager } from "../core/subagent-manager.js";
import { createSubAgentControlTools } from "./subagent-control.js";

function fakeManager(): SubAgentManager {
  return {
    spawn: vi.fn(async (taskName: string) => ({
      agent_id: "12345678",
      task_name: taskName,
      state: "running",
    })),
    sendMessage: vi.fn(async () => 1),
    followup: vi.fn(async () => ({ agent_id: "12345678", state: "running" })),
    wait: vi.fn(async () => ({ timed_out: false, agents: [] })),
    list: vi.fn(() => []),
    interrupt: vi.fn(async () => ({ agent_id: "12345678", state: "interrupted" })),
  } as unknown as SubAgentManager;
}

const context = { signal: new AbortController().signal, toolCallId: "test" };

describe("async subagent control tools", () => {
  it("registers the six concise control surfaces", () => {
    expect(createSubAgentControlTools(fakeManager()).map((tool) => tool.name)).toEqual([
      "spawn_agent",
      "send_message",
      "followup_task",
      "wait_agent",
      "list_agents",
      "interrupt_agent",
    ]);
  });

  it("launches through the manager and blocks mutating lifecycle calls in plan mode", async () => {
    const manager = fakeManager();
    const planModeRef = { current: false };
    const tools = createSubAgentControlTools(manager, planModeRef);
    const spawn = tools.find((tool) => tool.name === "spawn_agent")!;
    await expect(
      spawn.execute({ task_name: "scan", task: "inspect" }, context),
    ).resolves.toMatchObject({ content: expect.stringContaining("12345678") });
    expect(manager.spawn).toHaveBeenCalledWith("scan", "inspect", undefined);

    planModeRef.current = true;
    await expect(
      spawn.execute({ task_name: "blocked", task: "write" }, context),
    ).resolves.toContain("plan mode");
  });
});
