import type { Message } from "@kenkaiiii/gg-ai";
import { describe, expect, it, vi } from "vitest";
import { AppSidecarRoadmapReconciliationCoordinator } from "./app-sidecar-roadmap-reconciliation.js";
import { AppSidecarRoadmapToolHost } from "./app-sidecar-roadmap-tool-host.js";
import type { ActivePhaseContextV1 } from "./phase-context.js";
import { RoadmapStatusParams } from "./tools/roadmap-status.js";

const PHASE_ID = "e349b4c7-ca8c-43da-8d14-e21f21677249";
const SESSION = { sessionId: "phase-session", sessionPath: "/sessions/phase.jsonl" };

function activeContext(): ActivePhaseContextV1 {
  return {
    version: 1,
    projectKey: "evidence-boundary",
    phase: {
      id: PHASE_ID,
      title: "Evidence boundary",
      goal: "Require harness-owned verification",
      doneWhen: ["criterion one", "criterion two"],
      sourcePrompt: "Implement the evidence boundary.",
      status: "in-progress",
      archivedAt: null,
    },
    session: SESSION,
    references: [],
    executionStage: "implementing",
  };
}

function shellExchange(id: string, command: string): Message[] {
  return [
    { role: "assistant", content: [{ type: "tool_call", id, name: "bash", args: { command } }] },
    {
      role: "tool",
      content: [{ type: "tool_result", toolCallId: id, content: "Exit code: 0\nPASS" }],
    },
  ];
}

function codingSession(messages: Message[]) {
  return {
    getActivePhaseContext: () => activeContext(),
    getMessages: () => messages,
    getState: () => SESSION,
  };
}

function statusInput(evidence: string[]) {
  return RoadmapStatusParams.parse({
    update_id: "completion-intent-15",
    phase_id: PHASE_ID,
    expected_revision: 15,
    transition: "done",
    progress: "Verification submitted at revision 15.",
    evidence,
    verification: { result: "passed" },
  });
}

describe("Roadmap Done verification evidence boundary", () => {
  it("rejects shell commands that can mask a failing verification", async () => {
    const recordRoadmapStatusUpdate = vi.fn();
    const unsafe = [
      "vitest run criterion-1.test.ts || echo PASSED",
      "vitest run criterion-2.test.ts || echo PASSED",
    ];
    const host = new AppSidecarRoadmapToolHost({
      cwd: "C:/fixture",
      repository: { recordRoadmapStatusUpdate },
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => false },
      resolvePlanProgress: () => ({ total: 2, completed: [1, 2] }),
      broadcastNotesSnapshot: vi.fn(),
    });
    const output = await host
      .createSessionTools("coding", () =>
        codingSession(
          unsafe.flatMap((command, index) => shellExchange(`unsafe-${index}`, command)),
        ),
      )[0]!
      .execute(statusInput(unsafe), {} as never);

    expect(JSON.parse(String(output))).toMatchObject({
      result: "verification-incomplete",
      phaseId: PHASE_ID,
    });
    expect(recordRoadmapStatusUpdate).not.toHaveBeenCalled();
  });

  it("records intent only with distinct classifier-approved current commands", async () => {
    const commands = ["vitest run criterion-1.test.ts", "vitest run criterion-2.test.ts"];
    const recordRoadmapStatusUpdate = vi.fn(async () => ({
      status: "duplicate" as const,
      revision: 16,
      phaseId: PHASE_ID,
      phase: {} as never,
      statusOutcome: "completion-pending" as const,
      proposals: [],
    }));
    const host = new AppSidecarRoadmapToolHost({
      cwd: "C:/fixture",
      repository: { recordRoadmapStatusUpdate },
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => false },
      resolvePlanProgress: () => ({ total: 2, completed: [1, 2] }),
      broadcastNotesSnapshot: vi.fn(),
    });
    const output = await host
      .createSessionTools("coding", () =>
        codingSession(
          commands.flatMap((command, index) => shellExchange(`safe-${index}`, command)),
        ),
      )[0]!
      .execute(
        statusInput(commands.map((command, index) => `criterion ${index + 1}: ${command}`)),
        {} as never,
      );

    expect(JSON.parse(String(output))).toMatchObject({
      result: "duplicate",
      revision: 16,
      statusOutcome: "completion-pending",
      completionIntentId: "completion-intent-15",
    });
    expect(recordRoadmapStatusUpdate).toHaveBeenCalledOnce();
  });
});
