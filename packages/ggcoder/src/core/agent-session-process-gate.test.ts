import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "@kenkaiiii/gg-ai";
import { AgentSession } from "./agent-session.js";
import { ProcessManager } from "./process-manager.js";

interface GateInternals {
  processManager?: ProcessManager;
  runStartedAt: number;
  processGateInjected: number;
  subAgentManager?: { completionGateMessage(): string | undefined };
  getHookFollowUpMessages(): Message[] | null;
}

function makeSession(): { session: AgentSession; internal: GateInternals } {
  const session = new AgentSession({
    provider: "anthropic",
    model: "claude-sonnet-5",
    cwd: "/project",
    transient: true,
    systemPrompt: "test",
    // Isolate the process gate from the Ideal review phase.
    selfCorrectionHooks: false,
  });
  return { session, internal: session as unknown as GateInternals };
}

const managers: ProcessManager[] = [];

function trackedManager(): ProcessManager {
  const manager = new ProcessManager();
  managers.push(manager);
  return manager;
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdownAll();
});

/** Poll until the process log has content, so the read is meaningful. */
async function waitForOutput(manager: ProcessManager, id: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const result = await manager.readOutput(id);
    if (result.output.trim()) return result.output;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return "";
}

describe("AgentSession background-process completion gate", () => {
  it("injects once for an unread in-run process, then completes after it is read", async () => {
    const { internal } = makeSession();
    const manager = trackedManager();
    internal.processManager = manager;
    internal.runStartedAt = Date.now();

    const started = await manager.start("echo gate-probe; sleep 30", process.cwd());

    const first = internal.getHookFollowUpMessages();
    expect(first?.[0]?.role).toBe("user");
    expect(first?.[0]?.content).toContain(started.id);
    expect(internal.processGateInjected).toBe(1);

    // The agent does what the gate asked: reads the output.
    expect(await waitForOutput(manager, started.id)).toContain("gate-probe");

    expect(internal.getHookFollowUpMessages()).toBeNull();
    expect(internal.processGateInjected).toBe(1);
  });

  it("never gates a process that predates the run", async () => {
    const { internal } = makeSession();
    const manager = trackedManager();
    internal.processManager = manager;

    await manager.start("sleep 30", process.cwd());
    // Run started after the process — a deliberately long-lived dev server.
    internal.runStartedAt = Date.now() + 1_000;

    expect(internal.getHookFollowUpMessages()).toBeNull();
    expect(internal.processGateInjected).toBe(0);
  });

  it("stops gating after the per-run injection cap so a turn can never wedge", async () => {
    const { internal } = makeSession();
    const manager = trackedManager();
    internal.processManager = manager;
    internal.runStartedAt = Date.now();

    await manager.start("sleep 30", process.cwd());

    expect(internal.getHookFollowUpMessages()).not.toBeNull();
    expect(internal.getHookFollowUpMessages()).not.toBeNull();
    expect(internal.getHookFollowUpMessages()).toBeNull();
    expect(internal.processGateInjected).toBe(2);
  });

  it("yields to the child-agent gate first", async () => {
    const { internal } = makeSession();
    const manager = trackedManager();
    internal.processManager = manager;
    internal.runStartedAt = Date.now();
    internal.subAgentManager = {
      completionGateMessage: () => "Collect child agent recovered-child before finishing.",
    };

    await manager.start("sleep 30", process.cwd());

    expect(internal.getHookFollowUpMessages()).toEqual([
      {
        role: "user",
        content: "Collect child agent recovered-child before finishing.",
        provenance: { source: "runtime", kind: "completion_gate", visibility: "hidden" },
      },
    ]);
    expect(internal.processGateInjected).toBe(0);
  });
});
