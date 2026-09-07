import { describe, expect, it, vi } from "vitest";
import { AppSidecarRoadmapReconciliationCoordinator } from "./app-sidecar-roadmap-reconciliation.js";
import {
  APP_SIDECAR_KEN_ALLOWED_TOOL_NAMES,
  AppSidecarRoadmapToolHost,
  type AppSidecarRoadmapToolSession,
} from "./app-sidecar-roadmap-tool-host.js";
import { RoadmapCheckpointParams } from "./tools/roadmap-checkpoint.js";
import { RoadmapStatusParams } from "./tools/roadmap-status.js";

const sessionLink = { sessionId: "phase-session", sessionPath: "/sessions/phase.jsonl" };
function owningSession(): AppSidecarRoadmapToolSession {
  return {
    getActivePhaseContext: () => ({
      version: 1,
      projectKey: "/project",
      phase: {
        id: "phase-1",
        title: "Direct completion",
        goal: "Complete without a reviewer",
        doneWhen: ["Tests pass"],
        sourcePrompt: "Implement it",
        status: "in-progress",
        archivedAt: null,
      },
      session: sessionLink,
      references: [],
      executionStage: "implementing",
    }),
    getMessages: () => [],
    getState: () => sessionLink,
  };
}

function doneInput(evidence = "pnpm test exited successfully", expectedRevision = 4) {
  return RoadmapStatusParams.parse({
    update_id: "completion-intent-1",
    phase_id: "phase-1",
    expected_revision: expectedRevision,
    transition: "done",
    progress: "Implementation and verification completed",
    evidence: [evidence],
    verification: { result: "passed" },
  });
}

describe("AppSidecarRoadmapToolHost", () => {
  it("never gives Ken or Autopilot Ken a Roadmap mutation tool", () => {
    const host = new AppSidecarRoadmapToolHost({
      cwd: "/project",
      repository: { recordRoadmapStatusUpdate: vi.fn() },
      durableExecution: false,
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => false },
      resolvePlanProgress: () => null,
      broadcastNotesSnapshot: vi.fn(),
    });

    expect(host.createSessionTools("ken")).toEqual([]);
    expect(host.createSessionTools("ken-autopilot")).toEqual([]);
    expect(APP_SIDECAR_KEN_ALLOWED_TOOL_NAMES).not.toContain("roadmap_status");
    expect(APP_SIDECAR_KEN_ALLOWED_TOOL_NAMES).not.toContain("roadmap_checkpoint");
  });

  it("fences a structured checkpoint before capturing its plan-bound workspace", async () => {
    const workspace = {
      version: 1 as const,
      repository: {
        projectKey: "/project",
        identityHash: "1".repeat(64),
        rootCommit: "2".repeat(40),
      },
      headCommit: "3".repeat(40),
      worktreeDigest: "4".repeat(64),
      clean: false,
    };
    const order: string[] = [];
    const checkpointPhaseExecutionStep = vi.fn(async () => {
      order.push("persist");
      return {
        status: "committed" as const,
        snapshot: { revision: 5 } as never,
        phase: {} as never,
      };
    });
    const broadcastNotesSnapshot = vi.fn();
    const host = new AppSidecarRoadmapToolHost({
      cwd: "/project",
      repository: { recordRoadmapStatusUpdate: vi.fn(), checkpointPhaseExecutionStep },
      durableExecution: true,
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => false },
      resolvePlanProgress: () => null,
      captureWorkspaceSnapshot: async () => {
        order.push("capture");
        return workspace;
      },
      mutateWithLeaseFence: async (operation) => {
        order.push("fence-enter");
        const value = await operation();
        order.push("fence-exit");
        return { status: "executed" as const, value };
      },
      broadcastNotesSnapshot,
      now: () => "2026-08-31T10:00:00.000Z",
    });
    const tool = host
      .createSessionTools("coding", owningSession)
      .find((candidate) => candidate.name === "roadmap_checkpoint")!;
    const input = RoadmapCheckpointParams.parse({
      phase_id: "phase-1",
      plan_hash: "5".repeat(64),
      step_id: "6".repeat(64),
      expected_revision: 4,
    });

    expect(JSON.parse(String(await tool.execute(input, {} as never)))).toEqual({
      result: "committed",
      phaseId: "phase-1",
      stepId: "6".repeat(64),
      revision: 5,
    });
    expect(order).toEqual(["fence-enter", "capture", "persist", "fence-exit"]);
    expect(checkpointPhaseExecutionStep).toHaveBeenCalledWith("/project", {
      phaseId: "phase-1",
      expectedRevision: 4,
      planHash: "5".repeat(64),
      stepId: "6".repeat(64),
      completedAt: "2026-08-31T10:00:00.000Z",
      workspace,
    });
    expect(broadcastNotesSnapshot).toHaveBeenCalledWith({ revision: 5 });
  });

  it("rejects a structured checkpoint before workspace capture after lease loss", async () => {
    const checkpointPhaseExecutionStep = vi.fn();
    const captureWorkspaceSnapshot = vi.fn();
    const host = new AppSidecarRoadmapToolHost({
      cwd: "/project",
      repository: { recordRoadmapStatusUpdate: vi.fn(), checkpointPhaseExecutionStep },
      durableExecution: true,
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => false },
      resolvePlanProgress: () => null,
      captureWorkspaceSnapshot,
      mutateWithLeaseFence: async () => ({ status: "phase-lease-lost" as const }),
      broadcastNotesSnapshot: vi.fn(),
    });
    const tool = host
      .createSessionTools("coding", owningSession)
      .find((candidate) => candidate.name === "roadmap_checkpoint")!;
    const input = RoadmapCheckpointParams.parse({
      phase_id: "phase-1",
      plan_hash: "5".repeat(64),
      step_id: "6".repeat(64),
      expected_revision: 4,
    });

    expect(JSON.parse(String(await tool.execute(input, {} as never)))).toMatchObject({
      result: "phase-lease-lost",
      phaseId: "phase-1",
      revision: 4,
    });
    expect(captureWorkspaceSnapshot).not.toHaveBeenCalled();
    expect(checkpointPhaseExecutionStep).not.toHaveBeenCalled();
  });

  it("forwards a fresh-session report through a fence without ledger or plan requirements", async () => {
    const recordRoadmapStatusUpdate = vi.fn(async () => ({
      status: "stale-revision" as const,
      revision: 5,
    }));
    const host = new AppSidecarRoadmapToolHost({
      cwd: "/project",
      durableExecution: true,
      repository: { recordRoadmapStatusUpdate },
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => false },
      resolvePlanProgress: () => {
        throw new Error("Progress is not completion authority");
      },
      broadcastNotesSnapshot: vi.fn(),
      mutateStatusWithLeaseFence: async (_phaseId, operation) => ({
        status: "executed",
        value: await operation(),
      }),
    });
    const fresh = {
      getActivePhaseContext: () => undefined,
      getMessages: () => [],
      getState: () => sessionLink,
    };
    const output = await host
      .createSessionTools("coding", () => fresh)[0]!
      .execute(doneInput(), {} as never);
    expect(JSON.parse(String(output))).toMatchObject({ result: "stale-revision", revision: 5 });
    expect(recordRoadmapStatusUpdate).toHaveBeenCalledWith(
      "/project",
      expect.objectContaining({
        phaseId: "phase-1",
        expectedRevision: 4,
        requireBoundPhase: false,
        evidence: ["pnpm test exited successfully"],
      }),
    );
  });

  it("rejects status writes when a different runner owns the mutation fence", async () => {
    const recordRoadmapStatusUpdate = vi.fn();
    const host = new AppSidecarRoadmapToolHost({
      cwd: "/project",
      durableExecution: true,
      repository: { recordRoadmapStatusUpdate },
      reconciliations: new AppSidecarRoadmapReconciliationCoordinator(),
      projectAutopilot: { isEnabled: () => false },
      resolvePlanProgress: () => null,
      broadcastNotesSnapshot: vi.fn(),
      mutateStatusWithLeaseFence: async () => ({ status: "phase-lease-lost" }),
    });
    const output = await host
      .createSessionTools("coding", owningSession)[0]!
      .execute(doneInput(), {} as never);
    expect(JSON.parse(String(output))).toMatchObject({ result: "phase-lease-lost" });
    expect(recordRoadmapStatusUpdate).not.toHaveBeenCalled();
  });
});
